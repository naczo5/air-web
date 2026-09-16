import { defineConfig } from "@playwright/test";

const game = process.env.AIR_E2E_GAME === "1";
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4186/qa/",
    browserName: "chromium",
    channel: process.env.AIR_BROWSER_CHANNEL || undefined,
    trace: "off", // Real-game traces and screenshots contain proprietary content.
  },
  projects: [{ name: game ? "game" : "demo" }],
  webServer: {
    command: `npx vite preview --mode ${game ? "game" : "demo"} --base /qa/ --port 4186`,
    url: "http://127.0.0.1:4186/qa/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
