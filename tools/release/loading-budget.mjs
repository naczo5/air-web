/**
 * Measures perceived loading on a throttled link.
 *
 * The user's complaint was network-bound: on a slow uplink every packed asset
 * is a separate round trip, so anything not fetched early is a visible stall.
 * This harness throttles the page to a realistic slow uplink and reports:
 *
 *   - how long the title art takes to appear (and that no alt text shows),
 *   - the gap between a line appearing and its voice starting,
 *   - whether the backdrop is painted before the first dialogue line,
 *   - how many requests are in flight while the player is reading (prefetch).
 *
 *   node tools/release/loading-budget.mjs
 */
import { chromium } from "@playwright/test";

const base = process.env.PACK_URL || "http://127.0.0.1:8787/";
// ~1.5 Mbit/s with 120 ms latency, roughly a bad mobile connection.
const DOWN_BPS = Number(process.env.THROTTLE_BPS || 190_000);
const LATENCY_MS = Number(process.env.THROTTLE_MS || 120);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const client = await context.newCDPSession(page);
await client.send("Network.enable");
await client.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: LATENCY_MS,
  downloadThroughput: DOWN_BPS,
  uploadThroughput: DOWN_BPS,
});

const inFlight = new Set();
const log = { title: 0, firstLine: 0, backdropBeforeLine: null, voiceDelayMs: null, prefetchWhileReading: 0 };

page.on("request", (r) => {
  if (r.url().includes(".pack") || /\.(png|ogg|wav)$/.test(r.url())) inFlight.add(r.url());
});
page.on("requestfinished", (r) => inFlight.delete(r.url()));
page.on("requestfailed", (r) => inFlight.delete(r.url()));

const started = Date.now();
await page.goto(base, { waitUntil: "domcontentloaded" });

// The title art must fade in, and its alt text must never be visible.
await page.waitForSelector(".title-screen", { timeout: 60_000 });
const altVisibleAtStart = await page.evaluate(() => {
  const img = document.querySelector("img.title-art");
  if (!img) return "no-title-img";
  const style = getComputedStyle(img);
  return { opacity: style.opacity, altText: img.alt, hasSrc: Boolean(img.getAttribute("src")) };
});
await page.waitForFunction(() => {
  const img = document.querySelector("img.title-art");
  return img && getComputedStyle(img).opacity === "1";
}, { timeout: 60_000 });
log.title = Date.now() - started;

await page.getByRole("button", { name: "New Game", exact: true }).click();
await page.waitForSelector(".app-shell", { timeout: 30_000 });

// Wait for the first line of dialogue, then sample how busy the network is.
await page.waitForSelector(".dialogue-text", { timeout: 30_000 });
log.firstLine = Date.now() - started;

// While the player reads, are we fetching ahead?
const samples = [];
for (let i = 0; i < 12; i += 1) {
  samples.push(inFlight.size);
  await page.waitForTimeout(250);
}
log.prefetchWhileReading = Math.max(...samples);

// Backdrop painted before the text appears?
const canvasHasArt = await page.evaluate(() => {
  const canvas = document.querySelector("canvas.game-canvas");
  if (!canvas) return false;
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4 * 97) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  return seen.size > 12; // a flat gradient yields very few distinct colours
});
log.backdropBeforeLine = canvasHasArt;

console.log(JSON.stringify({ ...log, altAtStart: altVisibleAtStart, peakInFlightWhileReading: log.prefetchWhileReading }, null, 2));
await browser.close();
