import { describe, expect, it } from "vitest";
import { buildFlowchartGraph, layoutFlowchart } from "./FlowchartView";
import type { FlowchartEdge, FlowchartNode } from "../types";

const sceneNode = (sceneId: string, extra: Partial<FlowchartNode> = {}): FlowchartNode => ({
  id: `${sceneId}:scene`,
  sceneId,
  instruction: 0,
  label: sceneId,
  kind: "scene",
  ...extra,
});

const choiceNode = (sceneId: string, instruction: number, options: string[]): FlowchartNode => ({
  id: `${sceneId}:choice:${instruction}`,
  sceneId,
  instruction,
  label: "Choice",
  kind: "choice",
  options,
});

const edge = (from: string, to: string, extra: Partial<FlowchartEdge> = {}): FlowchartEdge => ({
  from: `${from}:scene`,
  to: `${to}:scene`,
  ...extra,
});

/** seen0170 -> seen0180 -> seen0190, with one select in seen0180. */
function linear(): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
  return {
    nodes: [sceneNode("seen0170"), sceneNode("seen0180", { thumb: "BG010" }), sceneNode("seen0190", { kind: "ending" }), choiceNode("seen0180", 4, ["Stay", "Leave"])],
    edges: [
      edge("seen0170", "seen0180", { instruction: 7 }),
      edge("seen0180", "seen0190", { instruction: 9 }),
      { from: "seen0180:scene", to: "seen0180:choice:4", instruction: 4, label: "Stay / Leave" },
    ],
  };
}

describe("buildFlowchartGraph", () => {
  it("indexes nodes, roots and parent links from the manifest graph", () => {
    const graph = buildFlowchartGraph(linear());
    expect(graph.nodes.size).toBe(4);
    expect(graph.roots).toEqual(["seen0170:scene"]);
    expect(graph.parentOf.get("seen0180:scene")).toBe("seen0170:scene");
    expect(graph.parentOf.get("seen0180:choice:4")).toBe("seen0180:scene");
    expect(graph.choices.get("seen0180:scene")).toEqual(["seen0180:choice:4"]);
    expect(graph.sceneCount).toBe(3);
  });

  it("drops edges that point at nodes the manifest does not contain", () => {
    const { nodes } = linear();
    const graph = buildFlowchartGraph({ nodes, edges: [...linear().edges, edge("seen0999", "seen0170"), edge("seen0170", "seen0777")] });
    expect(graph.edges).toHaveLength(3);
  });

  it("survives a graph with no roots at all", () => {
    // The synthetic demo route loops back on itself, so every node has a parent.
    const graph = buildFlowchartGraph({
      nodes: [sceneNode("demo"), choiceNode("demo", 2, ["Start", "Return"])],
      edges: [
        { from: "demo:scene", to: "demo:choice:2" },
        { from: "demo:choice:2", to: "demo:scene" },
      ],
    });
    expect(graph.roots).toEqual([]);
    expect(graph.order).toHaveLength(2);
    expect(new Set(graph.order).size).toBe(2);
  });

  it("places every node exactly once even with a cycle and a shared child", () => {
    const graph = buildFlowchartGraph({
      nodes: [sceneNode("seen0170"), sceneNode("seen0230"), sceneNode("seen0232"), sceneNode("seen0240")],
      edges: [edge("seen0170", "seen0230"), edge("seen0170", "seen0232"), edge("seen0230", "seen0232"), edge("seen0232", "seen0230"), edge("seen0230", "seen0240")],
    });
    expect(graph.order).toHaveLength(4);
    expect(new Set(graph.order).size).toBe(4);
  });

  it("returns an empty graph for a missing flowchart", () => {
    const graph = buildFlowchartGraph(undefined);
    expect(graph.nodes.size).toBe(0);
    expect(graph.roots).toEqual([]);
    const layout = layoutFlowchart(graph, () => true, () => undefined);
    expect(layout.nodes).toEqual([]);
    expect(layout.visibleSceneCount).toBe(0);
  });
});

describe("layoutFlowchart", () => {
  it("puts a scene above its children and keeps the child centred", () => {
    const layout = layoutFlowchart(buildFlowchartGraph(linear()), () => true, () => undefined);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const parent = byId.get("seen0170:scene")!;
    const child = byId.get("seen0180:scene")!;
    expect(child.y).toBeGreaterThan(parent.y);
    expect(child.x + child.width / 2).toBeCloseTo(parent.x + parent.width / 2, 5);
    expect(layout.visibleSceneCount).toBe(3);
  });

  it("draws one edge per manifest edge and marks the choice edges", () => {
    const layout = layoutFlowchart(buildFlowchartGraph(linear()), () => true, () => undefined);
    expect(layout.edges).toHaveLength(3);
    const choiceEdge = layout.edges.find((item) => item.to === "seen0180:choice:4")!;
    expect(choiceEdge.isChoice).toBe(true);
    const sceneEdge = layout.edges.find((item) => item.to === "seen0190:scene")!;
    expect(sceneEdge.isChoice).toBe(false);
    expect(sceneEdge.fromSceneId).toBe("seen0180");
  });

  it("takes the card image from the node's recorded backdrop", () => {
    const layout = layoutFlowchart(buildFlowchartGraph(linear()), () => true, (node) => node.thumb && `url(${node.thumb})`);
    const child = layout.nodes.find((node) => node.id === "seen0180:scene")!;
    expect(child.thumbnailUrl).toBe("url(BG010)");
    expect(layout.nodes.find((node) => node.type === "choice")?.thumbnailUrl).toBeUndefined();
  });

  it("hides filtered nodes and re-roots their children", () => {
    const graph = buildFlowchartGraph(linear());
    const layout = layoutFlowchart(graph, (node) => node.sceneId !== "seen0170", () => undefined);
    const ids = layout.nodes.map((node) => node.id);
    expect(ids).not.toContain("seen0170:scene");
    expect(ids).toEqual(expect.arrayContaining(["seen0180:scene", "seen0190:scene"]));
    // seen0180 loses its parent, so it becomes a root of the filtered chart.
    expect(layout.visibleSceneCount).toBe(2);
  });

  it("draws nothing when the filter excludes every node", () => {
    const graph = buildFlowchartGraph(linear());
    const layout = layoutFlowchart(graph, () => false, () => undefined);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.visibleSceneCount).toBe(0);
  });

  it("keeps the date caption as the card label", () => {
    const nodes = [sceneNode("seen0170", { date: "July 17 (Monday)", label: "July 17 (Monday) / prologue" })];
    const layout = layoutFlowchart(buildFlowchartGraph({ nodes, edges: [] }), () => true, () => undefined);
    expect(layout.nodes[0].dateLabel).toBe("July 17 (Monday)");
  });

  it("carries the node instruction so a jump resumes at the fork", () => {
    const layout = layoutFlowchart(buildFlowchartGraph(linear()), () => true, () => undefined);
    expect(layout.nodes.find((node) => node.type === "choice")?.instruction).toBe(4);
  });
});
