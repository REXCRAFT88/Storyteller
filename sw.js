/* Storyteller service worker (Phase 4.2) — precaches the app shell so it boots
 * offline. Bump CACHE_VERSION whenever a shell asset changes. Cross-origin
 * requests (Syrinscape/YouTube/Spotify/Vosk models) are left to the network. */
const CACHE_VERSION = 'storyteller-shell-v1';

const SHELL = [
    './',
    'index.html',
    'css/main.css',
    'js/app.js',
    'manifest.webmanifest',
    'icon.svg',
    'brick_wall.png',
    'torch.apng',
    'vendor/tailwind.css',
    'vendor/fuse/fuse.min.js',
    'vendor/fontawesome/css/all.min.css',
    'vendor/fontawesome/webfonts/fa-solid-900.woff2',
    'vendor/fontawesome/webfonts/fa-regular-400.woff2',
    'vendor/fontawesome/webfonts/fa-brands-400.woff2',
    'vendor/fonts/fonts.css',
    'vendor/fonts/cinzel-latin-400-normal.woff2',
    'vendor/fonts/cinzel-latin-700-normal.woff2',
    'vendor/fonts/inter-latin-400-normal.woff2',
    'vendor/fonts/inter-latin-600-normal.woff2',
    'vendor/fonts/inter-latin-700-normal.woff2'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
            .catch((e) => console.warn('SW precache failed (some assets skipped):', e))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Only handle our own origin; let external integrations hit the network.
    if (url.origin !== self.location.origin) return;

    // Navigation requests fall back to the cached shell when offline.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
        );
        return;
    }

    // Cache-first for same-origin assets; populate the cache on first network hit.
    event.respondWith(
        caches.match(req).then((cached) => cached || fetch(req).then((res) => {
            if (res && res.ok && res.type === 'basic') {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => { });
            }
            return res;
        }).catch(() => cached))
    );
});
