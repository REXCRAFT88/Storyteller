/* Storyteller service worker (Phase 4.2, hardened) — NETWORK-FIRST.
 *
 * Always serves the freshest version when online (so a new deploy takes effect
 * on the next load and the site can never get stuck on a stale/broken cached
 * copy), falling back to the cache only when the network is unavailable.
 * Bump CACHE_VERSION whenever the shell changes; old caches are purged on
 * activate. Cross-origin requests (Syrinscape/YouTube/Spotify/Vosk) are left
 * entirely to the network. */
const CACHE_VERSION = 'storyteller-shell-v2';

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
    // Warm the cache for offline use, but never let a failed precache block
    // installation — the network-first fetch handler works without it.
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Allow the page to tell a waiting SW to activate immediately (future use).
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    // Only handle our own origin; external integrations always hit the network.
    if (url.origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            // Network first: the freshest response wins and refreshes the cache.
            const fresh = await fetch(req);
            if (fresh && fresh.ok && fresh.type === 'basic') {
                const cache = await caches.open(CACHE_VERSION);
                cache.put(req, fresh.clone()).catch(() => { });
            }
            return fresh;
        } catch (e) {
            // Offline: fall back to the cache, then to the cached shell for navigations.
            const cached = await caches.match(req);
            if (cached) return cached;
            if (req.mode === 'navigate') {
                const shell = (await caches.match('index.html')) || (await caches.match('./'));
                if (shell) return shell;
            }
            throw e; // genuinely offline and uncached — let the browser handle it
        }
    })());
});
