#!/usr/bin/env node
/**
 * Zero-dependency static file server for running Storyteller locally over http.
 * The offline (Vosk) engine needs an http(s) origin — Web Workers and WASM do
 * not run from a file:// page — so use this instead of double-clicking the HTML
 * when you want offline speech.
 *
 *   npm run serve            # http://localhost:8000
 *   PORT=9000 npm run serve  # custom port
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.apng': 'image/apng', '.wasm': 'application/wasm',
  '.tar': 'application/x-tar', '.gz': 'application/gzip', '.tgz': 'application/gzip',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/') path = '/index.html';
    // Prevent path traversal outside ROOT.
    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404).end('Not found'); return; }
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end('Server error');
  }
}).listen(PORT, () => {
  console.log(`Storyteller is serving at http://localhost:${PORT}`);
  console.log('Open that URL in Chrome/Edge/Firefox. Press Ctrl+C to stop.');
});
