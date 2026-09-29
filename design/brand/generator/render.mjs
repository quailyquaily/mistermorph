// Render the icon SVGs to PNG at their exact pixel sizes, keeping transparency.
//   node design/brand/generator/render.mjs                        # the brand icons (render-jobs.json)
//   node design/brand/generator/render.mjs <jobs.json> <base dir> # another job list, paths from base
// Needs playwright-core; set CHROMIUM_PATH if Chromium isn't where Playwright looks by default.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const brand = join(dirname(fileURLToPath(import.meta.url)), "..");
const jobsFile = process.argv[2] ? resolve(process.argv[2]) : join(brand, "generator", "render-jobs.json");
const base = process.argv[3] ? resolve(process.argv[3]) : brand;
const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
for (const job of jobs) {
  const svg = readFileSync(join(base, job.svg), "utf8").replace("<svg ", '<svg style="display:block" ');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: join(base, job.png), clip: { x: 0, y: 0, width: job.size, height: job.size }, omitBackground: true });
}
await browser.close();
console.log(`rendered ${jobs.length} PNGs`);
