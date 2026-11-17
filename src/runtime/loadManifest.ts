import type { GameManifest } from "../types";
import { demoManifest } from "./demoManifest";
import { gunzipIfNeeded } from "./gzip";
import { installSceneStore, type PackedSceneIndex } from "./sceneStore";

type PackBootstrap = {
  format?: string;
  version?: number;
  index?: string;
  fallback?: string;
};

type PackedManifestIndex = GameManifest & { sceneIndex?: PackedSceneIndex };

function isRootRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

function rebase(url: string, base: URL): string {
  return isRootRelative(url) ? new URL(url.slice(1), base).href : url;
}

function validate(manifest: PackedManifestIndex): void {
  if (!manifest.scenes || !Object.keys(manifest.scenes).length || !manifest.assets || !manifest.logicalSize || !manifest.flowchart) {
    throw new Error("The game manifest is invalid. Regenerate it with npm run prepare:air.");
  }
}

async function fetchIndex(url: string): Promise<PackedManifestIndex> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Packed manifest index failed to load (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const raw = await gunzipIfNeeded(bytes);
  return JSON.parse(new TextDecoder().decode(raw)) as PackedManifestIndex;
}

/**
 * Load the tiny bootstrap and the hashed index, then install the lazy scene
 * store. If a browser cannot decompress gzip, the raw index is used.
 */
async function loadPackedManifest(bootstrap: PackBootstrap, base: URL): Promise<GameManifest> {
  if (!bootstrap.index) throw new Error("The packed manifest index is missing.");
  let index: PackedManifestIndex;
  try {
    index = await fetchIndex(new URL(bootstrap.index, base).href);
  } catch (error) {
    if (!bootstrap.fallback) throw error;
    index = await fetchIndex(new URL(bootstrap.fallback, base).href);
  }

  for (const asset of Object.values(index.assets ?? {})) {
    if (typeof asset.url === "string") asset.url = rebase(asset.url, base);
  }
  if (index.sceneIndex) {
    for (const entry of Object.values(index.sceneIndex)) {
      if (typeof entry.u === "string") entry.u = rebase(entry.u, base);
    }
  }

  // Keep dev/legacy callers working if a packed index somehow contains full
  // scene programs instead of a scene index.
  if (index.sceneIndex && Object.keys(index.sceneIndex).length) {
    installSceneStore(index, index.sceneIndex);
  }
  validate(index);
  return index;
}

export async function loadManifest(): Promise<GameManifest> {
  // The safe default production build never requests game data, even if an
  // older deployment left a proprietary manifest on the same host.
  if (import.meta.env.MODE === "demo" || (import.meta.env.PROD && import.meta.env.MODE !== "game")) return demoManifest;
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const response = await fetch(`${import.meta.env.BASE_URL}manifest.json`, { cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
    if (import.meta.env.DEV) return demoManifest;
    throw new Error("Game manifest is missing. Ask the host to check its asset deployment.");
  }
  const loaded = await response.json() as GameManifest | PackBootstrap | null;
  if (loaded && typeof loaded === "object" && "format" in loaded && loaded.format === "air-pack-v1") {
    return loadPackedManifest(loaded, base);
  }
  if (!loaded || typeof loaded !== "object") throw new Error("The game manifest is invalid. Regenerate it with npm run prepare:air.");
  const manifest = loaded as GameManifest;
  validate(manifest);
  // Generated manifests use root-relative URLs. Rebase them for project pages.
  for (const asset of Object.values(manifest.assets)) {
    if (isRootRelative(asset.url)) asset.url = rebase(asset.url, base);
  }
  return manifest;
}
