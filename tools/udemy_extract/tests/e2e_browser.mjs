// Runs udemy_manifest.js and udemy_frames.js inside Chromium against mock_udemy.py and saves
// the downloads they trigger.  node e2e_browser.mjs <baseUrl> <outDir>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const [base, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const code = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8');

async function poll(page, expr, label, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(expr);
    if (!String(s).startsWith('running')) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(label + ' timed out: ' + s);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const saved = [];
page.on('download', async (d) => { const p = path.join(out, d.suggestedFilename()); await d.saveAs(p); saved.push(p); });

await page.goto(`${base}/course/test-trading-course/learn/lecture/1001`);
console.log('inject manifest:', await page.evaluate(code('udemy_manifest.js')));
console.log('list:', await page.evaluate(() => udmListCourses()));
console.log('start:', await page.evaluate(() => udmStart('https://www.udemy.com/course/test-trading-course/', { delayMs: 20 })));
console.log('manifest:', await poll(page, () => udmStatus(), 'manifest'));
console.log('inject frames:', await page.evaluate(code('udemy_frames.js')));
console.log('frames start:', await page.evaluate(() => udfStart({ interval: 2 })));
console.log('frames:', await poll(page, () => udfStatus(), 'frames'));
const pos = await page.evaluate(() => document.querySelector('video').currentTime);
console.log('restored position:', pos);
console.log('frames (times):', await page.evaluate(() => udfRun({ times: [3, 13, 23], download: false })));
await page.goto(`${base}/course/test-trading-course/learn/lecture/1002`);
await page.evaluate(code('udemy_frames.js'));
console.log('frames 1002 (moving inset):', await page.evaluate(() => udfRun({ interval: 2 })));
await page.goto(`${base}/course/test-trading-course/learn/lecture/1001`);
await page.evaluate(code('udemy_frames.js'));
console.log('batch start:', await page.evaluate(() => udfBatch([{ id: 1001 }, { id: 1002 }, { id: 1006, times: [3, 13, 23] }], { interval: 2 })));
const batchDone = await poll(page, () => udfStatus().replace(/^batch running/, 'running'), 'batch', 240000);
console.log('batch:', batchDone);
if (!/^batch finished: saved 3\/3$/.test(batchDone)) throw new Error('batch did not save 3 lectures: ' + batchDone);
await page.goto(`${base}/course/test-trading-course/learn/lecture/1001?nospa=1`);
await page.evaluate(code('udemy_frames.js'));
await page.evaluate(() => udfBatch([{ id: 1002 }, { id: 1006 }], { interval: 2 }));
const batchFail = await poll(page, () => udfStatus().replace(/^batch running/, 'running'), 'batch-fail', 120000);
console.log('batch without in-page navigation:', batchFail);
if (!/^batch stopped: saved 0\/2.*navigation failed/.test(batchFail)) throw new Error('expected a clean stop: ' + batchFail);
await new Promise((r) => setTimeout(r, 1500));
console.log('saved:', JSON.stringify(saved.map((p) => path.basename(p))));
await browser.close();
