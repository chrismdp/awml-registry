// Pictures each page that pictures.json names, on one running registry, at desktop width and at
// phone width. .github/picture-pages.sh runs it once on main and once on the change, against the
// same seeded data, and pairs the results up.
//
// A page with no moves is pictured as a still PNG of the whole page, up to a height limit. A page
// with moves is recorded as a GIF of the screen: a frame before the first move and one after each,
// with more frames along a drag. A page that can't be pictured, such as one whose move names
// something that isn't there on main, gets no picture, and the pull request says so.
//
//   node picture-pages.mjs --base <address> --cookie <file> --pages <pictures.json> \
//     --side before|after --out <directory>
//
// It needs playwright-core, gifenc and pngjs installed beside it, and a Chrome at $CHROME.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import gifenc from "gifenc";
import pngjs from "pngjs";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const widths = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, tallest: 4000 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, tallest: 3000 },
};

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    cookie: { type: "string" },
    pages: { type: "string" },
    side: { type: "string" },
    out: { type: "string" },
  },
});
const { base, side, out } = values;
if (!base || !values.cookie || !values.pages || !["before", "after"].includes(side) || !out) {
  throw new Error("usage: picture-pages.mjs --base <address> --cookie <file> --pages <file> --side before|after --out <dir>");
}
const pages = JSON.parse(readFileSync(values.pages, "utf8"));
const [name, ...rest] = readFileSync(values.cookie, "utf8").trim().split(";")[0].split("=");
const cookie = { name, value: rest.join("="), url: base };

// Waits for the page to finish drawing: its fonts, and every Mermaid drawing, which the browser
// draws after the page loads. A drawing that never finishes is pictured as it is.
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(() => [...document.querySelectorAll(".drawing")].every((d) => d.querySelector("svg")), null, {
      timeout: 10_000,
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function still(page, file, tallest) {
  const { width } = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({
    path: file,
    fullPage: true,
    clip: { x: 0, y: 0, width, height: Math.min(height, tallest) },
    animations: "disabled",
    caret: "hide",
  });
}

async function move(page, step, frames) {
  const shot = async () => frames.push(await page.screenshot({ caret: "hide" }));
  if (step.scroll) {
    await page.locator(step.scroll).first().scrollIntoViewIfNeeded({ timeout: 5_000 });
  } else if (step.click) {
    await page.locator(step.click).first().click({ timeout: 5_000 });
  } else if (step.press) {
    if (step.on) await page.locator(step.on).first().focus({ timeout: 5_000 });
    await page.keyboard.press(step.press);
  } else if (step.drag) {
    const box = await page.locator(step.drag).first().boundingBox({ timeout: 5_000 });
    if (!box) throw new Error(`${step.drag} is not on the screen`);
    const [dx, dy] = step.by;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(x + (dx * i) / 4, y + (dy * i) / 4, { steps: 3 });
      if (i < 4) await shot();
    }
    await page.mouse.up();
  } else if (step.wait) {
    await page.waitForTimeout(step.wait);
  }
  await page.waitForTimeout(300);
  await shot();
}

// Each frame is shown for 0.7 seconds, and the last for 2, before the GIF starts again.
function gif(frames, file) {
  const encoder = GIFEncoder();
  frames.forEach((frame, i) => {
    const { width, height, data } = pngjs.PNG.sync.read(frame);
    const palette = quantize(data, 256);
    encoder.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      delay: i === frames.length - 1 ? 2000 : 700,
    });
  });
  encoder.finish();
  writeFileSync(file, encoder.bytes());
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
const results = [];
try {
  for (const [index, entry] of pages.entries()) {
    for (const [width, { tallest, ...options }] of Object.entries(widths)) {
      const moves = entry.moves ?? [];
      const file = `${String(index + 1).padStart(2, "0")}-${width}-${side}.${moves.length ? "gif" : "png"}`;
      const context = await browser.newContext(options);
      if (entry.as === "owner") await context.addCookies([cookie]);
      const page = await context.newPage();
      try {
        await page.goto(new URL(entry.path, base).toString(), { waitUntil: "networkidle", timeout: 30_000 });
        await settle(page);
        if (moves.length) {
          const frames = [await page.screenshot({ caret: "hide" })];
          for (const step of moves) await move(page, step, frames);
          gif(frames, join(out, file));
        } else {
          await still(page, join(out, file), tallest);
        }
        results.push({ index, width, file });
      } catch (error) {
        console.error(`Could not picture ${entry.path} at ${width} width on ${side}: ${error.message}`);
        results.push({ index, width, file: "" });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, `${side}.json`), JSON.stringify(results));
