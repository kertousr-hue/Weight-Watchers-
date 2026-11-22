// Cache hors-ligne : l'application et le modèle de reconnaissance sont gardés
// sur le téléphone après le premier lancement.
const VERSION = "equilibre-v2";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "points.js", "foods.js", "store.js", "recognize.js",
  "config.js", "manifest.webmanifest", "icon.svg", "vendor/supabase.js", "vendor/tf.min.js", "vendor/mobilenet.min.js",
];
// Hôtes qui servent les fichiers du modèle MobileNet
const MODEL_HOSTS = ["tfhub.dev", "www.kaggle.com", "storage.googleapis.com", "kaggle.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "model").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Modèle : cache d'abord (il ne change pas)
  if (MODEL_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(
      caches.open("model").then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Fichiers de l'application : réseau d'abord, cache si hors-ligne
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
    );
  }
});
