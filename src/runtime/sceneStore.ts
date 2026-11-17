/**
 * Lazy scene store for packed manifests.
 *
 * The monolithic manifest is ~128 MB because the 96 scene programs contain
 * every instruction. The packed deployment keeps a small index (assets,
 * aliases, flowchart, scene offsets) and writes one gzipped JSON file per
 * scene. `loadManifest` installs this store and replaces `manifest.scenes`
 * with a proxy so existing synchronous callers still see known scene IDs.
 *
 * `AirRuntimeImpl` awaits `loadScene` before executing a scene. The proxy
 * returns a lightweight placeholder until the real program is cached; that
 * keeps save-slot validation and optional thumbnail lookups from throwing,
 * but only the runtime should execute instructions from the real object.
 */

import type { GameManifest, SceneProgram } from "../types";
import { gunzipIfNeeded } from "./gzip";

export type PackedSceneEntry = {
  /** Root-relative or absolute URL of the gzipped scene JSON. */
  u: string;
  /** Entrypoint index -> instruction pointer. */
  e?: Record<string, number>;
  /** Scene title shown in the date plaque (e.g. "July 17 (Monday)"). */
  t?: string;
  /** Uncompressed JSON byte length (diagnostics). */
  n?: number;
};

export type PackedSceneIndex = Record<string, PackedSceneEntry>;

type SceneStore = {
  ids: string[];
  index: PackedSceneIndex;
  cache: Map<string, SceneProgram>;
  inflight: Map<string, Promise<SceneProgram>>;
  placeholders: Map<string, SceneProgram>;
};

const stores = new WeakMap<GameManifest, SceneStore>();

/**
 * How many parsed scene programs stay resident. Eight is enough to cover the
 * current scene, its gosub targets and any immediately reachable next scenes,
 * and caps the retained JSON at roughly 40 MiB in the worst case.
 */
const SCENE_CACHE_MAX = 8;

function placeholder(sceneId: string): SceneProgram {
  return { id: sceneId, instructions: [] };
}

function asScene(value: unknown, sceneId: string): SceneProgram {
  if (!value || typeof value !== "object") throw new Error(`Scene ${sceneId} is not an object`);
  const scene = value as SceneProgram;
  if (!Array.isArray(scene.instructions)) throw new Error(`Scene ${sceneId} has no instructions`);
  return scene;
}

async function fetchScene(url: string, sceneId: string): Promise<SceneProgram> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Scene ${sceneId} failed to load (HTTP ${response.status})`);
  const packed = new Uint8Array(await response.arrayBuffer());
  const raw = await gunzipIfNeeded(packed);
  const text = new TextDecoder().decode(raw);
  return asScene(JSON.parse(text), sceneId);
}

/**
 * Install the lazy store and replace `manifest.scenes` with a proxy. Scene
 * URLs must already be rebased to absolute URLs by the caller.
 */
export function installSceneStore(manifest: GameManifest, index: PackedSceneIndex): void {
  const ids = Object.keys(index).sort();
  const cache = new Map<string, SceneProgram>();
  const inflight = new Map<string, Promise<SceneProgram>>();
  const placeholders = new Map<string, SceneProgram>();
  stores.set(manifest, { ids, index, cache, inflight, placeholders });

  manifest.scenes = new Proxy({} as Record<string, SceneProgram>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return sceneValue(manifest, property);
    },
    has(_target, property) {
      if (typeof property !== "string") return false;
      const store = stores.get(manifest);
      return Boolean(store && Object.hasOwn(store.index, property));
    },
    ownKeys() {
      return stores.get(manifest)?.ids ?? [];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== "string") return undefined;
      const store = stores.get(manifest);
      if (!store || !Object.hasOwn(store.index, property)) return undefined;
      // Must return the SAME value `get` returns: a descriptor whose value
      // disagrees with `get` is a spec violation, and Object.entries/spread
      // read the descriptor. Both traps therefore share one accessor.
      return { enumerable: true, configurable: true, writable: false, value: sceneValue(manifest, property) };
    },
  });
}

/**
 * Single source of truth for `manifest.scenes[id]`: the cached program if
 * loaded, otherwise a memoised inert placeholder, otherwise undefined. Only
 * own keys of the scene index resolve.
 */
function sceneValue(manifest: GameManifest, property: string): SceneProgram | undefined {
  const store = stores.get(manifest);
  if (!store) return undefined;
  const loaded = store.cache.get(property);
  if (loaded) return loaded;
  if (!Object.hasOwn(store.index, property)) return undefined;
  let value = store.placeholders.get(property);
  if (!value) {
    value = placeholder(property);
    store.placeholders.set(property, value);
  }
  return value;
}


/** Does the manifest know this scene ID? Works for plain and packed manifests. */
export function hasScene(manifest: GameManifest, sceneId: string): boolean {
  const store = stores.get(manifest);
  // Own-property checks only: a crafted save must not name `constructor` or
  // `__proto__` and pass a truthiness lookup on the prototype chain.
  if (store) return Object.hasOwn(store.index, sceneId);
  return Object.hasOwn(manifest.scenes, sceneId);
}

/**
 * Return a scene only if it is already in memory. For plain manifests this is
 * the real object; for packed manifests it is undefined until `loadScene`.
 */
export function peekScene(manifest: GameManifest, sceneId: string): SceneProgram | undefined {
  const store = stores.get(manifest);
  if (!store) return Object.hasOwn(manifest.scenes, sceneId) ? manifest.scenes[sceneId] : undefined;
  return store.cache.get(sceneId);
}

/**
 * Load (or join the in-flight load of) a scene program.
 *
 * Parsed scene programs are large (the biggest is ~5 MiB of JSON, ~116 MiB for
 * all 96). Keeping every visited scene resident would grow a long playthrough
 * unbounded, so the cache evicts least-recently-used programs past a cap. A
 * scene that is evicted is simply re-fetched, which is cheap because the
 * response is content-addressed and served `immutable`.
 */
export async function loadScene(manifest: GameManifest, sceneId: string): Promise<SceneProgram | undefined> {
  const store = stores.get(manifest);
  if (!store) return Object.hasOwn(manifest.scenes, sceneId) ? manifest.scenes[sceneId] : undefined;
  const cached = store.cache.get(sceneId);
  if (cached) {
    // Refresh recency so a scene revisited after a jump stays resident.
    store.cache.delete(sceneId);
    store.cache.set(sceneId, cached);
    return cached;
  }
  const entry = Object.hasOwn(store.index, sceneId) ? store.index[sceneId] : undefined;
  if (!entry) return undefined;
  const pending = store.inflight.get(sceneId);
  if (pending) return pending;
  const request = fetchScene(entry.u, sceneId);
  store.inflight.set(sceneId, request);
  try {
    const scene = await request;
    store.cache.set(sceneId, scene);
    evictScenes(store);
    return scene;
  } finally {
    store.inflight.delete(sceneId);
  }
}

/** Keeps the most recently used scene programs, bounded by count. */
function evictScenes(store: SceneStore): void {
  while (store.cache.size > SCENE_CACHE_MAX) {
    const oldest = store.cache.keys().next().value;
    if (oldest === undefined) break;
    store.cache.delete(oldest);
  }
}

/** Entrypoint instruction pointer without forcing a scene download. */
export function sceneEntrypoint(manifest: GameManifest, sceneId: string, entrypoint: number): number | undefined {
  const store = stores.get(manifest);
  if (store) {
    const value = Object.hasOwn(store.index, sceneId) ? store.index[sceneId].e?.[String(entrypoint)] : undefined;
    return value === undefined ? 0 : value;
  }
  return (Object.hasOwn(manifest.scenes, sceneId) ? manifest.scenes[sceneId].entrypoints?.[String(entrypoint)] : undefined) ?? 0;
}

/**
 * Scene title (the in-game date caption) without forcing a scene download.
 * Packed manifests keep a copy in the tiny index; plain manifests read it from
 * the scene program itself.
 */
export function sceneTitle(manifest: GameManifest, sceneId: string | undefined): string | undefined {
  if (!sceneId) return undefined;
  const store = stores.get(manifest);
  if (store) {
    const entry = Object.hasOwn(store.index, sceneId) ? store.index[sceneId] : undefined;
    return entry?.t ?? store.cache.get(sceneId)?.title;
  }
  return Object.hasOwn(manifest.scenes, sceneId) ? manifest.scenes[sceneId].title : undefined;
}
