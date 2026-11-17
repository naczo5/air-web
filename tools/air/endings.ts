/**
 * Ending playback gate: drive every story ending to `waiting === "end"`.
 *
 * `reachability.ts` proves an ending is *reachable* from a title entry by
 * walking the scene graph. This proves each one actually *plays* — the runtime
 * executes the script, emits dialogue, and terminates cleanly, with no
 * diagnostics and no stray text.
 *
 * Each ending is entered from its real predecessor scene (found by scanning for
 * inbound scene transitions) rather than from a cold `load()` of the ending
 * itself, because several endings depend on state their predecessor sets.
 *
 *   npx tsx tools/air/endings.ts          # table, exit 1 on any failure
 *   npx tsx tools/air/endings.ts --json
 *
 * A full pass takes ~3-4 minutes on this box: the engine honours real timers,
 * and `seen0703` alone is 6,701 instructions over 845 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStoryScene, sceneTransitions } from "./flowchart";
import { endings } from "./reachability";
import { AirRuntimeImpl } from "../../src/runtime/airRuntime";
import type { GameManifest, RuntimeState, SceneProgram } from "../../src/types";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(PROJECT_ROOT, ".air-web-assets", "manifest.json");

/**
 * Endings that are only entered through a flag gate, and the flags that open
 * it. `seen0644` ("Dream and Reality") is reached from `seen0609:846` only when
 * `$5[504..506] == 1`, which requires having played the Minagi route; without
 * seeding them the predecessor takes its other branch to `seen0614` and the run
 * ends somewhere else entirely.
 */
const ENTRY_FLAGS: Record<string, Record<string, number>> = {
  seen0644: { "5:504": 1, "5:505": 1, "5:506": 1 },
};

/**
 * Enough advances for the longest ending (`seen0703`: 6,701 instructions, 845
 * lines). A smaller budget makes a long scene look like a stall — that mistake
 * once produced a false "this ending never terminates" report.
 */
const MAX_STEPS = 12_000;

export type EndingResult = {
  ending: string;
  entry: string;
  finalScene: string;
  waiting: string | undefined;
  lines: number;
  diagnostics: number;
  strayLines: number;
  /** Whether the run actually entered the ending under test. */
  reachedEnding: boolean;
  ok: boolean;
};

/** The scene that transitions into each ending, so state is set up first. */
export function predecessorOf(scenes: Record<string, SceneProgram>, ending: string): string {
  for (const id of Object.keys(scenes)) {
    if (!isStoryScene(id) || id === ending) continue;
    if (sceneTransitions(scenes[id]).some((transition) => transition.sceneId === ending)) return id;
  }
  return ending;
}

async function playEnding(manifest: GameManifest, ending: string): Promise<EndingResult> {
  const scenes = manifest.scenes as Record<string, SceneProgram>;
  const entry = predecessorOf(scenes, ending);
  const runtime = new AirRuntimeImpl(manifest);
  const diagnostics: string[] = [];
  runtime.onEvent((event) => {
    if (event.type === "diagnostic") diagnostics.push(event.diagnostic.message);
  });
  const seededFlags = ENTRY_FLAGS[ending] ?? {};
  runtime.load({
    sceneId: entry,
    instructionPointer: 0,
    waiting: undefined,
    layers: [],
    textBuffer: "",
    backlog: [],
    audio: { effects: [], musicPositionMs: 0 },
    flags: {},
    variables: {},
    integerMemory: { ...seededFlags },
    stringMemory: {},
    callStack: [],
    selectionHistory: [],
    viewedAssets: [],
    graphicsBuffers: {},
    storeRegister: 0,
    objects: {},
  } as unknown as RuntimeState);

  let lines = 0;
  let reachedEnding = false;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    await runtime.advance();
    if (runtime.state.pendingChoice) await runtime.choose(0);
    // Some endings are behind flag gates (`seen0644` needs $5[504..506] == 1),
    // and their predecessor also branches elsewhere. Reaching *an* end is not
    // enough — the run has to enter the ending under test.
    if (runtime.state.sceneId === ending) reachedEnding = true;
    if (runtime.state.waiting === "text") lines += 1;
    if (runtime.state.waiting === "end") break;
  }

  // A scene that leaks the message-loop error path writes "Error: ..." lines.
  const strayLines = runtime.state.backlog.filter((entryLine) => entryLine.text.startsWith("Error:")).length;
  return {
    ending,
    entry,
    finalScene: runtime.state.sceneId,
    waiting: runtime.state.waiting,
    lines,
    diagnostics: diagnostics.length,
    strayLines,
    reachedEnding,
    // Reaching a different scene's end is not a pass: the run must enter the
    // ending under test, otherwise a flag-gated branch silently checks the
    // wrong scene.
    ok: reachedEnding && runtime.state.waiting === "end" && diagnostics.length === 0 && strayLines === 0,
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Decoded assets are missing: ${MANIFEST}\nRun "npm run prepare:air" first.`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as GameManifest;
  const scenes = manifest.scenes as Record<string, SceneProgram>;

  const onlyIndex = process.argv.indexOf("--ending");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  const list = only ? [only] : endings(scenes);

  const results: EndingResult[] = [];
  for (const ending of list) results.push(await playEnding(manifest, ending));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(
        `${result.ok ? "OK  " : "FAIL"} ${result.ending} via ${result.entry}: ` +
        `->${result.finalScene} waiting=${result.waiting} lines=${result.lines} ` +
        `diagnostics=${result.diagnostics} stray=${result.strayLines}` +
        `${result.reachedEnding ? "" : "  (did not enter the ending)"}`,
      );
    }
    const failed = results.filter((result) => !result.ok);
    console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length} endings did not play cleanly` : `\nPASS: ${results.length}/${results.length} endings play to waiting === "end"`);
  }

  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    await main();
  } finally {
    clearInterval(keepAlive);
  }
}
