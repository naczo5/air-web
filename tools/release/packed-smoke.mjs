import { chromium } from "@playwright/test";

const base = process.env.PACK_URL || "http://127.0.0.1:8787/";
const shots = process.env.SHOT_DIR || "/tmp/air-pack-shots";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failures = [];
const requests = [];
const rangeResponses = [];

page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("request", (request) => requests.push(request.url()));
page.on("response", (response) => {
  const url = response.url();
  if (response.status() >= 400) failures.push(`http ${response.status()}: ${url}`);
  if (url.includes(".pack")) rangeResponses.push({ status: response.status(), url: url.split("/").pop() });
});

const step = async (name, action) => {
  try {
    await action();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

await page.goto(base, { waitUntil: "load" });
await step("title", async () => {
  await page.waitForSelector(".title-screen", { timeout: 30_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector("img.title-art");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  }, { timeout: 30_000 });
  await page.screenshot({ path: `${shots}/01-title.png` });
});

await step("new game", async () => {
  await page.getByRole("button", { name: "New Game" }).click();
  await page.waitForSelector(".app-shell", { timeout: 30_000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${shots}/02-ingame.png` });
});

// Play a while so voices, music and image packs are exercised. Keyboard
// advance is more reliable than clicking a moving target, and each step is
// wrapped so one bad frame cannot abort the whole run.
for (let index = 0; index < 40; index += 1) {
  await step(`advance ${index}`, async () => {
    const choice = page.locator(".choice-list button").first();
    if (await choice.isVisible().catch(() => false)) await choice.click();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(320);
  });
  if (page.isClosed()) break;
}
if (!page.isClosed()) await page.screenshot({ path: `${shots}/03-played.png` }).catch(() => undefined);

const stageLabel = await page.locator(".stage-shell").getAttribute("aria-label").catch(() => null);
const sceneLabel = await page.locator(".status-bar").textContent().catch(() => null);

await step("menu", async () => {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/04-menu.png` });
});
await step("gallery", async () => {
  await page.getByRole("button", { name: "CG Gallery", exact: true }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/05-gallery.png` });
});
await step("music", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Music Mode", exact: true }).click();
  await page.waitForTimeout(1500);
  const first = page.locator(".music-gallery button, .music-list button").first();
  if (await first.count()) {
    await first.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${shots}/06-music.png` });
});
await step("settings", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/07-settings.png` });
});
let flowStats = { cards: 0, discovered: "", arcs: [] };
await step("flowchart", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Flowchart", exact: true }).click();
  await page.waitForTimeout(2500);
  flowStats = await page.evaluate(() => ({
    cards: document.querySelectorAll(".flow-card").length,
    discovered: document.querySelector(".flow-progress, .flow-status, .flowchart-fullscreen")?.textContent?.match(/\d+\s*\/\s*\d+/)?.[0] ?? "",
    arcs: [...document.querySelectorAll(".flowchart-fullscreen button")].map((b) => b.textContent?.trim() ?? "").filter((t) => /ARC|ALL/i.test(t)),
  }));
  // A chart that renders zero cards, or loses its arc filters, is a regression
  // that a screenshot alone would not catch.
  if (flowStats.cards < 100) failures.push(`flowchart rendered only ${flowStats.cards} cards`);
  if (flowStats.arcs.length < 3) failures.push(`flowchart arc filters missing: ${JSON.stringify(flowStats.arcs)}`);
  await page.screenshot({ path: `${shots}/08-flowchart.png` });
});

const statuses = [...new Set(rangeResponses.map((entry) => entry.status))];
console.log(JSON.stringify({
  stageLabel: stageLabel?.trim(),
  sceneLabel: sceneLabel?.replace(/\s+/g, " ").trim(),
  flowchart: flowStats,
  totalRequests: requests.length,
  packRequests: rangeResponses.length,
  packStatuses: statuses,
  non206: rangeResponses.filter((entry) => entry.status !== 206).slice(0, 5),
  failures,
}, null, 2));

await browser.close();
if (failures.length) process.exitCode = 1;
