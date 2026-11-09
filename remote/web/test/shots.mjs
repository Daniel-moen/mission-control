// Screenshots of every view at iPhone and iPad sizes (task 0612).
// node test/shots.mjs <baseUrl> <token> <outDir>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { webkit, chromium } = require(process.env.PLAYWRIGHT || `${process.env.HOME}/PropIQ-design-0225/node_modules/playwright`);
const [base = 'http://localhost:8612', token = '', out = '/tmp/v6-shots'] = process.argv.slice(2);
const fs = await import('node:fs');
fs.mkdirSync(out, { recursive: true });
const devices = [
  { name: 'iphone', viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'ipad', viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const views = ['now', 'tasks', 'mia', 'library', 'fleet', 'task/0101', 'settings', 'talk'];
// SHOTS_ENGINE=chromium renders backdrop blur (headless WebKit doesn't); SHOTS_BG=06 picks a backdrop photo
let browserType = process.env.SHOTS_ENGINE === 'chromium' ? chromium : webkit;
let browser;
try { browser = await browserType.launch(); } catch { browserType = chromium; browser = await chromium.launch(); }
const errors = [];
for (const d of devices) {
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: browserType === chromium ? d.isMobile : undefined, hasTouch: d.hasTouch });
  const page = await ctx.newPage();
  if (process.env.SHOTS_BG) await page.addInitScript((bg) => localStorage.setItem('mc6_bg', bg), process.env.SHOTS_BG);
  page.on('pageerror', (e) => errors.push(`${d.name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${d.name} console: ${m.text()}`));
  await page.goto(`${base}/v6?token=${token}#now`);
  await page.waitForSelector('[data-hero]', { timeout: 15000 });
  await page.waitForTimeout(2500);
  for (const v of views) {
    await page.evaluate((h) => { location.hash = h; }, `#${v}`);
    if (v === 'talk') await page.evaluate(() => {});
    await page.waitForTimeout(1300);
    const file = `${out}/${d.name}-${v.replace('/', '-')}.png`;
    await page.screenshot({ path: file });
    console.log(file);
    if (v.startsWith('task/') || v === 'settings') await page.keyboard.press('Escape');
    if (v === 'talk') await page.evaluate(() => { location.hash = '#now'; });
    if (v === 'now') {
      await page.evaluate(() => document.querySelector('[data-pane="now"] [data-crew]')?.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${d.name}-now-crew.png` });
      await page.evaluate(() => { const p = document.querySelector('[data-pane="now"]'); p.scrollTop = p.scrollHeight; });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${d.name}-now-bottom.png` });
      await page.evaluate(() => { document.querySelector('[data-pane="now"]').scrollTop = 0; });
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`engine: ${browserType.name()}`);
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
