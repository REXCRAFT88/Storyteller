/**
 * Tailwind config for the vendored, build-time CSS (Phase 4.1).
 * The app ships a precompiled vendor/tailwind.css instead of the CDN runtime.
 * Rebuild with: npm run build:vendor  (see scripts/build-vendor.mjs)
 */
module.exports = {
    content: ['./index.html', './js/app.js'],
    theme: { extend: {} },
    plugins: [],
};
