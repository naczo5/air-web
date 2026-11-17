/**
 * Build the story flowchart from the parsed scenario programs.
 *
 * The graph is derived, never hand-written: every node and edge comes from the
 * bytecode, so the chart cannot drift from what the game actually does. Two
 * edge kinds exist:
 *
 *   scene  -> choice:<ip>   a select in the scene, labelled with its options
 *   scene  -> scene         a scene transition (1:1:11/12/18 or a `scene` op)
 *
 * Choice options are *labels on the choice node*, not edges: the bytecode picks
 * a path with conditional branches, so there is no per-option scene target to
 * record. The option text of a `select` is usually a memory reference that the
 * scene filled in just before the selection (`1:10:0 $18[1903] = "..."`), so
 * this module replays the literal assignments up to each selection to recover
 * the real labels.
 *
 * Story entry points come from `seen9038`'s selector on `$5[1013]`:
 *   0 -> seen0170 (dream / prologue), 1 -> seen0700 (summer), 2 -> seen0163 (air)
 * Any scene reachable from an entry inherits that entry's arc, so the arc
 * filter reflects real reachability instead of a curated guess. No story
 * transition crosses arcs, so the three arcs partition the story graph exactly.
 *
 * Scene numbering: `seen0001`-`seen7999` is story. `seen8000` and up is engine,
 * menu and movie material: the OP/ED/credits programs (`seen8005`, `seen8163`,
 * `seen8505`, `seen8613`, `seen8989`, `seen8993`-`seen8996`), the title
 * bootstrap (`seen9030`-`seen9038`) and the chapter breaker `seen9070`. Every
 * movie scene holds a single text op (`ＳｅｅｎＥｎｄ`) inside a command loop --
 * no story at all -- and roughly 65 story scenes jump to `seen9070` when a
 * chapter ends. Those jumps are exits from the story, not story transitions, so
 * the whole range is excluded instead of being drawn as 65 extra ending nodes.
 */

import type { DataValue, FlowchartEdge, FlowchartManifest, FlowchartNode, SceneProgram } from "../../src/types";

/** Story entries, in the order the original title selector offers them. */
export const STORY_ENTRIES: ReadonlyArray<{ arc: "dream" | "summer" | "air"; sceneId: string }> = [
  { arc: "dream", sceneId: "seen0170" },
  { arc: "summer", sceneId: "seen0700" },
  { arc: "air", sceneId: "seen0163" },
];

/** First scene number that is engine/menu/movie material instead of story. */
export const STORY_SCENE_LIMIT = 8000;

/** Story scenes are numbered below the engine range. */
export function isStoryScene(sceneId: string): boolean {
  const match = /^seen(\d+)$/.exec(sceneId);
  if (!match) return false;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 && number < STORY_SCENE_LIMIT;
}

/** Extract the "July 17 (Monday)" caption from a scene title, if present. */
export function storyDate(title: string | undefined): string | undefined {
  return title ? /^[A-Z][a-z]+ \d{1,2} \([A-Za-z]+\)/.exec(title)?.[0] : undefined;
}

/** Opcodes that change the scene, with the entrypoint in their second argument. */
const SCENE_JUMP_OPCODES = [11, 12, 18];
/** Opcodes 11 is a plain goto; 12/18 push a return frame, i.e. they gosub. */
const SCENE_GOSUB_OPCODES = [12, 18];

type SceneTransition = {
  /** Target scene id, e.g. `seen0180`. */
  sceneId: string;
  /** Index of the instruction that performs the jump. */
  instruction: number;
  /** True when the jump returns to the caller afterwards (gosub). */
  gosub: boolean;
};

function integerValue(value: DataValue | undefined): number | undefined {
  if (value?.kind !== "expression") return undefined;
  const expression = value.value;
  return expression?.kind === "int" ? expression.value : undefined;
}

function stringValue(value: DataValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}

function isMemoryOf(value: DataValue | undefined, bank: number, index: number): boolean {
  if (value?.kind !== "expression") return false;
  const expression = value.value;
  return expression?.kind === "memory" && expression.bank === bank && integerValue({ kind: "expression", value: expression.index }) === index;
}

function sceneIdFor(number: number): string {
  return `seen${number.toString().padStart(4, "0")}`;
}

/** Every scene a program can transition to, in source order, with the jump site. */
export function sceneTransitions(scene: SceneProgram): SceneTransition[] {
  const found: SceneTransition[] = [];
  const seen = new Set<string>();
  scene.instructions.forEach((instruction, index) => {
    let target: string | undefined;
    let gosub = false;
    if (instruction.op === "scene" && instruction.sceneId) {
      target = instruction.sceneId;
    } else if (instruction.op === "command" && instruction.moduleType === 0 && instruction.module === 1) {
      if (!SCENE_JUMP_OPCODES.includes(instruction.opcode)) return;
      const number = integerValue(instruction.args?.[0]);
      if (number === undefined || !Number.isFinite(number)) return;
      target = sceneIdFor(number);
      gosub = SCENE_GOSUB_OPCODES.includes(instruction.opcode);
    }
    if (!target || seen.has(target)) return;
    seen.add(target);
    found.push({ sceneId: target, instruction: index, gosub });
  });
  return found;
}

/** Scene ids a program can transition to, from scene ops and RealLive jumps. */
export function sceneTargets(scene: SceneProgram): string[] {
  return sceneTransitions(scene).map((transition) => transition.sceneId);
}

/**
 * Graphic names that are never a scene's establishing shot: blank colour
 * screens and the date/menu overlays. The grouping matches `imageGroup` in
 * `tools/air/pack.ts`, where these prefixes are classified as `system`.
 */
const BLANK_SCREEN = /^(?:SIRO|SHIRO|KURO|AKA|AO|MIDORI|KI)$/;
const OVERLAY_GRAPHIC = /^(?:S_|SMW|MSG|SDT|K?DAY|RMB|R\d|KCUR|MCUR|OP|KEYLOGO|AIRLOGO)/;

/** Memory cell that holds the current backdrop name (`$18[1000]`). */
const BACKDROP_MEMORY = { bank: 18, index: 1000 } as const;

/**
 * The first resolvable backdrop a scene paints, as a graphic *name* (not a
 * URL) so the caller can map it through `assetAliases` for both plain and
 * packed manifests.
 *
 * Only backdrop draws count: `1:33:73/74/76/1053/1054/1056` write the slot in
 * argument 1 (slots 0-3 replace the backdrop, higher slots are sprites), the
 * `1:33:75/1055/1057` composite names the backdrop in argument 0, and
 * `1:40:100` paints argument 0, which may be the `$18[1000]` memory cell.
 */
function firstBackdrop(scene: SceneProgram, isImageName: (name: string) => boolean): string | undefined {
  let backdropMemory: string | undefined;
  const candidates: string[] = [];
  for (const instruction of scene.instructions) {
    if (instruction.op !== "command") continue;
    if (instruction.moduleType === 1 && instruction.module === 10 && instruction.opcode === 0) {
      if (isMemoryOf(instruction.args?.[0], BACKDROP_MEMORY.bank, BACKDROP_MEMORY.index)) {
        backdropMemory = stringValue(instruction.args?.[1]);
      }
      continue;
    }
    if (instruction.moduleType === 1 && instruction.module === 33) {
      const name = stringValue(instruction.args?.[0]);
      if (!name) continue;
      if ([73, 74, 76, 1053, 1054, 1056].includes(instruction.opcode)) {
        if ((integerValue(instruction.args?.[1]) ?? 0) <= 3) candidates.push(name);
      } else if ([75, 1055, 1057].includes(instruction.opcode)) {
        candidates.push(name);
      }
      continue;
    }
    if (instruction.moduleType === 1 && instruction.module === 40 && instruction.opcode === 100) {
      const literal = stringValue(instruction.args?.[0]);
      if (literal) candidates.push(literal);
      else if (isMemoryOf(instruction.args?.[0], BACKDROP_MEMORY.bank, BACKDROP_MEMORY.index) && backdropMemory) {
        candidates.push(backdropMemory);
      }
    }
  }
  return candidates.find((name) => isImageName(name) && !BLANK_SCREEN.test(name) && !OVERLAY_GRAPHIC.test(name));
}

/**
 * Option labels for a select/choice instruction, with memory-referenced text
 * resolved from the literal assignments that precede it in the same scene.
 */
function optionLabels(instruction: SceneProgram["instructions"][number], literals: Map<string, string>): string[] {
  if (instruction.op === "choice") return [...instruction.options];
  if (instruction.op !== "select") return [];
  return instruction.options.map((option) => {
    if (option.text) return option.text;
    const expression = option.textExpression;
    if (expression?.kind !== "memory") return "";
    const index = integerValue({ kind: "expression", value: expression.index });
    return literals.get(`${expression.bank}:${index}`) ?? "";
  });
}

/** Track `1:10:0 $bank[index] = "literal"` assignments so selects can resolve. */
function literalAssignments(scene: SceneProgram): Array<Map<string, string>> {
  const literals = new Map<string, string>();
  return scene.instructions.map((instruction) => {
    const snapshot = new Map(literals);
    if (instruction.op !== "command" || instruction.moduleType !== 1 || instruction.module !== 10) return snapshot;
    const destination = instruction.args?.[0];
    if (destination?.kind !== "expression" || destination.value.kind !== "memory") return snapshot;
    const index = integerValue({ kind: "expression", value: destination.value.index });
    if (index === undefined) return snapshot;
    const key = `${destination.value.bank}:${index}`;
    if (instruction.opcode === 0) {
      const literal = stringValue(instruction.args?.[1]);
      if (literal !== undefined) literals.set(key, literal);
    } else if (instruction.opcode === 1 || instruction.opcode === 2) {
      // Cleared or appended: the literal no longer describes the cell.
      literals.delete(key);
    }
    return snapshot;
  });
}

export type FlowchartBuildOptions = {
  /**
   * Is this graphic name present in the manifest? Used to keep thumbnails
   * resolvable at build time. Defaults to accepting any identifier, which is
   * only useful for synthetic scene maps in tests.
   */
  isImageName?: (name: string) => boolean;
};

type BuiltGraph = FlowchartManifest & { entryArcs: Record<string, string> };

/**
 * Build nodes, edges and entry arcs for every story scene in `scenes`.
 * Choice nodes are always emitted so a fork is visible even when none of its
 * options resolves to a scene of its own (the bytecode picks with branches).
 */
export function buildFlowchart(scenes: Record<string, SceneProgram>, options: FlowchartBuildOptions = {}): BuiltGraph {
  const isImageName = options.isImageName ?? ((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name));
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];
  const storyIds = Object.keys(scenes).filter(isStoryScene).sort();
  const storySet = new Set(storyIds);

  // Story exits only: jumps into the engine/movie range are chapter breaks,
  // not transitions to another story scene.
  const transitions = new Map<string, SceneTransition[]>();
  const enteredByGosub = new Set<string>();
  for (const sceneId of storyIds) {
    const storyExits = sceneTransitions(scenes[sceneId]).filter((transition) => storySet.has(transition.sceneId));
    transitions.set(sceneId, storyExits);
    for (const transition of storyExits) if (transition.gosub) enteredByGosub.add(transition.sceneId);
  }

  for (const sceneId of storyIds) {
    const scene = scenes[sceneId];
    const exits = transitions.get(sceneId) ?? [];
    const thumb = firstBackdrop(scene, isImageName);
    nodes.push({
      id: `${sceneId}:scene`,
      sceneId,
      instruction: 0,
      label: scene.title ?? sceneId,
      date: storyDate(scene.title),
      // A scene that neither continues nor returns is where a route stops. A
      // gosub target is a sub-scene: it returns to its caller, so it is not an
      // ending even though it has no exits of its own.
      kind: exits.length === 0 && !enteredByGosub.has(sceneId) ? "ending" : "scene",
      ...(thumb ? { thumb } : {}),
    });
  }

  for (const sceneId of storyIds) {
    for (const transition of transitions.get(sceneId) ?? []) {
      edges.push({ from: `${sceneId}:scene`, to: `${transition.sceneId}:scene`, instruction: transition.instruction });
    }
  }

  for (const sceneId of storyIds) {
    const scene = scenes[sceneId];
    const literals = literalAssignments(scene);
    scene.instructions.forEach((instruction, index) => {
      if (instruction.op !== "choice" && instruction.op !== "select") return;
      const choiceId = `${sceneId}:choice:${index}`;
      const labels = optionLabels(instruction, literals[index]);
      nodes.push({
        id: choiceId,
        sceneId,
        instruction: index,
        label: "Choice",
        kind: "choice",
        options: labels,
      });
      edges.push({
        from: `${sceneId}:scene`,
        to: choiceId,
        instruction: index,
        label: labels.filter(Boolean).join(" / "),
      });
    });
  }

  // Entry arcs by BFS from each real story entry.
  const entryArcs: Record<string, string> = {};
  for (const entry of STORY_ENTRIES) {
    if (!storySet.has(entry.sceneId)) continue;
    const queue = [entry.sceneId];
    while (queue.length) {
      const current = queue.shift()!;
      if (entryArcs[current]) continue;
      entryArcs[current] = entry.arc;
      for (const transition of transitions.get(current) ?? []) {
        if (!entryArcs[transition.sceneId]) queue.push(transition.sceneId);
      }
    }
  }
  for (const node of nodes) {
    const arc = entryArcs[node.sceneId];
    if (arc) node.arc = arc;
  }

  return { nodes, edges, entryArcs };
}

/** De-duplicate edges so repeated jumps to one scene produce a single arrow. */
export function dedupeEdges(edges: FlowchartEdge[]): FlowchartEdge[] {
  const seen = new Set<string>();
  const out: FlowchartEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}
