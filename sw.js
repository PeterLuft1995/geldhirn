/*
 * Geldhirn – Service Worker
 * Ziel: Seite als installierbare PWA nutzbar machen, App-Shell (CSS/JS/Icons)
 * für schnelle Ladezeiten cachen, HTML-Seiten offline verfügbar machen sobald
 * sie einmal besucht wurden. Keine Interaktion mit Supabase/Stripe – externe
 * Requests werden nie gecacht oder abgefangen.
 */

const CACHE_VERSION = "geldhirn-v1";
const APP_SHELL = [
  "/index.html",
  "/styles.css",
  "/app.js",
  "/config.js",
  "/manifest.json",
  "/offline.html",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/assets/icons/favicon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      /* Falls einzelne Assets beim Erstinstall nicht erreichbar sind, soll die
         Installation trotzdem nicht komplett fehlschlagen. */
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Nur eigene GET-Requests behandeln, alles andere (Supabase, Stripe, Google
  // Fonts o.ä., POST/PUT) unverändert ans Netz durchreichen.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // HTML-Seitenaufrufe: zuerst Netz versuchen (immer aktuellster Inhalt),
  // bei Fehlschlag zuletzt gecachte Version, sonst Offline-Seite.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/offline.html"))
        )
    );
    return;
  }

  // Statische Assets (CSS/JS/Bilder/Icons): erst Cache, dann Netz, Cache im
  // Hintergrund auffrischen.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
