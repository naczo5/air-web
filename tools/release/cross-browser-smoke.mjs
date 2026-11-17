import { chromium, firefox, webkit } from "@playwright/test";

/**
 * Cross-browser smoke test for the packed deployment.
 *
 * The port relies on three browser features that are not universally
 * guaranteed, so each is exercised explicitly:
 *   - `DecompressionStream` (gzip scene/index decode)
 *   - `createObjectURL` + `Blob` (packed byte-range assets)
 *   - `Range` requests with `206 Partial Content`
 *
 * Chromium is the reference; Firefox and WebKit are skipped when the browser
 * binary is not installed, so this stays runnable on a minimal host.
 */
const base = process.env.PACK_URL || "http://127.0.0.1:8787/";

const engines = [
  { name: "chromium", launcher: chromium },
  { name: "firefox", launcher: firefox },
  { name: "webkit", launcher: webkit },
];

const results = [];

for (const engine of engines) {
  let browser;
  try {
    browser = await engine.launcher.launch();
  } catch (error) {
    const message = String(error?.message ?? error);
    const missing = /Executable doesn't exist|is not installed|Failed to launch/i.test(message);
    results.push({ engine: engine.name, status: missing ? "SKIPPED (binary missing)" : "LAUNCH FAILED", detail: message.split("\n")[0].slice(0, 120) });
    continue;
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const failures = [];
  const rangeStatuses = new Set();
  page.on("console", (m) => { if (m.type() === "error") failures.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.url().includes(".pack")) rangeStatuses.add(r.status()); });

  try {
    await page.goto(base, { waitUntil: "load" });
    await page.waitForSelector(".title-screen", { timeout: 30_000 });
    // Title art is a packed byte-range image: this proves Blob + Range work.
    await page.waitForFunction(() => {
      const image = document.querySelector("img.title-art");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    }, { timeout: 30_000 });

    await page.getByRole("button", { name: "New Game", exact: true }).click();
    await page.waitForSelector(".app-shell", { timeout: 30_000 });
    await page.waitForTimeout(4000);

    // Advance so voices, music and background packs are all exercised.
    for (let i = 0; i < 20; i += 1) {
      const choice = page.locator(".choice-list button").first();
      if (await choice.isVisible().catch(() => false)) await choice.click();
      else await page.locator(".stage-shell").click({ position: { x: 320, y: 240 } });
      await page.waitForTimeout(220);
    }

    // The scene index is gzip and the scene programs are gzip: reaching a later
    // scene proves DecompressionStream is doing its job.
    const status = (await page.locator(".status-bar").textContent())?.replace(/\s+/g, " ") ?? "";
    const features = await page.evaluate(() => ({
      decompression: typeof DecompressionStream !== "undefined",
      blobs: typeof URL.createObjectURL === "function",
      indexedDb: typeof indexedDB !== "undefined",
    }));

    results.push({
      engine: engine.name,
      status: failures.length === 0 ? "PASS" : "FAIL",
      scene: status.slice(0, 60),
      rangeStatuses: [...rangeStatuses],
      features,
      failures,
    });
  } catch (error) {
    results.push({ engine: engine.name, status: "FAIL", detail: String(error?.message ?? error).split("\n")[0].slice(0, 160), failures });
  } finally {
    await page.close();
    await browser.close();
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.status === "FAIL" || r.status === "LAUNCH FAILED");
if (failed.length) process.exitCode = 1;
