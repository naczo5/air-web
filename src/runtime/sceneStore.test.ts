import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameManifest, SceneProgram } from "../types";
import { AirRuntimeImpl } from "./airRuntime";
import { demoManifest } from "./demoManifest";
import { hasScene, installSceneStore, loadScene, peekScene, sceneEntrypoint } from "./sceneStore";

function manifestWith(scenes: Record<string, SceneProgram>): GameManifest {
  const manifest = { ...demoManifest, startScene: Object.keys(scenes)[0], scenes: {} } as GameManifest;
  installSceneStore(
    manifest,
    Object.fromEntries(Object.keys(scenes).map((id) => [id, { u: `https://assets.test/scenes/${id}.json.gz`, e: { "0": 0 } }])),
  );
  return manifest;
}

function mockFetchScenes(scenes: Record<string, SceneProgram>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const id = /scenes\/(.+)\.json\.gz$/.exec(url)?.[1];
    const scene = id ? scenes[id] : undefined;
    if (!scene) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const data = gzipSync(Buffer.from(JSON.stringify(scene)));
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sceneStore", () => {
  it("exposes known scene IDs without downloading them", () => {
    const manifest = manifestWith({ a: { id: "a", instructions: [] }, b: { id: "b", instructions: [] } });
    expect(Object.keys(manifest.scenes)).toEqual(["a", "b"]);
    expect(manifest.scenes.a).toBeTruthy();
    expect(peekScene(manifest, "a")).toBeUndefined();
    expect(hasScene(manifest, "a")).toBe(true);
    expect(hasScene(manifest, "missing")).toBe(false);
    expect(manifest.scenes.missing).toBeUndefined();
    expect(sceneEntrypoint(manifest, "a", 0)).toBe(0);
  });

  it("loads, caches, and dedupes gzipped scene programs", async () => {
    const scene: SceneProgram = { id: "a", instructions: [{ op: "text", text: "hello" }] };
    let release!: () => void;
    const mock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      const data = gzipSync(Buffer.from(JSON.stringify(scene)));
      return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    });
    vi.stubGlobal("fetch", mock);
    const manifest = manifestWith({ a: scene });
    const first = loadScene(manifest, "a");
    const second = loadScene(manifest, "a");
    await Promise.resolve();
    expect(mock).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(await second);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(peekScene(manifest, "a")).toMatchObject({ id: "a" });
    expect(manifest.scenes.a.instructions).toHaveLength(1);
  });

  it("rejects a scene that is not valid JSON data", async () => {
    const data = gzipSync(Buffer.from("null"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })));
    const manifest = manifestWith({ a: { id: "a", instructions: [] } });
    await expect(loadScene(manifest, "a")).rejects.toThrow(/not an object/);
  });

  it("lets AirRuntime cross into a lazy scene", async () => {
    const scenes: Record<string, SceneProgram> = {
      a: { id: "a", instructions: [{ op: "text", text: "A" }, { op: "scene", sceneId: "b" }] },
      b: { id: "b", instructions: [{ op: "text", text: "B" }, { op: "end" }] },
    };
    const mock = mockFetchScenes(scenes);
    const manifest = manifestWith(scenes);
    const runtime = new AirRuntimeImpl(manifest);
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("A");
    await runtime.advance();
    expect(runtime.state.sceneId).toBe("b");
    expect(runtime.state.backlog.at(-1)?.text).toBe("B");
    expect(mock).toHaveBeenCalled();
    expect(peekScene(manifest, "b")).toBeTruthy();
  });

  it("keeps save validation working before a scene is cached", () => {
    const scenes: Record<string, SceneProgram> = { a: { id: "a", instructions: [] }, b: { id: "b", instructions: [] } };
    mockFetchScenes(scenes);
    const manifest = manifestWith(scenes);
    const runtime = new AirRuntimeImpl(manifest);
    // `load` must accept a known-but-uncached scene without fetching it ...
    expect(() => runtime.load({ ...runtime.save(), sceneId: "b" })).not.toThrow();
    expect(() => runtime.load({ ...runtime.save(), sceneId: "nope" })).toThrow(/unknown scene/);
    // ... and the program must still be absent, i.e. validation did not fetch.
    expect(peekScene(manifest, "b")).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"])(
    "does not treat the prototype key %s as a known scene",
    (sceneId) => {
      const scenes: Record<string, SceneProgram> = { a: { id: "a", instructions: [] } };
      mockFetchScenes(scenes);
      const manifest = manifestWith(scenes);
      // A crafted save could name an inherited property; it must not resolve.
      expect(hasScene(manifest, sceneId)).toBe(false);
      expect(peekScene(manifest, sceneId)).toBeUndefined();
      const runtime = new AirRuntimeImpl(manifest);
      expect(() => runtime.load({ ...runtime.save(), sceneId })).toThrow(/unknown scene/);
    },
  );
});

describe("scene proxy descriptors", () => {
  it("returns the loaded program from the descriptor once a scene is cached", () => {
    // The original defect: `get` returned the cached program while the
    // descriptor built a fresh placeholder, so Object.entries/spread silently
    // saw an empty scene. Only a LOADED scene exposes it.
    const scenes: Record<string, SceneProgram> = {
      a: { id: "a", instructions: [{ op: "text", text: "line from a" }, { op: "end" }] },
      b: { id: "b", instructions: [{ op: "end" }] },
    };
    mockFetchScenes(scenes);
    const manifest = manifestWith(scenes);
    return loadScene(manifest, "a").then(() => {
      const proxy = manifest.scenes as Record<string, SceneProgram>;
      expect(peekScene(manifest, "a")).toBeDefined();
      const descriptor = Object.getOwnPropertyDescriptor(proxy, "a");
      expect(descriptor?.value).toBe(proxy.a);
      expect((descriptor?.value as SceneProgram).instructions.length).toBe(2);
      const spread = { ...proxy } as Record<string, SceneProgram>;
      expect(spread.a.instructions.length).toBe(2);
    });
  });
});

describe("scene cache bounds", () => {
  it("keeps only a bounded number of parsed scenes resident", async () => {
    // A long playthrough must not accumulate every visited program: the
    // largest scene is ~5 MiB of JSON and all 96 total ~116 MiB.
    const ids = Array.from({ length: 20 }, (_, index) => `s${index}`);
    const scenes: Record<string, SceneProgram> = Object.fromEntries(
      ids.map((id) => [id, { id, instructions: [{ op: "text" as const, text: id }] }]),
    );
    mockFetchScenes(scenes);
    const manifest = manifestWith(scenes);

    for (const id of ids) await loadScene(manifest, id);

    // Older programs are evicted, the most recent stay cached.
    expect(peekScene(manifest, ids[0])).toBeUndefined();
    expect(peekScene(manifest, ids.at(-1)!)).toBeDefined();
    const resident = ids.filter((id) => peekScene(manifest, id)).length;
    expect(resident).toBeLessThanOrEqual(8);

    // An evicted scene is still loadable: eviction must never lose the id.
    expect(await loadScene(manifest, ids[0])).toBeDefined();
    expect(peekScene(manifest, ids[0])).toBeDefined();
  });

  it("keeps a revisited scene resident instead of evicting it first", async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `r${index}`);
    const scenes: Record<string, SceneProgram> = Object.fromEntries(
      ids.map((id) => [id, { id, instructions: [{ op: "text" as const, text: id }] }]),
    );
    mockFetchScenes(scenes);
    const manifest = manifestWith(scenes);
    for (const id of ids) await loadScene(manifest, id);
    // Touch the oldest, then load a new one: the touched scene must survive.
    await loadScene(manifest, ids[0]);
    await loadScene(manifest, "r8").catch(() => undefined);
    expect(peekScene(manifest, ids[0])).toBeDefined();
  });
});
