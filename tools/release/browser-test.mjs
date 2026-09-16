import { spawnSync } from "node:child_process";
const game = process.argv.includes("--game");
const env = { ...process.env, AIR_E2E_GAME: game ? "1" : "0" };
for (const args of [
  ["node_modules/vite/bin/vite.js", "build", "--mode", game ? "game" : "demo", "--base", "/qa/"],
  ["node_modules/@playwright/test/cli.js", "test"],
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
