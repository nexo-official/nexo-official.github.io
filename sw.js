/**
 * Service Worker – Nexo läuft KOMPLETT offline.
 *
 * Installieren: lädt die Liste `precache.json` (beim Build erzeugt, siehe
 * scripts/precache.mjs) und legt ALLE Seiten, Programm-Dateien, Schriften,
 * Bilder und Klänge in einen Speicher, der nach dem Build benannt ist.
 *
 * Abrufen:
 *  - Seiten: erst das Netz (frischester Stand), aber höchstens 4 s warten –
 *    sonst/ohne Netz sofort die gespeicherte Seite. So startet Nexo auch im
 *    wackligen Schul-WLAN zügig.
 *  - Dateien (/_next/static, Bilder, Audio …): aus dem Speicher, sonst Netz
 *    (und dann merken). Gebaute Dateien haben eindeutige Namen → nie veraltet.
 *  - Next-Daten für weiche Seitenwechsel (RSC): erst das Netz (max. 4 s), sonst
 *    die gespeicherte Fassung der Seite. Beim Installieren wird für JEDE Seite
 *    die vollständige Fassung mitgespeichert (im Speicher des Builds – nach
 *    einem Update nie veraltet). So wechseln die Menüs auch offline weich, mit
 *    Animation, und Laufendes (Musik, Timer) bleibt an. Vorab-Abrufe
 *    (Prefetch) werden nie aus dem Speicher bedient – nur echte Seitenwechsel.
 *    Klappt etwas nicht, lädt Next die Seite „hart" – die kommt ebenfalls aus
 *    dem Speicher.
 *  - Hintergrundmusik (`media` in precache.json, ~16 MB): NICHT beim
 *    Installieren (das bliebe sonst lange hängen), sondern danach im
 *    Hintergrund nachgeladen – nur im WLAN, nie über mobile Daten. Abgespielt aus dem Speicher – auch Teil-Anfragen
 *    (Range, beim Spulen/Streamen) werden aus der gespeicherten Datei beantwortet.
 *  - Fremde Adressen (Wetter, Ferien, Übersetzer, Feedback) laufen unberührt
 *    ans Netz – die brauchen Internet.
 *
 * Neue Version: Die App registriert `sw.js?v=<Build>`; ein neuer Build
 * installiert sich daneben, übernimmt (die App läuft dann ja schon auf dem
 * neuen Stand) und räumt den alten Speicher weg.
 */
const META = "nexo-meta";
const PAGE_TIMEOUT = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch("/precache.json", { cache: "no-store" });
      const { version, urls, media = [], pages = [] } = await res.json();
      const cache = await caches.open(`nexo-${version}`);
      // In kleinen Häppchen; eine fehlende Datei darf nicht alles abbrechen.
      for (let i = 0; i < urls.length; i += 8) {
        await Promise.all(
          urls.slice(i, i + 8).map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})),
        );
      }
      // Daten für weiche Seitenwechsel (vollständige RSC-Fassung jeder Seite)
      await Promise.all(
        pages.map((p) =>
          fetch(p, { headers: { RSC: "1" }, cache: "reload" })
            .then((r) => (r.ok ? cache.put(rscKey(p), r) : null))
            .catch(() => {}),
        ),
      );
      const meta = await caches.open(META);
      await meta.put("/__next-version", new Response(version));
      await meta.put("/__media", new Response(JSON.stringify(media)));
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const meta = await caches.open(META);
      const pending = await meta.match("/__next-version");
      if (pending) {
        const current = `nexo-${await pending.text()}`;
        await meta.put("/__current", new Response(current));
        await meta.delete("/__next-version");
      }
      const keep = await currentCache();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== META && k !== keep && k !== MEDIA).map((k) => caches.delete(k)));
      await self.clients.claim();
      // Songs im Hintergrund nachladen (blockiert nichts)
      loadMedia();
    })(),
  );
});

/*
 * Songs liegen in einem EIGENEN Speicher, der neue Versionen überlebt (die
 * Dateien ändern sich praktisch nie) – nicht bei jedem Update 16 MB neu laden.
 * Was nicht mehr in der Liste steht, wird entfernt.
 */
const MEDIA = "nexo-media";
let mediaLoading = null;
/**
 * Mobile Daten oder „Datensparen": die 16 MB Songs dann NICHT im Hintergrund
 * laden – erst wieder im WLAN. Abspielen geht trotzdem (dann direkt übers Netz).
 */
const metered = () => {
  const c = self.navigator.connection;
  return !!c && (c.saveData === true || c.type === "cellular" || /2g|3g/.test(c.effectiveType || ""));
};
function loadMedia() {
  if (metered()) return Promise.resolve();
  if (mediaLoading) return mediaLoading;
  mediaLoading = (async () => {
    try {
      const meta = await caches.open(META);
      const r = await meta.match("/__media");
      const list = r ? await r.json() : [];
      const cache = await caches.open(MEDIA);
      for (const req of await cache.keys()) if (!list.includes(new URL(req.url).pathname)) await cache.delete(req);
      for (const u of list) {
        if (await cache.match(u)) continue;
        const res = await fetch(u, { cache: "reload" }).catch(() => null);
        if (res && res.ok && res.status === 200) await cache.put(u, res);
      }
    } finally {
      mediaLoading = null;
    }
  })();
  return mediaLoading;
}

/** Musik aus dem Speicher – mit Teil-Antworten (206) für Range-Anfragen. */
async function media(req) {
  const path = new URL(req.url).pathname;
  const hit = await caches.open(MEDIA).then((c) => c.match(path));
  if (!hit) {
    // Noch nicht geladen: Netz, und das Nachladen anstoßen
    loadMedia();
    return fetch(req);
  }
  return sliced(hit, req.headers.get("range"));
}

/** Teil-Anfrage auf eine gespeicherte Datei (Hauptspeicher oder Songs), sonst Netz. */
async function rangeFromCache(req) {
  const hit = (await caches.match(req, { ignoreSearch: true })) || undefined;
  return hit ? sliced(hit, req.headers.get("range")) : fetch(req);
}

/** Antwort auf eine Range-Anfrage aus einer vollständigen gespeicherten Antwort (206). */
async function sliced(hit, range) {
  if (!range) return hit;
  const buf = await hit.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = buf.byteLength;
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": hit.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function currentCache() {
  const meta = await caches.open(META);
  const r = await meta.match("/__current");
  return r ? r.text() : null;
}

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname === "/manifest.webmanifest" ||
  /\.(png|jpe?g|webp|svg|gif|ico|mp3|ogg|wav|woff2?|ttf|css|js)$/i.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Wetter, Übersetzer … → Netz
  if (req.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) {
    event.respondWith(rsc(req));
    return;
  }
  if (url.pathname === "/sw.js" || url.pathname === "/precache.json" || url.pathname === "/version.json") return;
  // Hintergrundmusik: aus dem eigenen Speicher (mit Teil-Antworten fürs Streamen)
  if (url.pathname.startsWith("/audio/music/bg-")) {
    event.respondWith(media(req));
    return;
  }
  // Teil-Anfragen auf gespeicherte Dateien (z. B. Klänge über <audio>) aus dem Speicher
  if (req.headers.has("range")) {
    if (isStatic(url)) event.respondWith(rangeFromCache(req));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(page(req));
    // Fehlende Songs weiterladen, solange die App offen ist (hält den Worker wach)
    event.waitUntil(loadMedia().catch(() => {}));
    return;
  }
  if (isStatic(url)) event.respondWith(file(req));
});

const rscKey = (path) => `/__rsc${path}`;
const isPrefetch = (req) => !!(req.headers.get("Next-Router-Prefetch") || req.headers.get("Next-Router-Segment-Prefetch"));

/** Next-Daten (weicher Seitenwechsel): Netz (max. 4 s), sonst gespeicherte Fassung. */
async function rsc(req) {
  const path = new URL(req.url).pathname;
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PAGE_TIMEOUT)),
    ]);
    return res;
  } catch {
    if (isPrefetch(req)) return Response.error(); // Vorab-Abruf: einfach auslassen
    const name = await currentCache();
    const hit = name ? await caches.open(name).then((c) => c.match(rscKey(path))) : undefined;
    // Website (statischer Export): Seitenwechsel-Daten sind gewöhnliche .txt-Dateien,
    // die schon in der Offline-Liste stehen – ohne ?_rsc=… aus dem Speicher.
    const file = hit ? undefined : await caches.match(req, { ignoreSearch: true });
    return hit || file || Response.error();
  }
}

/** Seite: Netz (max. 4 s), sonst Speicher. Frische Seiten werden gemerkt. */
async function page(req) {
  const cached = () =>
    caches.match(req, { ignoreSearch: true }).then((c) => c || caches.match("/", { ignoreSearch: true }));
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PAGE_TIMEOUT)),
    ]);
    if (res.ok) {
      const name = await currentCache();
      if (name) {
        const copy = res.clone();
        caches.open(name).then((c) => c.put(new URL(req.url).pathname, copy));
      }
    }
    return res;
  } catch {
    return (await cached()) || Response.error();
  }
}

/** Datei: Speicher zuerst, sonst Netz (und merken). */
async function file(req) {
  const hit = (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true }));
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const name = await currentCache();
    if (name) {
      const copy = res.clone();
      caches.open(name).then((c) => c.put(req, copy));
    }
  }
  return res;
}
