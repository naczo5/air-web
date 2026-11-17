import { describe, expect, it } from "vitest";
import { buildFlowchart, dedupeEdges, isStoryScene, sceneTargets, sceneTransitions, storyDate, STORY_ENTRIES } from "./flowchart";
import type { DataValue, SceneProgram } from "../../src/types";

const int = (value: number): DataValue => ({ kind: "expression", value: { kind: "int", value } });
const string = (value: string): DataValue => ({ kind: "string", value });
const mem = (bank: number, index: number): DataValue => ({ kind: "expression", value: { kind: "memory", bank, index: { kind: "int", value: index } } });

/** `1:1:12 scene, entrypoint` — the gosub form of a scene transition. */
const gosub = (scene: number, entrypoint = 0, args: DataValue[] = [int(scene), int(entrypoint)]): SceneProgram["instructions"][number] => ({
  op: "command", offset: 0, moduleType: 0, module: 1, opcode: 12, argc: args.length, overload: 0, args,
});

/** `1:1:11 scene` — a plain goto. */
const goTo = (scene: number): SceneProgram["instructions"][number] => ({
  op: "command", offset: 0, moduleType: 0, module: 1, opcode: 11, argc: 1, overload: 0, args: [int(scene)],
});

/** `1:10:0 $18[index] = "literal"` — how AIR fills a selection's option text. */
const assignString = (index: number, value: string): SceneProgram["instructions"][number] => ({
  op: "command", offset: 0, moduleType: 1, module: 10, opcode: 0, argc: 2, overload: 0, args: [mem(18, index), string(value)],
});

/** `2:2:1 { ###PRINT($18[a]) ###PRINT($18[b]) }` — a selection over memory cells. */
const select = (indexes: number[]): SceneProgram["instructions"][number] => ({
  op: "select",
  offset: 0,
  moduleType: 0,
  module: 2,
  opcode: 1,
  argc: indexes.length,
  overload: 0,
  options: indexes.map((index) => ({ text: "", textExpression: { kind: "memory", bank: 18, index: { kind: "int", value: index } }, conditions: [] })),
});

/** `1:33:73 name, slot` — load a graphic and open it in a buffer. */
const loadGraphic = (name: string, slot: number): SceneProgram["instructions"][number] => ({
  op: "command", offset: 0, moduleType: 1, module: 33, opcode: 73, argc: 2, overload: 0, args: [string(name), int(slot)],
});

const scene = (id: string, title: string | undefined, instructions: SceneProgram["instructions"]): SceneProgram => ({ id, title, instructions });
const end = { op: "end" as const };

/** The three real entries, a fork, an ending and a jump into the engine range. */
function syntheticScenes(): Record<string, SceneProgram> {
  return {
    seen0170: scene("seen0170", "July 17 (Monday)", [loadGraphic("KURO", 0), loadGraphic("BG010", 0), goTo(180), end]),
    seen0180: scene("seen0180", "July 18 (Tuesday)", [
      loadGraphic("SIRO", 0),
      assignString(1903, "Stay"),
      assignString(1904, "Leave"),
      select([1903, 1904]),
      goTo(190),
      end,
    ]),
    // End of a route: its only exit is the chapter breaker.
    seen0190: scene("seen0190", "July 31 (Monday)", [goTo(9070), end]),
    seen0700: scene("seen0700", "[ Shinto Shrine ] / Ryuuya", [{ op: "text", text: "summer" }, end]),
    // Engine/menu range: never part of the story graph.
    seen9070: scene("seen9070", "SEEN 9070", [{ op: "text", text: "chapter break" }, end]),
  };
}

describe("isStoryScene", () => {
  it("keeps story numbers below the engine range", () => {
    expect(isStoryScene("seen0001")).toBe(true);
    expect(isStoryScene("seen0170")).toBe(true);
    expect(isStoryScene("seen7999")).toBe(true);
  });

  it("excludes the OP/ED, credits, title and chapter-break programs", () => {
    // seen8005/8163/8505/8613/8989/8993-8996 hold a single text op inside a
    // command loop: movie/credits material, not story.
    for (const id of ["seen8000", "seen8005", "seen8163", "seen8505", "seen8613", "seen8989", "seen8993", "seen8994", "seen8995", "seen8996", "seen9030", "seen9038", "seen9070"]) {
      expect(isStoryScene(id), id).toBe(false);
    }
  });

  it("rejects names that are not scene ids", () => {
    for (const id of ["demo", "seen", "seen-1", "seenabc", "scenario0170", ""]) expect(isStoryScene(id), id).toBe(false);
  });
});

describe("storyDate", () => {
  it("extracts the caption the original game prints", () => {
    expect(storyDate("July 17 (Monday)")).toBe("July 17 (Monday)");
    expect(storyDate("July 16 (Sunday) / ?")).toBe("July 16 (Sunday)");
    expect(storyDate("August 13 (Sunday)")).toBe("August 13 (Sunday)");
  });

  it("returns undefined for location titles and missing titles", () => {
    expect(storyDate("[ Shinto Shrine ] / Ryuuya")).toBeUndefined();
    expect(storyDate("SEEN 217")).toBeUndefined();
    expect(storyDate(undefined)).toBeUndefined();
  });
});

describe("sceneTargets", () => {
  it("reads 1:1:11/12/18 jumps with their entrypoint argument", () => {
    const targets = sceneTargets(scene("seen0100", undefined, [goTo(200), gosub(300, 4), gosub(400), end]));
    expect(targets).toEqual(["seen0200", "seen0300", "seen0400"]);
  });

  it("keeps the instruction index and marks the returning jumps", () => {
    const transitions = sceneTransitions(scene("seen0100", undefined, [goTo(200), gosub(300), end]));
    expect(transitions).toEqual([
      { sceneId: "seen0200", instruction: 0, gosub: false },
      { sceneId: "seen0300", instruction: 1, gosub: true },
    ]);
  });

  it("includes explicit scene ops and ignores non-scene commands", () => {
    const targets = sceneTargets(scene("seen0100", undefined, [
      { op: "scene", sceneId: "seen0500" },
      { op: "command", offset: 0, moduleType: 1, module: 1, opcode: 12, argc: 1, overload: 0, args: [int(600)] },
      { op: "command", offset: 0, moduleType: 0, module: 2, opcode: 12, argc: 1, overload: 0, args: [int(700)] },
      end,
    ]));
    expect(targets).toEqual(["seen0500"]);
  });

  it("does not repeat a scene reached twice", () => {
    expect(sceneTargets(scene("seen0100", undefined, [goTo(200), gosub(200), end]))).toEqual(["seen0200"]);
  });
});

describe("buildFlowchart", () => {
  it("emits one node per story scene plus one per select", () => {
    const { nodes } = buildFlowchart(syntheticScenes());
    const scenes = nodes.filter((node) => node.kind !== "choice").map((node) => node.sceneId);
    expect(scenes).toEqual(["seen0170", "seen0180", "seen0190", "seen0700"]);
    const choices = nodes.filter((node) => node.kind === "choice");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ id: "seen0180:choice:3", sceneId: "seen0180", instruction: 3, kind: "choice" });
  });

  it("excludes the 8000/9000 ranges and their transitions", () => {
    const graph = buildFlowchart(syntheticScenes());
    expect(graph.nodes.some((node) => node.sceneId === "seen9070")).toBe(false);
    expect(graph.edges.some((edge) => edge.to === "seen9070:scene")).toBe(false);
    // seen0190 jumps only to the chapter breaker, so it ends its route.
    expect(graph.nodes.find((node) => node.id === "seen0190:scene")?.kind).toBe("ending");
  });

  it("does not call a gosub target an ending", () => {
    // seen0190 has no outgoing story edge, but seen0180 gosubs into it, so it
    // returns to its caller instead of ending the story.
    const scenes = syntheticScenes();
    scenes.seen0180 = scene("seen0180", "July 18 (Tuesday)", [gosub(190), end]);
    scenes.seen0190 = scene("seen0190", "July 31 (Monday)", [{ op: "text", text: "sub-scene" }, end]);
    const graph = buildFlowchart(scenes);
    expect(graph.nodes.find((node) => node.id === "seen0190:scene")?.kind).toBe("scene");
  });

  it("links scenes with the instruction that performs the jump", () => {
    const graph = buildFlowchart(syntheticScenes());
    expect(graph.edges).toContainEqual({ from: "seen0170:scene", to: "seen0180:scene", instruction: 2 });
    expect(graph.edges).toContainEqual({ from: "seen0180:scene", to: "seen0190:scene", instruction: 4 });
  });

  it("labels the choice node with the resolved option text", () => {
    const graph = buildFlowchart(syntheticScenes());
    const choice = graph.nodes.find((node) => node.kind === "choice");
    expect(choice?.options).toEqual(["Stay", "Leave"]);
    const edge = graph.edges.find((edge) => edge.to === "seen0180:choice:3");
    expect(edge).toMatchObject({ from: "seen0180:scene", instruction: 3, label: "Stay / Leave" });
  });

  it("leaves an unresolvable option empty instead of inventing text", () => {
    const scenes = syntheticScenes();
    scenes.seen0180 = scene("seen0180", "July 18 (Tuesday)", [select([1903, 1904]), end]);
    const choice = buildFlowchart(scenes).nodes.find((node) => node.kind === "choice");
    expect(choice?.options).toEqual(["", ""]);
  });

  it("records the first backdrop, skipping blank screens and overlays", () => {
    const scenes = syntheticScenes();
    scenes.seen0700 = scene("seen0700", "Summer", [loadGraphic("KURO", 0), loadGraphic("DAY_000", 1), loadGraphic("BG040", 0)]);
    const graph = buildFlowchart(scenes);
    expect(graph.nodes.find((node) => node.id === "seen0170:scene")?.thumb).toBe("BG010");
    expect(graph.nodes.find((node) => node.id === "seen0700:scene")?.thumb).toBe("BG040");
  });

  it("does not record a thumbnail that is not a resolvable image", () => {
    const graph = buildFlowchart(syntheticScenes(), { isImageName: (name) => name.startsWith("BG") });
    expect(graph.nodes.find((node) => node.id === "seen0700:scene")?.thumb).toBeUndefined();
  });

  it("carries the story date caption on scene nodes only", () => {
    const graph = buildFlowchart(syntheticScenes());
    expect(graph.nodes.find((node) => node.id === "seen0170:scene")?.date).toBe("July 17 (Monday)");
    expect(graph.nodes.find((node) => node.kind === "choice")?.date).toBeUndefined();
  });

  it("assigns each scene the arc its entry reaches it from", () => {
    const scenes = syntheticScenes();
    // seen0170 is the dream entry, seen0700 the summer entry, and neither
    // reaches the other.
    const graph = buildFlowchart(scenes);
    const arcOf = (id: string) => graph.nodes.find((node) => node.id === id)?.arc;
    expect(arcOf("seen0170:scene")).toBe("dream");
    expect(arcOf("seen0180:scene")).toBe("dream");
    expect(arcOf("seen0190:scene")).toBe("dream");
    expect(arcOf("seen0700:scene")).toBe("summer");
    expect(arcOf("seen0180:choice:3")).toBe("dream");
  });

  it("keeps the real story entries", () => {
    expect(STORY_ENTRIES.map((entry) => [entry.arc, entry.sceneId])).toEqual([
      ["dream", "seen0170"],
      ["summer", "seen0700"],
      ["air", "seen0163"],
    ]);
  });

  it("is empty for a manifest with no story scenes", () => {
    const graph = buildFlowchart({ seen9070: scene("seen9070", "SEEN 9070", [end]) });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.entryArcs).toEqual({});
  });
});

describe("dedupeEdges", () => {
  it("keeps the first edge per endpoint pair", () => {
    const edges = dedupeEdges([
      { from: "a", to: "b", instruction: 3 },
      { from: "a", to: "b", instruction: 9 },
      { from: "b", to: "c" },
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]);
    expect(edges).toEqual([
      { from: "a", to: "b", instruction: 3 },
      { from: "b", to: "c" },
      { from: "b", to: "a" },
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeEdges([])).toEqual([]);
  });
});
