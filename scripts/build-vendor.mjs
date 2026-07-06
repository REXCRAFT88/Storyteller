#!/usr/bin/env node
/**
 * Regenerates the locally vendored front-end dependencies under /vendor/ so the
 * app boots fully styled and searchable with no CDN (Phase 4.1).
 *
 * Run:  node scripts/build-vendor.mjs
 * Requires dev deps (install once, they need only registry.npmjs.org):
 *   npm i -D tailwindcss@3 fuse.js@6.6.2 @fortawesome/fontawesome-free@6.5.2 \
 *            @fontsource/cinzel @fontsource/inter
 *
 * What it produces:
 *   vendor/tailwind.css              compiled utilities (scans index.html + js/app.js)
 *   vendor/fuse/fuse.min.js          UMD build that sets window.Fuse
 *   vendor/fontawesome/css + webfonts (woff2 only)
 *   vendor/fonts/*.woff2 + fonts.css  Cinzel/Inter latin @font-face
 *
 * Fuse is pinned to 6.6.2 because 7.x dropped the UMD global build the app uses.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const v = (p) => join(root, 'vendor', p);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

for (const d of ['fuse', 'fontawesome/css', 'fontawesome/webfonts', 'fonts']) mkdirSync(v(d), { recursive: true });

console.log('• Compiling Tailwind (scanning index.html + js/app.js)…');
run('npx tailwindcss -c tailwind.config.cjs -i scripts/tailwind.input.css -o vendor/tailwind.css --minify');

console.log('• Copying Fuse (UMD global)…');
copyFileSync(join(nm, 'fuse.js/dist/fuse.min.js'), v('fuse/fuse.min.js'));

console.log('• Copying Font Awesome (woff2 only)…');
copyFileSync(join(nm, '@fortawesome/fontawesome-free/css/all.min.css'), v('fontawesome/css/all.min.css'));
for (const f of ['fa-solid-900', 'fa-regular-400', 'fa-brands-400', 'fa-v4compatibility'])
    copyFileSync(join(nm, `@fortawesome/fontawesome-free/webfonts/${f}.woff2`), v(`fontawesome/webfonts/${f}.woff2`));

console.log('• Copying Cinzel + Inter (latin woff2)…');
copyFileSync(join(nm, '@fontsource/cinzel/files/cinzel-latin-400-normal.woff2'), v('fonts/cinzel-latin-400-normal.woff2'));
copyFileSync(join(nm, '@fontsource/cinzel/files/cinzel-latin-700-normal.woff2'), v('fonts/cinzel-latin-700-normal.woff2'));
for (const w of ['400', '600', '700'])
    copyFileSync(join(nm, `@fontsource/inter/files/inter-latin-${w}-normal.woff2`), v(`fonts/inter-latin-${w}-normal.woff2`));

console.log('✓ Vendored assets rebuilt. (vendor/fonts/fonts.css is committed and not regenerated.)');
