import { chromium } from "@playwright/test";

const base = process.env.PACK_URL || "http://127.0.0.1:8787/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const failures = [];
page.on("console", (m) => { if (m.type() === "error") failures.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: "load" });
await page.waitForSelector(".title-screen", { timeout: 30_000 });
await page.getByRole("button", { name: "New Game", exact: true }).click();
await page.waitForSelector(".app-shell", { timeout: 30_000 });
await page.waitForTimeout(3000);

// Open the menu and confirm dialog semantics plus initial focus.
await page.getByRole("button", { name: "Menu", exact: true }).click();
await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
const semantics = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  return { ariaModal: dialog?.getAttribute("aria-modal"), label: dialog?.getAttribute("aria-label") };
});
const insideAfterOpen = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));

// Tab far more times than there are controls: focus must never leave the dialog.
let escaped = 0;
for (let i = 0; i < 40; i += 1) {
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
  if (!inside) escaped += 1;
}
// And backwards.
for (let i = 0; i < 25; i += 1) {
  await page.keyboard.press("Shift+Tab");
  const inside = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
  if (!inside) escaped += 1;
}

// Escape closes it and focus returns outside the dialog.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const closed = (await page.locator('[role="dialog"]').count()) === 0;
const focusReturned = await page.evaluate(() => !document.querySelector('[role="dialog"]')?.contains(document.activeElement));

console.log(JSON.stringify({ semantics, insideAfterOpen, escapedFocusCount: escaped, closed, focusReturned, failures }, null, 2));
await browser.close();
// `insideAfterOpen` is part of the contract: the dialog must take focus on
// open, otherwise a keyboard user starts outside the panel they just opened.
const problems = [];
if (failures.length) problems.push(`console/page errors: ${failures.join(" | ")}`);
if (escaped > 0) problems.push(`focus escaped the dialog ${escaped} times`);
if (!closed) problems.push("Escape did not close the dialog");
if (!semantics.ariaModal) problems.push("dialog is missing aria-modal");
if (!insideAfterOpen) problems.push("focus did not move into the dialog on open");
if (!focusReturned) problems.push("focus was not restored after close");
if (problems.length) {
  console.error(`FAIL: ${problems.join("; ")}`);
  process.exitCode = 1;
}
