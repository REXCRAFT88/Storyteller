#!/usr/bin/env node
/**
 * Regression test for compound-phrasing with a shared Primary Key.
 *
 * The phrase
 *   "you pull back your bow and fire an arrow it flies through the air and hits an orc"
 * must trigger THREE pages in the Combat chapter of the sample book:
 *   - Bow Drawing   (PK "bow")
 *   - Arrow Whoosh  (PK "arrow")
 *   - Arrow Hits *  (PK "arrow" — shared with Arrow Whoosh)
 *
 * The bug this guards against: the multi-match loop used to consume the matched
 * Primary Key word ("arrow") after the first arrow page fired, which gated every
 * later same-PK page out of checkPrimaryKeyConfidence — so only two pages fired.
 * The fix consumes only regular (non-PK) keywords, leaving shared PKs available.
 *
 * Requires playwright + a Chromium binary (pre-installed at /opt/pw-browsers/chromium).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = resolve(root, 'index.html');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const COMBAT_CHAPTER_ID = 4; // "Combat" in storyteller-sample-book.json

// Build a temp book identical to the shipped sample but opened on the Combat chapter.
const sample = JSON.parse(readFileSync(resolve(root, 'storyteller-sample-book.json'), 'utf8'));
sample.activeChapterId = COMBAT_CHAPTER_ID;
const bookPath = join(tmpdir(), `storyteller-combat-${process.pid}.json`);
writeFileSync(bookPath, JSON.stringify(sample));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['microphone'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

let resultsText = '';
const fail = [];
try {
  await page.goto('file://' + APP, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Load the book via the real file-load flow, overwriting all detected parts.
  await page.setInputFiles('#loadFileInput', bookPath);
  await page.waitForSelector('#loadFileConfirmationModal', { state: 'visible', timeout: 5000 });
  await page.evaluate(() => {
    document.querySelectorAll('#loadFileConfirmationModal input[type="radio"][value="overwrite"]').forEach(r => { r.checked = true; });
  });
  await page.click('#confirmLoadButton');
  await page.waitForTimeout(2500);

  // Run the phrase through the matcher playground (real pipeline, dry-run).
  await page.evaluate(() => document.getElementById('openMatcherPlaygroundButton').click());
  await page.waitForSelector('#matcherPlaygroundModal', { state: 'visible', timeout: 5000 });
  const PHRASE = 'you pull back your bow and fire an arrow it flies through the air and hits an orc';
  await page.evaluate((phrase) => {
    const i = document.getElementById('matcherPlaygroundInput');
    i.value = phrase; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('matcherPlaygroundRunButton').click();
  }, PHRASE);
  await page.waitForTimeout(1500);
  resultsText = await page.evaluate(() => document.getElementById('matcherPlaygroundResults')?.innerText || '');
} catch (e) {
  fail.push('Harness error: ' + e.message);
} finally {
  await browser.close();
  try { unlinkSync(bookPath); } catch { /* ignore */ }
}

const pageErrors = logs.filter(l => l.startsWith('PAGEERROR:'));
pageErrors.forEach(e => fail.push(e));

console.log('--- Playground results ---\n' + resultsText + '\n--------------------------');
const lc = resultsText.toLowerCase();
if (!lc.includes('bow drawing')) fail.push('Missing "Bow Drawing"');
if (!lc.includes('arrow whoosh')) fail.push('Missing "Arrow Whoosh"');
if (!lc.includes('arrow hits')) fail.push('Missing an "Arrow Hits" page (shared PK "arrow")');

if (fail.length) {
  console.error('\n✗ Compound-phrasing test FAILED:');
  fail.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✓ Compound-phrasing test passed: all three pages triggered from one utterance.');
