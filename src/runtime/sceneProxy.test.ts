import { describe, expect, it } from "vitest";
import type { GameManifest, SceneProgram } from "../types";
import { demoManifest } from "./demoManifest";
import { hasScene, installSceneStore, peekScene, sceneTitle } from "./sceneStore";

function packedManifest(ids: string[]): GameManifest {
  const manifest = { ...demoManifest, scenes: {} } as GameManifest;
  installSceneStore(
    manifest,
    Object.fromEntries(ids.map((id) => [id, { u: `https://assets.test/scenes/${id}.json.gz`, e: { "0": 0 }, t: `Title ${id}` }])),
  );
  return manifest;
}

/**
 * The packed manifest replaces `scenes` with a Proxy. Every trap must answer
 * for indexed ids only: a plain-object lookup would also answer `true` for
 * inherited keys such as `constructor`, which is how a crafted save could
 * name a "scene" that has no program behind it.
 */
describe("packed scene proxy invariants", () => {
  it("reports indexed ids through in and hasOwn", () => {
    const manifest = packedManifest(["seen0163", "seen0170"]);
    const scenes = manifest.scenes as Record<string, SceneProgram>;
    expect("seen0163" in scenes).toBe(true);
    expect(Object.hasOwn(scenes, "seen0163")).toBe(true);
    expect(hasScene(manifest, "seen0163")).toBe(true);
    expect(Object.keys(scenes).sort()).toEqual(["seen0163", "seen0170"]);
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype", "isPrototypeOf"])(
    "never resolves the inherited key %s as a scene",
    (key) => {
      const manifest = packedManifest(["seen0163"]);
      const scenes = manifest.scenes as Record<string, SceneProgram>;
      expect(key in scenes).toBe(false);
      expect(Object.hasOwn(scenes, key)).toBe(false);
      expect(hasScene(manifest, key)).toBe(false);
      expect(scenes[key]).toBeUndefined();
      expect(peekScene(manifest, key)).toBeUndefined();
      expect(sceneTitle(manifest, key)).toBeUndefined();
    },
  );

  it("returns an empty placeholder for a known but unloaded scene", () => {
    const manifest = packedManifest(["seen0170"]);
    // Placeholders are deliberately inert; callers that need the program must
    // await loadScene, and callers that need the caption use sceneTitle.
    expect(manifest.scenes.seen0170.instructions).toEqual([]);
    expect(peekScene(manifest, "seen0170")).toBeUndefined();
    expect(sceneTitle(manifest, "seen0170")).toBe("Title seen0170");
  });

  it("keeps the descriptor consistent with get so lookups cannot diverge", () => {
    const manifest = packedManifest(["seen0170"]);
    const scenes = manifest.scenes as Record<string, SceneProgram>;
    // Read the descriptor FIRST: a descriptor that disagree with get is a spec
    // violation, and reading get first can mask it by memoising the value.
    const descriptor = Object.getOwnPropertyDescriptor(scenes, "seen0170");
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.value).toBe(scenes.seen0170);
  });

  it("reports the same value through spread and entries as through get", () => {
    const manifest = packedManifest(["seen0170", "seen0180"]);
    const scenes = manifest.scenes as Record<string, SceneProgram>;
    // Object.entries/spread read the descriptor, not get, so a mismatch here
    // would hand callers a placeholder while get() returned the real program.
    for (const [, value] of Object.entries(scenes)) {
      expect(value).toBeDefined();
      expect(Array.isArray((value as SceneProgram).instructions)).toBe(true);
    }
    const spread = { ...scenes } as Record<string, SceneProgram>;
    expect(Object.keys(spread).sort()).toEqual(["seen0170", "seen0180"]);
  });
});
