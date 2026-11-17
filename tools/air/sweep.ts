/**
 * Play every story scene headlessly and report what actually happened.
 *
 * The QA notes claim "the scene sweep reaches the same step/text/choice counts
 * and no new diagnostics". This is that harness, so the claim is reproducible
 * instead of asserted.
 *
 *   npx tsx tools/air/sweep.ts              # summary
 *   npx tsx tools/air/sweep.ts --json       # machine-readable
 *   npx tsx tools/air/sweep.ts --scene seen0170
 *
 * It needs the decoded assets (`.air-web-assets/manifest.json`) and never
 * writes to them. Story scenes are numbered below 9000; system scenes are
 * skipped. A first-choice policy is used so a run is deterministic.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AirRuntimeImpl } from "../../src/runtime/airRuntime";
import type { GameManifest } from "../../src/types";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(PROJECT_ROOT, ".air-web-assets", "manifest.json");
const MAX_STEPS = 4000;
/** Per-scene wall-clock budget; the engine honours real timers. */
const SCENE_BUDGET_MS = Number(process.env.SWEEP_BUDGET_MS ?? 15_000);

type SceneOutcome = {
  sceneId: string;
  steps: number;
  texts: number;
  choices: number;
  layeredAssets: number;
  endScene: string;
  waiting: string | undefined;
  diagnostics: string[];
};

async function runScene(manifest: GameManifest, sceneId: string, choice: number): Promise<SceneOutcome> {
  const runtime = new AirRuntimeImpl(manifest);
  const diagnostics = new Set<string>();
  const layered = new Set<string>();
  let texts = 0;
  let choices = 0;
  runtime.onEvent((event) => {
    if (event.type === "text") {
      texts += 1;
      for (const layer of runtime.state.layers) if (layer.asset) layered.add(layer.asset);
    } else if (event.type === "choice") {
      choices += 1;
    } else if (event.type === "diagnostic") {
      diagnostics.add(`${event.diagnostic.opcode ?? "?"}: ${event.diagnostic.message}`);
    }
  });

  runtime.load({
    sceneId,
    instructionPointer: 0,
    waiting: undefined,
    layers: [],
    textBuffer: "",
    backlog: [],
    audio: { effects: [], musicPositionMs: 0 },
    flags: {},
    variables: {},
    integerMemory: {},
    stringMemory: {},
    callStack: [],
    selectionHistory: [],
    viewedAssets: [],
    graphicsBuffers: {},
    objects: {},
    storeRegister: 0,
  });

  const started = Date.now();
  let steps = 0;
  while (steps < MAX_STEPS) {
    steps += 1;
    if (Date.now() - started > SCENE_BUDGET_MS) {
      diagnostics.add(`harness: scene exceeded ${SCENE_BUDGET_MS}ms budget after ${steps} steps`);
      break;
    }
    await runtime.advance();
    if (runtime.state.pendingChoice) {
      const options = runtime.state.pendingChoice.options;
      await runtime.choose(Math.min(choice, Math.max(0, options.length - 1)));
    }
    if (runtime.state.waiting === "end") break;
  }

  return {
    sceneId,
    steps,
    texts,
    choices,
    layeredAssets: layered.size,
    endScene: runtime.state.sceneId,
    waiting: runtime.state.waiting,
    diagnostics: [...diagnostics].sort(),
  };
}

async function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Decoded assets are missing: ${MANIFEST}\nRun "npm run prepare:air" with your own AIR_SE data first.`);
    process.exitCode = 1;
    return;
  }  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const onlyIndex = argv.indexOf("--scene");
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as GameManifest;
  const sceneIds = (only ? [only] : Object.keys(manifest.scenes).sort())
    .filter((id) => Number(id.replace(/^seen/, "")) < 9000);

  const outcomes: SceneOutcome[] = [];
  for (const sceneId of sceneIds) outcomes.push(await runScene(manifest, sceneId, 0));

  if (asJson) {
    console.log(JSON.stringify(outcomes, null, 2));
    return;
  }

  const totalTexts = outcomes.reduce((sum, row) => sum + row.texts, 0);
  const totalChoices = outcomes.reduce((sum, row) => sum + row.choices, 0);
  const stuck = outcomes.filter((row) => row.waiting === "end" && row.texts === 0);
  const withDiagnostics = outcomes.filter((row) => row.diagnostics.length);
  const noLayers = outcomes.filter((row) => row.layeredAssets === 0);

  console.log(`scenes swept:   ${outcomes.length}`);
  console.log(`text lines:     ${totalTexts}`);
  console.log(`choices:        ${totalChoices}`);
  console.log(`no text at all: ${stuck.length}${stuck.length ? ` (${stuck.slice(0, 5).map((r) => r.sceneId).join(", ")})` : ""}`);
  console.log(`no layered art: ${noLayers.length}${noLayers.length ? ` (${noLayers.slice(0, 8).map((r) => r.sceneId).join(", ")})` : ""}`);
  console.log(`diagnostics:    ${withDiagnostics.length}`);
  for (const row of withDiagnostics.slice(0, 10)) {
    console.log(`  ${row.sceneId}: ${row.diagnostics.join(" | ")}`);
  }
}

// `safeDelay` unrefs its timers, so a standalone script would let Node's event
// loop drain mid-advance and exit with an unsettled await. Hold it open.
const keepAlive = setInterval(() => undefined, 1000);
try {
  await main();
} finally {
  clearInterval(keepAlive);
}
