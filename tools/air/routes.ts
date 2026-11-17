/**
 * Drive the runtime from every story entry until each ending is reached.
 *
 * `sweep.ts` replays every scene in isolation with a fixed first-choice
 * policy, which shows what a scene *can* do but never that an ending is
 * actually reachable from a title screen. This tool plays full routes: it
 * discovers the choice graph by branching the real runtime, then replays one
 * complete playthrough per ending from the documented entry scene so the
 * reported line/scene counts come from a genuine run, not from a synthetic
 * jump into the last scene.
 *
 *   npx tsx tools/air/routes.ts                 # table, exit non-zero on failure
 *   npx tsx tools/air/routes.ts --json          # machine-readable
 *   npx tsx tools/air/routes.ts --verbose       # per-step progress
 *   npx tsx tools/air/routes.ts --ending seen0311 --strict-timers
 *
 * Two deliberate harness simplifications, both recorded in the output so a
 * reader can reproduce the strict behaviour:
 *
 *  - Engine delays are collapsed to zero. `safeDelay` exists to pace text and
 *    fades; it never changes control flow. `--strict-timers` keeps the real
 *    millisecond waits (a full route then takes minutes instead of a second).
 *  - `backlog` and `selectionHistory` are trimmed after every step. They are
 *    presentation state: nothing in the story reads them (`1:4:1204/1205`,
 *    the return-to-previous-choice opcodes, occur zero times below `seen8000`),
 *    but the runtime deep-clones the whole state on every pause, so keeping
 *    them makes each line quadratic in route length. `--no-trim` disables it.
 *
 * Exit code is non-zero when the discovered ending set differs from the
 * manifest's, any ending is unreachable, or a playthrough stops without
 * reaching the ending cleanly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AirRuntimeImpl } from "../../src/runtime/airRuntime";
import type { FlowchartNode, GameManifest, RuntimeState, SceneProgram } from "../../src/types";
import { STORY_ENTRIES, isStoryScene, sceneTransitions } from "./flowchart";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(PROJECT_ROOT, ".air-web-assets", "manifest.json");

/**
 * Instruction budget for a single stretch between two pauses. A scene that
 * never pauses (a frame loop) trips this instead of hanging the run.
 */
const MAX_STEPS_PER_PAUSE = 200_000;

/** Instruction budget for one whole playthrough. */
const MAX_STEPS_PER_ROUTE = 2_000_000;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const asJson = flag("--json");
const verbose = flag("--verbose");
const strictTimers = flag("--strict-timers");
const noTrim = flag("--no-trim");
const onlyEnding = value("--ending");
const onlyEntry = value("--entry");
const BUDGET_MS = Number(value("--max-ms") ?? process.env.ROUTES_BUDGET_MS ?? 20 * 60_000);

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const overBudget = () => elapsed() > BUDGET_MS;

/**
 * Progress always goes to stderr, including under `--json`, so a two-minute
 * run is observable while stdout stays machine-readable.
 */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Collapse `safeDelay` to a microtask.
 *
 * This matters more than it looks: in `skip` mode the runtime awaits a
 * 25 ms delay after every text line, so a 5,800-line arc schedules 5,800
 * timers. Real macrotasks cost ~1.5 ms each here, which turns a 1.3 s walk
 * into 10 s and makes route exploration impossible in the budget. A microtask
 * keeps the same ordering (the delay still yields, so `runUntilPause` still
 * observes its own epoch checks) at a fraction of the cost.
 *
 * `--strict-timers` keeps the real millisecond delays for timing-sensitive
 * debugging. Either way the runtime unrefs its timers, so the keep-alive at
 * the bottom of this file is still required.
 */
if (!strictTimers) {
  (globalThis as { setTimeout: unknown }).setTimeout = (callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => callback());
    return { unref() {}, ref() {}, hasRef: () => false, refresh() {} };
  };
}

type Pause =
  | { kind: "choice"; sceneId: string; instruction: number; options: string[] }
  | { kind: "end"; sceneId: string }
  | { kind: "empty-choice"; sceneId: string; instruction: number }
  | { kind: "guard"; sceneId: string; instruction: number }
  | { kind: "error"; sceneId: string; message: string };

type ChoiceKey = string;

const positionOf = (sceneId: string, instruction: number): string => `${sceneId}@${instruction}`;
const keyOf = (sceneId: string, instruction: number): ChoiceKey => positionOf(sceneId, instruction);

type RoutePlayer = {
  runtime: AirRuntimeImpl;
  diagnostics: Map<string, { sceneId: string; instruction: number; opcode: string; message: string }>;
  /** Text lines emitted since the player was created. */
  readonly lines: number;
  /** Every scene the route has been in, in first-visit order. */
  readonly scenes: Set<string>;
  dispose: () => void;
};

/**
 * One runtime per exploration so a branch cannot inherit state from a sibling.
 * `startNewGame()` seeds the state with whatever fields the runtime currently
 * requires, so this harness never has to restate `RuntimeState` (it gained an
 * `objects` field mid-flight and a literal here silently stopped typechecking).
 */
function createPlayer(manifest: GameManifest, mode: "normal" | "skip" = "normal"): RoutePlayer {
  const runtime = new AirRuntimeImpl(manifest);
  const diagnostics = new Map<string, { sceneId: string; instruction: number; opcode: string; message: string }>();
  const scenes = new Set<string>();
  const counters = { lines: 0 };
  runtime.onEvent((event) => {
    if (event.type === "text") counters.lines += 1;
    else if (event.type === "diagnostic") {
      const key = `${event.diagnostic.sceneId}:${event.diagnostic.instructionPointer} ${event.diagnostic.opcode}`;
      diagnostics.set(key, {
        sceneId: event.diagnostic.sceneId,
        instruction: event.diagnostic.instructionPointer,
        opcode: event.diagnostic.opcode,
        message: event.diagnostic.message,
      });
    }
  });
  runtime.startNewGame();
  // `skip` makes the runtime collapse text pauses itself, which turns a
  // 5,800-line walk from 5,832 pauses into 5. Search only needs the control
  // flow, and `verify()` runs in `normal` mode so the counted pauses are real.
  if (mode !== "normal") runtime.setMode(mode);
  return {
    runtime,
    diagnostics,
    scenes,
    get lines() { return counters.lines; },
    dispose: () => runtime.dispose(),
  };
}

function trimPresentationState(runtime: AirRuntimeImpl): void {
  if (noTrim) return;
  // Presentation only: the backlog is the history panel, the selection history
  // backs `returnToPreviousChoice`. Neither is read by story bytecode.
  runtime.state.backlog.length = 0;
  runtime.state.selectionHistory.length = 0;
}

function startRoute(runtime: AirRuntimeImpl, entry: string): void {
  const mode = runtime.mode;
  runtime.startNewGame();
  runtime.setMode(mode);
  runtime.load({
    ...runtime.state,
    sceneId: entry,
    instructionPointer: 0,
    waiting: undefined,
    pendingChoice: undefined,
    callStack: [],
    selectionHistory: [],
    backlog: [],
    textBuffer: "",
  });
}

/** Advance until the runtime pauses: a choice, an ending, or a broken state. */
async function runToPause(runtime: AirRuntimeImpl, scenes: Set<string>): Promise<Pause> {
  scenes.add(runtime.state.sceneId);
  let steps = 0;
  for (;;) {
    if (steps++ > MAX_STEPS_PER_PAUSE) {
      return { kind: "guard", sceneId: runtime.state.sceneId, instruction: runtime.state.instructionPointer };
    }
    await runtime.advance();
    trimPresentationState(runtime);
    scenes.add(runtime.state.sceneId);
    if (runtime.state.waiting === "end") return { kind: "end", sceneId: runtime.state.sceneId };
    const choice = runtime.state.pendingChoice;
    if (choice) {
      const instruction = Math.max(0, runtime.state.instructionPointer - 1);
      if (!choice.options.length) return { kind: "empty-choice", sceneId: runtime.state.sceneId, instruction };
      return { kind: "choice", sceneId: runtime.state.sceneId, instruction, options: [...choice.options] };
    }
    // `advance()` returns immediately on `waiting === "choice"`, so a pending
    // choice without options would spin; the branch above already caught it.
    if (runtime.state.waiting === "choice") {
      return { kind: "error", sceneId: runtime.state.sceneId, message: "waiting === \"choice\" with no pendingChoice" };
    }
  }
}

async function choose(runtime: AirRuntimeImpl, index: number): Promise<void> {
  await runtime.choose(index);
  trimPresentationState(runtime);
}

/* ------------------------------------------------------------------ */
/* Ending enumeration                                                  */
/* ------------------------------------------------------------------ */

type EndingAudit = {
  /** Endings as recorded by the generated flowchart. */
  flowchart: string[];
  /** Story scenes with no outgoing story transition. */
  noExit: string[];
  /** Same, excluding scenes that are only ever entered with a gosub (`return` follows). */
  noExitNotGosubTarget: string[];
  /** Scenes entered by a gosub somewhere, so a missing exit is a `return`, not an ending. */
  gosubTargets: string[];
  /** Endings whose only incoming transitions are gosubs: not a route terminus. */
  gosubOnlyEndings: string[];
  /** Endings with at least one plain `goto`/`1:1:11` into them. */
  enteredByGoto: Record<string, string[]>;
  /** Story scenes with no incoming story transition at all. */
  orphans: string[];
  /** Transition targets that are not in the manifest. */
  missingTargets: string[];
};

function endingAudit(manifest: GameManifest): EndingAudit & { authoritative: string[] } {
  const scenes = manifest.scenes;
  const storyIds = Object.keys(scenes).filter(isStoryScene).sort();
  const story = new Set(storyIds);

  const gosubTargets = new Set<string>();
  const incoming = new Map<string, Array<{ from: string; gosub: boolean }>>();
  const missingTargets: string[] = [];
  for (const sceneId of storyIds) {
    const program = scenes[sceneId] as SceneProgram | undefined;
    if (!program || !Array.isArray(program.instructions)) {
      missingTargets.push(`${sceneId}: scene program missing`);
      continue;
    }
    for (const transition of sceneTransitions(program)) {
      const list = incoming.get(transition.sceneId) ?? [];
      list.push({ from: sceneId, gosub: transition.gosub });
      incoming.set(transition.sceneId, list);
      if (transition.gosub) gosubTargets.add(transition.sceneId);
      if (!Object.hasOwn(scenes, transition.sceneId)) missingTargets.push(`${sceneId} -> ${transition.sceneId}`);
    }
  }

  // A story scene with no story exit is where a route stops -- unless it is
  // only ever entered with a gosub, in which case its missing exit is a
  // `return` to the caller and it is a sub-scene, not an ending.
  const noExit = storyIds.filter((id) => {
    const program = scenes[id] as SceneProgram;
    if (!program || !Array.isArray(program.instructions)) return false;
    return sceneTransitions(program).every((transition) => !story.has(transition.sceneId));
  });
  const noExitNotGosubTarget = noExit.filter((id) => !gosubTargets.has(id));
  const flowchart = (manifest.flowchart?.nodes ?? [])
    .filter((node: FlowchartNode) => node.kind === "ending")
    .map((node) => node.sceneId)
    .sort();
  const orphans = storyIds.filter((id) => !incoming.has(id) && !STORY_ENTRIES.some((entry) => entry.sceneId === id));

  const gosubOnlyEndings = noExit.filter((id) => {
    const list = incoming.get(id) ?? [];
    return list.length > 0 && list.every((item) => item.gosub);
  });
  const enteredByGoto: Record<string, string[]> = {};
  for (const id of noExit) {
    const plain = (incoming.get(id) ?? []).filter((item) => !item.gosub).map((item) => item.from);
    if (plain.length) enteredByGoto[id] = plain.sort();
  }

  // The authoritative set mirrors buildFlowchart: no story exit and not a
  // gosub sub-scene. Both derivations must agree or the chart lies.
  const authoritative = noExitNotGosubTarget;
  return { flowchart, noExit, noExitNotGosubTarget, gosubTargets: [...gosubTargets].sort(), gosubOnlyEndings, enteredByGoto, orphans, missingTargets, authoritative };
}

/* ------------------------------------------------------------------ */
/* Discovery: mutate known routes until every ending is witnessed      */
/* ------------------------------------------------------------------ */

type EntryRoot = {
  entry: string;
  /** State with the first choice pending. */
  state?: RuntimeState;
  /** Set when the entry reaches its ending without any choice. */
  endsAt?: string;
};

/** One choice pause on a playthrough, with the state to resume from it. */
type Visit = { position: string; options: number; state: RuntimeState };

type Walk = {
  /** Pauses passed through, including the one the walk started from. */
  visits: Visit[];
  /** Option taken at each pause, in order. */
  picks: number[];
  end: string;
  /** Distinct scenes entered, including the one the walk started from. */
  scenes: string[];
  guard?: string;
};

/** A complete playthrough, identified by the options it takes. */
type Route = {
  entry: string;
  picks: number[];
  visits: Visit[];
  end: string;
  /** Distinct scenes the route entered. */
  scenes: string[];
};

type Discovery = {
  /** ending -> the first route that reached it. */
  witness: Map<string, Route>;
  routes: Route[];
  /** Options evaluated, i.e. routes walked. */
  walks: number;
  budgetExhausted: boolean;
  /** Every ending scene any route reached, in discovery order. */
  endingsSeen: string[];
  /** Scenes any route entered, and the scenes reached in every route's last pause. */
  covered: Set<string>;
  /** Every pause position any route passed through, with the options offered. */
  pauses: Map<string, number>;
};

/**
 * The integer cell and flag contents that decide every branch.
 *
 * `evaluateInteger` in `src/runtime/airRuntime.ts` reads only `storeRegister`,
 * `integerMemory` and string memory; every `branch` in the shipped bytecode
 * compares integers, so two pauses with the same position and the same
 * integers have identical futures. That makes this an exact key for caching
 * and for deciding that a mutant re-joined the route it came from.
 */
function fingerprint(state: RuntimeState): string {
  const memory = state.integerMemory ?? {};
  const cells = Object.keys(memory)
    .filter((key) => memory[key] !== 0)
    .sort()
    .map((key) => `${key}=${memory[key]}`);
  const flags = Object.entries(state.flags ?? {})
    .filter(([, value]) => Boolean(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value === true ? 1 : String(value)}`);
  return `${cells.join(",")}|${flags.join(",")}|${state.storeRegister}`;
}

/**
 * Walk each entry to its first pause once. `seen0700` runs ~5,800 lines before
 * it ever offers a choice, so doing this per ending would dominate the run.
 */
async function entryRoots(runtime: AirRuntimeImpl, entries: string[]): Promise<EntryRoot[]> {
  const roots: EntryRoot[] = [];
  for (const entry of entries) {
    startRoute(runtime, entry);
    const pause = await runToPause(runtime, new Set());
    if (pause.kind === "end") roots.push({ entry, endsAt: pause.sceneId });
    else if (pause.kind === "choice") roots.push({ entry, state: runtime.save() });
    else log(`  ${entry}: did not reach a choice (${pause.kind} at ${pause.sceneId})`);
  }
  return roots;
}

/**
 * Continue the pending route to its end, taking `picks` at successive pauses
 * and option 0 after they run out.
 *
 * `expected` is the route this walk branched from: as soon as the walk reaches
 * the same pause with the same integer state, it has re-joined that route and
 * the rest of it -- including its ending -- is already known. Most cosmetic
 * choice flips re-join immediately, which is what keeps the search affordable.
 */
async function continueRoute(
  runtime: AirRuntimeImpl,
  picks: number[] = [],
  expected?: Visit[],
): Promise<Walk> {
  const visits: Visit[] = [];
  const taken: number[] = [];
  const scenes = new Set<string>([runtime.state.sceneId]);
  for (;;) {
    const pause = await runToPause(runtime, scenes);
    if (pause.kind === "end") return { visits, picks: taken, end: pause.sceneId, scenes: [...scenes] };
    if (pause.kind !== "choice") return { visits, picks: taken, end: runtime.state.sceneId, scenes: [...scenes], guard: `${pause.kind} at ${pause.sceneId}` };
    const position = positionOf(pause.sceneId, pause.instruction);
    const state = runtime.save();
    const twin = expected?.[visits.length];
    if (twin && twin.position === position && fingerprint(state) === fingerprint(twin.state)) {
      // Re-joined: the remaining picks and the ending are the parent's.
      return {
        visits: [...visits, ...expected!.slice(visits.length)],
        picks: [...taken, ...expected!.slice(visits.length).map(() => 0)],
        end: "__converged__",
        scenes: [...scenes],
      };
    }
    visits.push({ position, options: pause.options.length, state });
    const option = Math.min(Math.max(picks[visits.length - 1] ?? 0, 0), pause.options.length - 1);
    taken.push(option);
    await choose(runtime, option);
  }
}

const routeKey = (entry: string, picks: number[]): string => `${entry}|${picks.join(",")}`;

/**
 * Discover a route to every ending by mutating the routes already known.
 *
 * A breadth-first search over choice *paths* is exponential (a route has ~50
 * pauses with ~2 options each), and the story does not gate endings on most of
 * them: flipping a single choice anywhere except the real branch point leaves
 * the ending untouched. So the search walks one baseline route per entry, then
 * tries every single-choice mutation of a route it already has, mutating again
 * only from the mutants that actually changed the ending. Each round costs one
 * partial walk per pause, and rounds stop as soon as every ending is found.
 */
async function exploreRoutes(
  runtime: AirRuntimeImpl,
  roots: EntryRoot[],
  targets: Set<string>,
): Promise<Discovery> {
  const witness = new Map<string, Route>();
  const routes: Route[] = [];
  const endingsSeen: string[] = [];
  const visited = new Set<string>();
  let walks = 0;
  let budgetExhausted = false;
  const pauses = new Map<string, number>();

  /** Scenes any route has entered, so "this route opens somewhere new" is answerable. */
  const covered = new Set<string>();

  const record = (route: Route): { fresh: boolean; scenes: number } => {
    if (visited.has(routeKey(route.entry, route.picks))) return { fresh: false, scenes: 0 };
    visited.add(routeKey(route.entry, route.picks));
    routes.push(route);
    let freshScenes = 0;
    for (const scene of route.scenes) {
      if (covered.has(scene)) continue;
      covered.add(scene);
      freshScenes += 1;
    }
    if (!endingsSeen.includes(route.end)) endingsSeen.push(route.end);
    if (targets.has(route.end) && !witness.has(route.end)) {
      witness.set(route.end, route);
      log(`  ${route.end}: found via ${route.entry} with ${route.picks.filter((pick) => pick !== 0).length} non-default choice(s) (${walks} walks, ${(elapsed() / 1000).toFixed(1)}s)`);
    }
    return { fresh: true, scenes: freshScenes };
  };

  // Round 0: the route a player who always picks the first option sees.
  const frontier: Route[] = [];
  for (const root of roots) {
    if (root.endsAt !== undefined) {
      const first = record({ entry: root.entry, picks: [], visits: [], end: root.endsAt, scenes: [root.endsAt] });
      if (first.fresh) frontier.push({ entry: root.entry, picks: [], visits: [], end: root.endsAt, scenes: [root.endsAt] });
      continue;
    }
    if (!root.state) continue;
    walks += 1;
    // Start from this entry's own first pause. Without the load the runtime is
    // still sitting in whichever entry was walked last, and every "route" in
    // round 0 belongs to the wrong arc.
    runtime.load(root.state);
    const walk = await continueRoute(runtime, []);
    const route: Route = { entry: root.entry, picks: walk.picks, visits: walk.visits, end: walk.end, scenes: walk.scenes };
    if (record(route).fresh) frontier.push(route);
  }

  let round = 0;
  while (frontier.length && !budgetExhausted) {
    if ([...targets].every((ending) => witness.has(ending))) break;
    if (overBudget()) { budgetExhausted = true; break; }
    round += 1;
    const discovered: Route[] = [];
    log(`round ${round}: mutating ${frontier.length} route(s) (${[...targets].filter((ending) => !witness.has(ending)).length} ending(s) outstanding)`);
    for (const route of frontier) {
      // Mutate from the last pause backwards: the latest decision is the one
      // that most often decides the ending.
      for (let index = route.visits.length - 1; index >= 0; index -= 1) {
        if ([...targets].every((ending) => witness.has(ending))) break;
        if (overBudget()) { budgetExhausted = true; break; }
        const visit = route.visits[index];
        for (let option = 0; option < visit.options; option += 1) {
          if (option === route.picks[index]) continue;
          if (overBudget()) { budgetExhausted = true; break; }
          walks += 1;
          runtime.load(visit.state);
          await choose(runtime, option);
          const walk = await continueRoute(runtime, [], route.visits.slice(index + 1));
          const end = walk.end === "__converged__" ? route.end : walk.end;
          if (verbose) {
            log(`    ${route.entry}: ${visit.position}#${option} -> ${end}${walk.end === "__converged__" ? " (rejoined)" : ""}, ${walks} walks, ${(elapsed() / 1000).toFixed(1)}s`);
          }
          const picks = [...route.picks.slice(0, index), option, ...walk.picks];
          const mutant: Route = {
            entry: route.entry,
            picks,
            visits: [...route.visits.slice(0, index), visit, ...walk.visits],
            end,
            scenes: [...new Set([...route.scenes.slice(0, index + 1), ...walk.scenes])],
          };
          // Record even when the ending is unchanged: a mutant that opens a
          // scene no route had entered is worth mutating further, and that is
          // exactly how the branch scenes for the unreached arcs are found.
          const outcome = record(mutant);
          if (outcome.fresh && (end !== route.end || outcome.scenes > 0)) discovered.push(mutant);
        }
      }
    }
    // Keep one route per ending -- mutants sharing an ending differ only in
    // cosmetic choices, so keeping them all would multiply the next round for
    // no new coverage -- plus every route that opened a scene no route had
    // entered yet. That second rule is what keeps a route alive after it stops
    // producing endings: the branch scenes for the Kano/Minagi routes sit
    // behind transitions a cosmetic mutant never crosses.
    const representative = new Map<string, Route>();
    const weight = (route: Route) => route.picks.filter((pick) => pick !== 0).length;
    for (const mutant of discovered) {
      const current = representative.get(mutant.end);
      if (!current || weight(mutant) < weight(current)) representative.set(mutant.end, mutant);
    }
    frontier.length = 0;
    frontier.push(...representative.values());
    log(`round ${round}: ${discovered.length} route(s) changed the ending; endings so far: ${endingsSeen.join(", ")} (${walks} walks, ${(elapsed() / 1000).toFixed(1)}s)`);
  }

  for (const route of routes) for (const visit of route.visits) if (!pauses.has(visit.position)) pauses.set(visit.position, visit.options);
  return { witness, routes, walks, budgetExhausted, endingsSeen, covered, pauses };
}

/* ------------------------------------------------------------------ */
/* Blocker analysis: why an ending was not reached                     */
/* ------------------------------------------------------------------ */

type Blocker = {
  ending: string;
  /** Scene the route must reach, and the scenes that transition into it. */
  requiredScenes: string[];
  /** First transition on the way in whose guard no explored route satisfied. */
  gate?: {
    from: string;
    instruction: number;
    target: string;
    /** Memory cells the guarding branch tests, with the values it compares to. */
    cells: Array<{ cell: string; values: number[] }>;
    /** Values those cells held on the best route that got closest. */
    actual: Record<string, number | undefined>;
  };
  /** Scenes the search never entered, on the path into the ending. */
  unseen: string[];
  /** Pause positions on the best route where the search also tried the other options. */
  stalledAt?: string;
  note?: string;
};

/** Cells a branch condition reads, with the constants it compares them to. */
function branchCells(expression: unknown): Array<{ cell: string; values: number[] }> {
  const found = new Map<string, Set<number>>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { kind?: string; bank?: number; index?: unknown; left?: unknown; right?: unknown; value?: unknown };
    if (value.kind === "binary") {
      // `memory op const` (or `const op memory`) -- the shape every guard uses.
      const collect = (left: unknown, right: unknown) => {
        const memory = left as { kind?: string; bank?: number; index?: { kind?: string; value?: unknown } } | undefined;
        const literal = right as { kind?: string; value?: unknown } | undefined;
        if (memory?.kind === "memory" && typeof memory.bank === "number" && memory.index?.kind === "int"
          && literal?.kind === "int" && typeof literal.value === "number") {
          const cell = `${memory.bank}:${memory.index.value}`;
          const values = found.get(cell) ?? new Set<number>();
          values.add(literal.value);
          found.set(cell, values);
        }
      };
      collect(value.left, value.right);
      collect(value.right, value.left);
      visit(value.left);
      visit(value.right);
      return;
    }
    if (value.kind === "unary") visit(value.value);
  };
  visit(expression);
  return [...found.entries()].map(([cell, values]) => ({ cell, values: [...values].sort((a, b) => a - b) }));
}

/**
 * Explain why an ending was not reached, from the bytecode plus what the search
 * actually visited.
 *
 * The search proves reachability; it cannot by itself say whether a failure is
 * its own limitation or a real block. This narrows it down: it takes the
 * backward path into the ending over story transitions until it meets a scene
 * the search did enter, and reports the guarding branch at the boundary.
 */
function explainBlocker(
  manifest: GameManifest,
  discovery: Discovery,
  ending: string,
): Blocker {
  const scenes = manifest.scenes;
  const story = new Set(Object.keys(scenes).filter(isStoryScene));

  // Transitions into each scene, with the branch that guards them.
  const incoming = new Map<string, Array<{ from: string; instruction: number; cells: Array<{ cell: string; values: number[] }> }>>();
  for (const sceneId of story) {
    const program = scenes[sceneId] as SceneProgram | undefined;
    if (!program || !Array.isArray(program.instructions)) continue;
    const instructions = program.instructions;
    instructions.forEach((instruction, index) => {
      if (instruction.op !== "command" || instruction.moduleType !== 0 || instruction.module !== 1) return;
      if (![11, 12, 18].includes(instruction.opcode)) return;
      const first = instruction.args?.[0];
      const number = first?.kind === "expression" && first.value?.kind === "int" ? first.value.value : undefined;
      if (number === undefined) return;
      const target = `seen${String(number).padStart(4, "0")}`;
      if (!story.has(target)) return;
      // Nearest preceding conditional branch that skips this transition.
      let guard: { cells: Array<{ cell: string; values: number[] }> } | undefined;
      for (let cursor = index - 1; cursor >= Math.max(0, index - 40); cursor -= 1) {
        const candidate = instructions[cursor];
        if (candidate.op !== "branch" || !candidate.expression || !candidate.kind.startsWith("goto") || candidate.kind.startsWith("gosub")) continue;
        if (!candidate.targets.length || candidate.targets[0] <= index) continue;
        guard = { cells: branchCells(candidate.expression) };
        break;
      }
      const list = incoming.get(target) ?? [];
      list.push({ from: sceneId, instruction: index, cells: guard?.cells ?? [] });
      incoming.set(target, list);
    });
  }

  // Walk backward until a scene the search entered.
  const unseen: string[] = [];
  let cursor = ending;
  let boundary: { from: string; instruction: number; target: string } | undefined;
  const visited = new Set<string>([cursor]);
  for (let depth = 0; depth < 24; depth += 1) {
    const sources = incoming.get(cursor) ?? [];
    const entered = sources.find((source) => discovery.covered.has(source.from));
    if (entered) {
      boundary = { from: entered.from, instruction: entered.instruction, target: cursor };
      break;
    }
    if (!sources.length) break;
    const next = sources[0];
    unseen.push(next.from);
    if (visited.has(next.from)) break;
    visited.add(next.from);
    cursor = next.from;
  }

  const blocker: Blocker = {
    ending,
    requiredScenes: [...new Set(unseen)].reverse(),
    unseen: [...new Set(unseen)],
  };

  if (boundary) {
    const source = (incoming.get(boundary.target) ?? []).find((item) => item.from === boundary!.from);
    // Values the cells held on the closest route that reached the boundary scene.
    const best = discovery.routes.find((route) => route.scenes.includes(boundary!.from));
    const actual: Record<string, number | undefined> = {};
    for (const entry of source?.cells ?? []) {
      actual[entry.cell] = best ? best.visits.at(-1)?.state.integerMemory[entry.cell] : undefined;
    }
    blocker.gate = { ...boundary, cells: source?.cells ?? [], actual };
  }

  if (!blocker.gate) {
    const enteredAny = discovery.covered.has(ending);
    blocker.note = enteredAny
      ? "the scene was entered but no route ended there"
      : "no explored route reached any scene on the way in";
  } else if (!blocker.gate.cells.length) {
    blocker.note = `reached ${blocker.gate.from} but never took the transition at instruction ${blocker.gate.instruction}`;
  } else {
    blocker.note = `the transition at ${blocker.gate.from}:${blocker.gate.instruction} is gated on ${blocker.gate.cells
      .map((cell) => `${cell.cell} == ${cell.values.join("/")}`)
      .join(" && ")}`;
  }
  return blocker;
}

/* ------------------------------------------------------------------ */
/* Verification: replay one full playthrough per ending                 */
/* ------------------------------------------------------------------ */

type Playthrough = {
  ending: string;
  entry: string;
  reached: boolean;
  /** Text lines actually emitted on this route. */
  lines: number;
  distinctScenes: number;
  sceneChain: string[];
  choices: Array<{ key: ChoiceKey; options: number; picked: number }>;
  endedAt: string;
  /** True when `waiting === "end"` was observed on the target scene itself. */
  clean: boolean;
  diagnostics: Array<{ sceneId: string; instruction: number; opcode: string; message: string }>;
  steps: number;
  durationMs: number;
  failure?: string;
};

async function verify(manifest: GameManifest, ending: string, plan: { entry: string; path: Array<[ChoiceKey, number]> }): Promise<Playthrough> {
  const player = createPlayer(manifest);
  const runtime = player.runtime;
  const scenes = player.scenes;
  startRoute(runtime, plan.entry);
  const sceneChain: string[] = [runtime.state.sceneId];
  const choices: Array<{ key: ChoiceKey; options: number; picked: number }> = [];
  const begin = Date.now();
  let steps = 0;
  let failure: string | undefined;
  let clean = false;
  const planned = [...plan.path];

  for (;;) {
    if (++steps > MAX_STEPS_PER_ROUTE) { failure = "route exceeded the instruction budget"; break; }
    if (elapsed() > BUDGET_MS) { failure = "wall-clock budget exhausted"; break; }
    const pause = await runToPause(runtime, scenes);
    if (sceneChain.at(-1) !== runtime.state.sceneId) sceneChain.push(runtime.state.sceneId);
    if (pause.kind === "end") {
      clean = runtime.state.waiting === "end";
      if (pause.sceneId !== ending) failure = `route ended at ${pause.sceneId}, expected ${ending}`;
      break;
    }
    if (pause.kind === "choice") {
      const key = keyOf(pause.sceneId, pause.instruction);
      const next = planned.shift();
      if (!next) { failure = `unplanned choice at ${key} after the witness path ran out`; break; }
      if (next[0] !== key) { failure = `witness expected ${next[0]} but reached ${key}`; break; }
      choices.push({ key, options: pause.options.length, picked: next[1] });
      await choose(runtime, next[1]);
      continue;
    }
    // Every pause kind is handled above, so the remaining cases are failures.
    failure = pause.kind === "guard"
      ? `instruction guard at ${pause.sceneId}:${pause.instruction}`
      : pause.kind === "empty-choice"
        ? `choice with no options at ${pause.sceneId}:${pause.instruction}`
        : pause.message;
    break;
  }

  const reached = !failure && runtime.state.sceneId === ending && runtime.state.waiting === "end";
  if (!failure && planned.length) failure = `witness path had ${planned.length} unused choice(s)`;
  player.dispose();
  return {
    ending,
    entry: plan.entry,
    reached: Boolean(reached),
    lines: player.lines,
    distinctScenes: scenes.size,
    sceneChain,
    choices,
    endedAt: runtime.state.sceneId,
    clean,
    diagnostics: [...player.diagnostics.values()],
    steps,
    durationMs: Date.now() - begin,
    ...(failure ? { failure } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Static checks that do not need the runtime                          */
/* ------------------------------------------------------------------ */

type StaticFinding = { kind: string; detail: string };

function staticChecks(manifest: GameManifest, audit: EndingAudit): StaticFinding[] {
  const findings: StaticFinding[] = [];
  const scenes = manifest.scenes;
  const storyIds = Object.keys(scenes).filter(isStoryScene).sort();

  for (const missing of audit.missingTargets) findings.push({ kind: "missing-scene", detail: missing });
  for (const orphan of audit.orphans) findings.push({ kind: "orphan-scene", detail: `${orphan} has no incoming story transition and is not a story entry` });
  for (const ending of audit.gosubOnlyEndings) {
    findings.push({ kind: "gosub-only-ending", detail: `${ending} has no story exit but is only entered with a gosub, so it returns instead of ending` });
  }

  // A `select` with a target outside its own scene, or an option list that
  // disagrees with the branch chain that reads the store register, would land
  // the program mid-instruction or on the wrong branch.
  for (const sceneId of storyIds) {
    const program = scenes[sceneId];
    if (!program || !Array.isArray(program.instructions)) continue;
    program.instructions.forEach((instruction, index) => {
      if (instruction.op !== "select" && instruction.op !== "choice") return;
      const options = instruction.op === "select" ? instruction.options : instruction.options;
      if (!options.length) findings.push({ kind: "empty-choice", detail: `${sceneId}:${index} offers no options` });
      if (instruction.op === "choice") {
        for (const target of instruction.targets) {
          if (!Number.isInteger(target) || target < 0 || target >= program.instructions.length) {
            findings.push({ kind: "bad-choice-target", detail: `${sceneId}:${index} target ${target} is outside the scene` });
          }
        }
      }
      if (instruction.op === "select") {
        const select = instruction as Extract<typeof instruction, { op: "select" }>;
        // The runtime copies the *enabled* option's index into the store
        // register, and the following `gotoUnless` chain compares it against
        // small integers. An option index that no branch tests falls into the
        // chain's fallthrough, which is legal but worth surfacing.
        const seen = new Set<number>();
        for (let cursor = index + 1; cursor < Math.min(index + 8, program.instructions.length); cursor += 1) {
          const next = program.instructions[cursor];
          if (next.op !== "branch") continue;
          for (const condition of next.cases ?? []) {
            if (condition?.kind === "int") seen.add(condition.value);
          }
        }
        if (seen.size && select.options.length > seen.size) {
          findings.push({ kind: "choice-branch-mismatch", detail: `${sceneId}:${index} has ${select.options.length} options but ${seen.size} tested store values` });
        }
      }
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/* The driver lives in `run()` so the keep-alive at the bottom can wrap it. */
async function run(): Promise<number> {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Decoded assets are missing: ${MANIFEST}\nRun "npm run prepare:air" with your own AIR_SE data first.`);
    return 1;
  }
  const loadStart = Date.now();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as GameManifest;
  log(`manifest loaded in ${Date.now() - loadStart}ms (${Object.keys(manifest.scenes).length} scenes)`);

  const titles: Record<string, string> = {};
  for (const node of manifest.flowchart?.nodes ?? []) if (node.kind === "ending") titles[node.sceneId] = node.label;

  const audit = endingAudit(manifest);
  const expected = onlyEnding ? [onlyEnding] : audit.authoritative;
  const setMatches = audit.authoritative.join(",") === audit.flowchart.join(",");
  log(`endings: ${expected.length} (${expected.join(", ")})`);
  log(setMatches ? "flowchart ending set matches the derived set" : `FLOWCHART MISMATCH: chart=[${audit.flowchart}] derived=[${audit.authoritative}]`);

  const findings = staticChecks(manifest, audit);
  for (const finding of findings) log(`static: ${finding.kind}: ${finding.detail}`);

  const entries = STORY_ENTRIES.map((entry) => entry.sceneId).filter((id) => (onlyEntry ? id === onlyEntry : true));
  const searchRuntime = createPlayer(manifest, "skip");
  log(`\nwalking entries to their first choice, from ${entries.join(", ")} ...`);
  const roots = await entryRoots(searchRuntime.runtime, entries);
  for (const root of roots) log(`  ${root.entry}: ${root.endsAt ? `ends at ${root.endsAt}` : `first choice at ${root.state?.sceneId}`}`);
  log(`\nexploring routes ...`);
  const discovery = await exploreRoutes(searchRuntime.runtime, roots, new Set(expected));
  log(`exploration: ${discovery.walks} walks, ${discovery.routes.length} distinct routes, ${discovery.witness.size}/${expected.length} endings (${(elapsed() / 1000).toFixed(1)}s)${discovery.budgetExhausted ? " (BUDGET HIT)" : ""}`);

  const playthroughs: Playthrough[] = [];
  const searches = expected.map((ending) => {
    const route = discovery.witness.get(ending);
    return {
      ending,
      entry: route?.entry,
      choices: route?.picks.length ?? 0,
      nonDefault: route ? route.picks.filter((pick) => pick !== 0).length : 0,
      found: Boolean(route),
    };
  });
  const budgetHit = discovery.budgetExhausted;

  const blockers: Blocker[] = [];
  for (const ending of expected) {
    const route = discovery.witness.get(ending);
    if (!route) {
      const blocker = explainBlocker(manifest, discovery, ending);
      blockers.push(blocker);
      playthroughs.push({
        ending, entry: "-", reached: false, lines: 0, distinctScenes: 0, sceneChain: [], choices: [],
        endedAt: "-", clean: false, diagnostics: [], steps: 0, durationMs: 0,
        failure: blocker.note ?? "no choice path reaches this ending",
      });
      log(`  ${ending}: UNREACHABLE — ${blocker.note}`);
      if (blocker.unseen.length) log(`      via ${blocker.unseen.slice(0, 4).join(" <- ")} <- ${ending}`);
      continue;
    }
    log(`  ${ending}: replaying ${route.picks.length} choice(s) from ${route.entry} ...`);
    const result = await verify(manifest, ending, { entry: route.entry, path: route.visits.map((visit, index) => [visit.position, route.picks[index]] as [string, number]) });
    playthroughs.push(result);
    log(`  ${ending}: ${result.reached ? "reached" : "FAILED"} ${result.lines} lines, ${result.distinctScenes} scenes, ${result.diagnostics.length} diagnostics${result.failure ? ` — ${result.failure}` : ""} (${(result.durationMs / 1000).toFixed(1)}s)`);
  }
  searchRuntime.dispose();

  const unreached = playthroughs.filter((row) => !row.reached);
  const unclean = playthroughs.filter((row) => !row.clean);
  const withDiagnostics = playthroughs.filter((row) => row.diagnostics.length);
  const unverified = expected.filter((ending) => !playthroughs.some((row) => row.ending === ending));
  const ok = setMatches && !unreached.length && !unclean.length && !withDiagnostics.length && !unverified.length && !audit.missingTargets.length;

  if (asJson) {
    console.log(JSON.stringify({
      ok,
      generatedAt: new Date().toISOString(),
      harness: {
        budgetMs: BUDGET_MS,
        strictTimers,
        trimPresentationState: !noTrim,
        elapsedMs: elapsed(),
        searches,
        endingsSeen: discovery.endingsSeen,
        walks: discovery.walks,
      },
      endings: {
        authoritative: audit.authoritative,
        flowchart: audit.flowchart,
        flowchartMatches: setMatches,
        noStoryExit: audit.noExit,
        gosubTargets: audit.gosubTargets,
        gosubOnly: audit.gosubOnlyEndings,
        enteredByGoto: audit.enteredByGoto,
        titles,
      },
      staticFindings: findings,
      blockers,
      playthroughs: playthroughs.map((row) => ({
        ending: row.ending,
        title: titles[row.ending],
        entry: row.entry,
        reached: row.reached,
        clean: row.clean,
        lines: row.lines,
        distinctScenes: row.distinctScenes,
        sceneChain: row.sceneChain,
        choices: row.choices.length,
        endedAt: row.endedAt,
        diagnostics: row.diagnostics,
        failure: row.failure,
      })),
      unreached,
      unclean,
    }, null, 2));
    return ok ? 0 : 1;
  }

  console.log("");
  console.log("endings: " + audit.authoritative.length + " — " + audit.authoritative.join(" "));
  console.log(setMatches ? "flowchart ending set: matches the derived set" : `flowchart ending set: MISMATCH chart=[${audit.flowchart}] derived=[${audit.authoritative}]`);
  console.log("");
  const header = ["ending", "title", "entry", "reached", "lines", "scenes", "choices", "diag", "clean"];
  const rows = playthroughs.map((row) => [
    row.ending,
    (titles[row.ending] ?? "").slice(0, 24),
    row.entry,
    row.reached ? "yes" : "NO",
    String(row.lines),
    String(row.distinctScenes),
    String(row.choices.length),
    String(row.diagnostics.length),
    row.clean ? "yes" : "NO",
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)));
  const format = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(format(header));
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(format(row));

  if (findings.length) {
    console.log("");
    console.log("static findings:");
    for (const finding of findings) console.log(`  ${finding.kind}: ${finding.detail}`);
  }
  if (blockers.length) {
    console.log("");
    console.log("unreached endings — where the route stops:");
    for (const blocker of blockers) {
      console.log(`  ${blocker.ending}: ${blocker.note}`);
      if (blocker.gate && blocker.gate.cells.length) {
        const held = blocker.gate.cells
          .map((cell) => `${cell.cell} == ${cell.values.join("/")} (route had ${blocker.gate!.actual[cell.cell] ?? "unset"})`)
          .join(" && ");
        console.log(`    gate at ${blocker.gate.from}:${blocker.gate.instruction} -> ${blocker.gate.target}: ${held}`);
      }
      if (blocker.unseen.length) console.log(`    behind ${blocker.unseen.length} scene(s) never entered: ${blocker.unseen.slice(0, 6).join(" <- ")}`);
    }
  }

  const problems = playthroughs.filter((row) => row.failure || row.diagnostics.length);
  if (problems.length) {
    console.log("");
    console.log("problems:");
    for (const row of problems) {
      if (row.failure) console.log(`  ${row.ending}: ${row.failure}`);
      for (const diagnostic of row.diagnostics.slice(0, 5)) {
        console.log(`  ${row.ending}: ${diagnostic.sceneId}:${diagnostic.instruction} ${diagnostic.opcode}: ${diagnostic.message}`);
      }
    }
  }
  console.log("");
  console.log(`route gate: ${ok ? "PASS" : "FAIL"} — ${playthroughs.length} route(s), ${playthroughs.reduce((sum, row) => sum + row.lines, 0)} lines, ${(elapsed() / 1000).toFixed(1)}s`);
  if (budgetHit) console.log(`note: search stopped at the ${BUDGET_MS}ms budget; raise --max-ms to explore further`);
  return ok ? 0 : 1;
}

// `safeDelay` unrefs its timers (and this harness replaces them with
// zero-delay timers that are also unref'd), so Node would drain the event loop
// mid-advance and exit with an unsettled-await warning. Hold it open.
const keepAlive = setInterval(() => undefined, 1000);
try {
  process.exitCode = await run();
} finally {
  clearInterval(keepAlive);
}
