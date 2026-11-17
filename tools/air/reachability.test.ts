import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { GameManifest, SceneProgram } from "../../src/types";
import { endings, reachableFrom, storyGraph } from "./reachability";

const MANIFEST = ".air-web-assets/manifest.json";
const available = fs.existsSync(MANIFEST);

/**
 * Route-coverage gate. The real dataset is required: the whole point is to
 * assert that the *shipped* story graph has no dead ends or orphan scenes, and
 * a synthetic fixture cannot prove that.
 */
describe.skipIf(!available)("story graph reachability", () => {
  const scenes = available
    ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as GameManifest).scenes as Record<string, SceneProgram>
    : {};

  it("reaches every story scene from the three title entries", () => {
    const graph = storyGraph(scenes);
    const reachable = reachableFrom(scenes);
    const unreachable = [...graph.keys()].filter((id) => !reachable.has(id));
    expect(unreachable).toEqual([]);
    expect(reachable.size).toBe(graph.size);
  });

  it("has the nine expected endings, all reachable", () => {
    const storyEndings = endings(scenes);
    // Derived, not curated. Pinned so a runtime or parser change that silently
    // makes a route terminal (or revives one) is caught.
    expect(storyEndings).toEqual([
      "seen0304", "seen0311", "seen0404", "seen0440", "seen0444",
      "seen0506", "seen0614", "seen0644", "seen0703",
    ]);
    const reachable = reachableFrom(scenes);
    for (const ending of storyEndings) expect(reachable.has(ending), `${ending} unreachable`).toBe(true);
  });

  it("gives every ending a path that starts at a real title entry", () => {
    const reachable = reachableFrom(scenes);
    const entries = new Set(["seen0170", "seen0700", "seen0163"]);
    for (const ending of endings(scenes)) {
      const path: string[] = [];
      let cursor: string | null | undefined = ending;
      while (cursor) {
        path.unshift(cursor);
        cursor = reachable.get(cursor) ?? null;
      }
      expect(path[0], `${ending} does not start at a title entry`).toBeTypeOf("string");
      expect(entries.has(path[0]), `${ending} starts at ${path[0]}, not a title entry`).toBe(true);
      // No cycles: a path longer than the graph means a loop was walked.
      expect(path.length).toBeLessThanOrEqual(reachable.size);
    }
  });
});
