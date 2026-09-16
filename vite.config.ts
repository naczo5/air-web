import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const generatedAssets = path.join(root, ".air-web-assets");

// Only an explicit game build may copy private, generated game content.
function gameAssetsPlugin(): Plugin {
  let outDir: string;
  return {
    name: "air-game-assets",
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    async closeBundle() {
      for (const name of ["manifest.json", "images", "audio", "voices"]) {
        await fs.cp(path.join(generatedAssets, name), path.join(outDir, name), { recursive: true });
      }
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const game = mode === "game";
  const demo = mode === "demo" || (command === "build" && !game);
  if (game && !existsSync(path.join(generatedAssets, "manifest.json"))) {
    throw new Error("Game assets are missing. Run npm run prepare:air with your own AIR_SE data first.");
  }
  return {
    plugins: [react(), ...(command === "build" && game ? [gameAssetsPlugin()] : [])],
    publicDir: command === "serve" && !demo && existsSync(generatedAssets) ? generatedAssets : "public",
    build: { outDir: game ? "dist-game" : "dist", emptyOutDir: !game },
    server: {
      host: process.env.AIR_LAN === "1" ? true : "127.0.0.1",
      port: 5173,
      strictPort: true,
      fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/AIR_SE/**"] },
    },
    preview: {
      host: process.env.AIR_LAN === "1" ? true : "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      exclude: ["**/node_modules/**", "**/release/**", "**/dist*/**", "**/e2e/**"],
    },
  };
});
