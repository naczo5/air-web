import type { GameManifest } from "../types";
import { demoManifest } from "./demoManifest";

export async function loadManifest(): Promise<GameManifest> {
  // The safe default production build never requests game data, even if an
  // older deployment left a proprietary manifest on the same host.
  if (import.meta.env.MODE === "demo" || (import.meta.env.PROD && import.meta.env.MODE !== "game")) return demoManifest;
  const response = await fetch(`${import.meta.env.BASE_URL}manifest.json`, { cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
    if (import.meta.env.DEV) return demoManifest;
    throw new Error("Game manifest is missing. Ask the host to check its asset deployment.");
  }
  const manifest = await response.json() as GameManifest;
  if (!manifest.scenes || !Object.keys(manifest.scenes).length || !manifest.assets || !manifest.logicalSize || !manifest.flowchart) {
    throw new Error("The game manifest is invalid. Regenerate it with npm run prepare:air.");
  }
  // Generated manifests use root-relative URLs. Rebase them for project pages.
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  for (const asset of Object.values(manifest.assets)) {
    if (asset.url.startsWith("/") && !asset.url.startsWith("//")) asset.url = new URL(asset.url.slice(1), base).href;
  }
  return manifest;
}
