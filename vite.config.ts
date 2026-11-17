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
// `AIR_PLAYER_ONLY=1` skips the media copy: the packed deployment takes its
// media from the pack archives, so a shell-only build is all `pack:air
// --with-player` needs (and avoids copying 1.6 GB on every rebuild).
function gameAssetsPlugin(): Plugin {
  let outDir: string;
  return {
    name: "air-game-assets",
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    async closeBundle() {
      if (process.env.AIR_PLAYER_ONLY === "1") return;
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
    // Always clear the bundle directory. Game mode used to keep `outDir` so
    // that copied media survived a rebuild, but that also kept every previous
    // hashed JS/CSS bundle: 14 stale bundles had accumulated in
    // `dist-game/assets`, and `pack:air --with-player` copied them all into the
    // deployment tree. `gameAssetsPlugin` re-copies the media after the build,
    // so clearing is safe and keeps the shipped object count honest.
    build: { outDir: game ? "dist-game" : "dist", emptyOutDir: true },
    server: {
      host: process.env.AIR_LAN === "1" ? true : "127.0.0.1",
      port: 5173,
      strictPort: true,
      // The decoded asset tree holds ~26k files; watching it exhausts the
      // inotify limit on this host and the dev server refuses to start.
      watch: {
        ignored: [
          "**/AIR_SE/**",
          "**/.air-web-assets/**",
          "**/dist/**",
          "**/dist-game/**",
          "**/dist-pack*/**",
          "**/hosting/**",
          "**/release/**",
          "**/test-results/**",
          "**/playwright-report/**",
        ],
      },
      // Denied paths must not include `.air-web-assets/**`: in serve mode that
      // directory *is* `publicDir`, so the documented real-data `npm run dev`
      // flow needs generated media served. Private deployment trees, notes and
      // build outputs are blocked instead.
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/AIR_SE/**",
          "**/hosting/**",
          "**/dist/**",
          "**/dist-game/**",
          "**/dist-pack*/**",
          "**/release/**",
          "**/test-results/**",
          "**/playwright-report/**",
          "**/coverage/**",
          "**/.air-web-assets/asset-report.json",
          "**/.air-web-assets/manifest.webmanifest",
          "**/.air-web-assets/sw.js",
        ],
      },
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
