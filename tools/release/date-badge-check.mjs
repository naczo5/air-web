/**
 * Verifies the date badge on the packed build, in pixels.
 *
 * The badge is a canvas graphic, not DOM, so a screenshot alone only shows
 * "something is in the corner". This plays into a dated scene, then measures
 * the badge exactly by diffing the canvas with `showDateCaption` on and off:
 * the difference IS the plate, which gives its position and size without
 * having to guess from colours. It also proves the setting gates the drawn
 * plate, which is part of the parity requirement.
 */
import { chromium } from "@playwright/test";

const base = process.env.PACK_URL || "http://127.0.0.1:8787/";
const out = process.env.SHOT_PATH || "/tmp/air-date-badge.png";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const failures = [];
page.on("console", (m) => { if (m.type() === "error") failures.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

const snapshot = () => page.evaluate(() => {
  const canvas = document.querySelector(".game-canvas");
  const context = canvas.getContext("2d");
  const { width, height } = canvas;
  return { width, height, data: Array.from(context.getImageData(0, 0, width, height).data) };
});

await page.goto(base, { waitUntil: "load" });
await page.waitForSelector(".title-screen", { timeout: 30_000 });
await page.getByRole("button", { name: "New Game", exact: true }).click();
await page.waitForSelector(".app-shell", { timeout: 30_000 });
await page.waitForTimeout(2500);

// The date is announced through the stage's accessible name while the plate is
// drawn, so the label losing its "— <date>" suffix is the signal that the badge
// is no longer on the canvas.
const hasDate = async () => /—/.test((await page.locator(".stage-shell").getAttribute("aria-label")) ?? "");
let steps = 0;
for (; steps < 40; steps += 1) {
  if (await hasDate()) break;
  await page.locator(".stage-shell").click({ position: { x: 320, y: 240 } });
  await page.waitForTimeout(320);
}
const captionGone = await hasDate();
await page.waitForTimeout(600);

const withBadge = await snapshot();
await page.screenshot({ path: out });
const stageBox = await page.locator(".stage-shell").boundingBox();
if (stageBox) await page.screenshot({ path: out.replace(/\.png$/, "-stage.png"), clip: stageBox });

// Turn the caption off: the plate must leave the canvas, the stage label must
// drop the date, and no text caption may take its place.
await page.getByRole("button", { name: "Menu", exact: true }).click();
await page.waitForSelector('[role="dialog"]');
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.waitForTimeout(400);
const toggle = page.locator('.checkbox-row input[type="checkbox"]').first();
await toggle.click();
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
const captionOff = !(await hasDate());
const withoutBadge = await snapshot();

// Diff the two frames. Everything the plate covers must be identical elsewhere.
let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, changed = 0;
const width = withBadge.width;
for (let index = 0; index < withBadge.data.length; index += 4) {
  const delta = Math.abs(withBadge.data[index] - withoutBadge.data[index])
    + Math.abs(withBadge.data[index + 1] - withoutBadge.data[index + 1])
    + Math.abs(withBadge.data[index + 2] - withoutBadge.data[index + 2]);
  if (delta < 24) continue;
  const pixel = index / 4;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  changed += 1;
  if (x < minX) minX = x;
  if (y < minY) minY = y;
  if (x > maxX) maxX = x;
  if (y > maxY) maxY = y;
}
const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, changedPixels: changed };

// Re-enable so the screenshot pair on disk shows the badge.
await page.getByRole("button", { name: "Menu", exact: true }).click();
await page.waitForSelector('[role="dialog"]');
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.waitForTimeout(400);
await page.locator('.checkbox-row input[type="checkbox"]').first().click();
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await page.screenshot({ path: out.replace(/\.png$/, "-full.png") });
const restored = await hasDate();

const sceneLabel = (await page.locator(".status-bar").textContent())?.replace(/\s+/g, " ").trim();
const report = { captionGone, captionOff, restored, bbox, canvas: { width: withBadge.width, height: withBadge.height }, sceneLabel, failures, screenshot: out };
console.log(JSON.stringify(report, null, 2));
await browser.close();

/**
 * The plate is a 150x154 PNG drawn at (16,16) whose own alpha bounding box is
 * (6,3)-(146,151), i.e. 141x149 of ink with transparent margins. Frame diffing
 * therefore measures the ink, not the draw rectangle:
 *
 *   expected ink = (16+6, 16+3) = (22,19), size 141x149
 *
 * Anything else means the plate is scaled, offset or clipped.
 */
const expected = { x: 22, y: 19, width: 141, height: 149 };
const close = (actual, want) => Math.abs(actual - want) <= 1;
if (!captionGone || !captionOff || !restored || failures.length
  || !close(bbox.x, expected.x) || !close(bbox.y, expected.y)
  || !close(bbox.width, expected.width) || !close(bbox.height, expected.height)) {
  process.exitCode = 1;
}
