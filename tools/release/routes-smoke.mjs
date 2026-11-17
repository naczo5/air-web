import { chromium } from "@playwright/test";

const base = process.env.PACK_URL || "http://127.0.0.1:8787/";
const browser = await chromium.launch();
const failures = [];

// Each of the three story entries must reach a *different* scene, otherwise two
// arcs of the game stay unreachable no matter what the title screen offers.
for (const [label, expected] of [["Dream", "seen0170"], ["Summer", "seen0700"], ["Air", "seen0163"]]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") failures.push(`${label} console: ${m.text()}`); });
  page.on("pageerror", (e) => failures.push(`${label} pageerror: ${e.message}`));
  try {
    await page.goto(base, { waitUntil: "load" });
    await page.waitForSelector(".title-screen", { timeout: 30_000 });
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForSelector(".app-shell", { timeout: 30_000 });
    await page.waitForTimeout(4000);
    const status = (await page.locator(".status-bar").textContent())?.replace(/\s+/g, " ") ?? "";
    // The date is a canvas plate plus the stage's accessible name, not a text
    // node, so read the label instead of the removed `.stage-date` element.
    const readLabel = async () => (await page.locator(".stage-shell").getAttribute("aria-label")) ?? "";
    const dateOf = (label) => /—\s*(.+)$/.exec(label)?.[1]?.trim() ?? "";
    // The plate is drawn when the scene opens its message window, a few lines
    // in rather than on the first one, so advance before asserting the badge.
    // The Sora opening keeps its date window off, so it is checked without this.
    if (expected === "seen0170") {
      for (let step = 0; step < 40 && !dateOf(await readLabel()); step += 1) {
        await page.locator(".stage-shell").click({ position: { x: 320, y: 240 } });
        await page.waitForTimeout(300);
      }
    }
    const stageLabel = await readLabel();
    const date = dateOf(stageLabel);
    console.log(`${label.padEnd(7)} -> ${status.includes(expected) ? "OK " : "FAIL"} ${status}  stage="${stageLabel}"`);
    if (!status.includes(expected)) failures.push(`${label}: expected ${expected}, got ${status}`);
    // The date comes from the engine's object table, not the scene title: the
    // Dream opening draws the `SDT0717` plate and announces it, while the Sora
    // opening turns its date window off (`$5[2] = 0`) and has no date at all.
    if (expected === "seen0170" && date !== "July 17") failures.push(`${label}: expected the July 17 badge, got "${date}"`);
    if (expected === "seen0163" && date) failures.push(`${label}: the date window is off in this scene, got "${date}"`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`${label.padEnd(7)} -> ERROR ${error.message.slice(0, 90)}`);
  }
  await page.close();
}

await browser.close();
console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\nall story entries reach their own scene");
if (failures.length) process.exitCode = 1;
