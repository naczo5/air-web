/**
 * Static reachability gate for the story graph.
 *
 * `tools/air/routes.ts` explores routes by *replaying* the runtime, which is
 * faithful but slow (~20 s per walk, so a full sweep is hours). This fast check
 * answers the question that actually blocks a release — "can every ending be
 * reached from a title entry?" — using the scene graph instead of playback.
 *
 * It is deliberately independent of the flowchart: it walks `sceneTransitions`
 * over the decoded programs, so a generator regression cannot mask a missing
 * route.
 *
 *   npx tsx tools/air/reachability.ts          # human summary
 *   npx tsx tools/air/reachability.ts --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStoryScene, sceneTransitions, STORY_ENTRIES } from "./flowchart";
import type { GameManifest, SceneProgram } from "../../src/types";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(PROJECT_ROOT, ".air-web-assets", "manifest.json");

/**
 * Story endings, derived rather than hard-coded: a scene with no outgoing story
 * transition that is also never entered with a gosub (a gosub target returns to
 * its caller instead of ending the game).
 */
export function storyGraph(scenes: Record<string, SceneProgram>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const id of Object.keys(scenes)) {
    if (!isStoryScene(id)) continue;
    graph.set(id, sceneTransitions(scenes[id]).map((t) => t.sceneId).filter((t) => t in scenes && isStoryScene(t)));
  }
  return graph;
}

export function gosubTargets(scenes: Record<string, SceneProgram>): Set<string> {
  const targets = new Set<string>();
  for (const id of Object.keys(scenes)) {
    if (!isStoryScene(id)) continue;
    for (const transition of sceneTransitions(scenes[id])) {
      if (transition.gosub) targets.add(transition.sceneId);
    }
  }
  return targets;
}

export function endings(scenes: Record<string, SceneProgram>): string[] {
  const graph = storyGraph(scenes);
  const gosub = gosubTargets(scenes);
  return [...graph.entries()]
    .filter(([id, out]) => out.length === 0 && !gosub.has(id))
    .map(([id]) => id)
    .sort();
}

/** Breadth-first reachability from the three real title entries. */
export function reachableFrom(scenes: Record<string, SceneProgram>): Map<string, string | null> {
  const graph = storyGraph(scenes);
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const entry of STORY_ENTRIES) {
    if (entry.sceneId in scenes && !parent.has(entry.sceneId)) {
      parent.set(entry.sceneId, null);
      queue.push(entry.sceneId);
    }
  }
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, current);
      queue.push(next);
    }
  }
  return parent;
}

function main(): void {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Decoded assets are missing: ${MANIFEST}\nRun "npm run prepare:air" first.`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as GameManifest;
  const scenes = manifest.scenes as Record<string, SceneProgram>;
  const parent = reachableFrom(scenes);
  const graph = storyGraph(scenes);
  const storyEndings = endings(scenes);

  const rows = storyEndings.map((id) => {
    const path: string[] = [];
    let cursor: string | null | undefined = id;
    while (cursor) {
      path.unshift(cursor);
      cursor = parent.get(cursor) ?? null;
    }
    return { id, reachable: parent.has(id), path };
  });

  const unreachableScenes = [...graph.keys()].filter((id) => !parent.has(id));
  const unreachableEndings = rows.filter((row) => !row.reachable);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ storyScenes: graph.size, reachable: parent.size, endings: rows, unreachableScenes }, null, 2));
  } else {
    console.log(`story scenes: ${graph.size}  reachable: ${parent.size}`);
    console.log(`endings:      ${storyEndings.length}`);
    for (const row of rows) {
      console.log(`  ${row.reachable ? "OK  " : "MISS"} ${row.id}  (path ${row.path.length})`);
    }
    if (unreachableScenes.length) console.log(`unreachable scenes: ${unreachableScenes.join(" ")}`);
    console.log(
      unreachableEndings.length || unreachableScenes.length
        ? `FAIL: ${unreachableEndings.length} ending(s) and ${unreachableScenes.length} scene(s) unreachable`
        : "PASS: every story scene and ending is reachable from the title entries",
    );
  }
  if (unreachableEndings.length || unreachableScenes.length) process.exitCode = 1;
}

// Only run when invoked directly, so the exports stay importable by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
