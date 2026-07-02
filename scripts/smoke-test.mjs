#!/usr/bin/env node
/**
 * Headless smoke test for the manual checklist in docs/TESTING.md.
 * Boots index.html in Chromium with a fake microphone, exercises core UI, and
 * fails on any uncaught page error or on a runaway speech-recognition restart
 * loop (ANALYSIS.md B1).
 *
 * Requires: `npm i -D playwright` and a Chromium binary. In this environment the
 * pre-installed browser lives at /opt/pw-browsers/chromium.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }));

await page.goto('file://' + resolve(root, 'index.html'), { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);

const fail = [];
const probes = await page.evaluate(() => ({
  buttons: document.querySelectorAll('button').length,
  modals: document.querySelectorAll('.modal, [id*="Modal"]').length,
  status: document.getElementById('status')?.textContent,
}));
if (probes.buttons < 50) fail.push(`Too few buttons rendered (${probes.buttons})`);

// UI smoke: open + close settings
await page.click('#openSettingsModalButton', { timeout: 3000 }).catch((e) => fail.push('open settings: ' + e.message));
await page.waitForTimeout(400);
await page.click('#closeSettingsModalButton', { timeout: 3000 }).catch(() => {});

// B1 guard: click listen with no real mic, ensure restarts are bounded.
await page.click('#toggleListenButton', { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(6000);
const restarts = logs.filter((l) => /attempting restart|recognition\.start\(\) called/i.test(l.text)).length;
if (restarts > 20) fail.push(`Speech recognition restart loop unbounded (${restarts} restarts in ~6s)`);

const pageErrors = logs.filter((l) => l.type === 'pageerror');
for (const e of pageErrors) fail.push('PAGEERROR: ' + e.text);

await browser.close();

console.log('Probes:', JSON.stringify(probes));
console.log('Restart attempts in window:', restarts);
if (fail.length) {
  console.error('\n✗ Smoke test FAILED:');
  fail.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✓ Smoke test passed.');
