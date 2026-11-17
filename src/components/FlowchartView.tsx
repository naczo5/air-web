import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlowchartEdge, FlowchartNode, GameManifest, RuntimeState } from "../types";
import { ResolvedImage } from "../runtime/packedMedia";
import { peekScene } from "../runtime/sceneStore";

/**
 * The story chart, drawn straight from `manifest.flowchart`.
 *
 * Every node and edge comes from `tools/air/flowchart.ts`, which derives them
 * from the SEEN bytecode while preparing assets: 77 story scenes, one node per
 * `select`, one edge per scene transition, a story-date caption per scene, the
 * first backdrop the scene paints (as a thumbnail name), and the arc each node
 * is reachable from. Nothing here is curated: the previous hand-written tree
 * had links that do not exist in the bytecode and missed 56 of the 86 scenes.
 *
 * Packed builds serve scenes lazily, and `manifest.scenes` is a Proxy whose
 * placeholder programs have no instructions, so this file must never derive
 * anything by reading a scene program: `date`, `label` and `thumb` already
 * cover what the cards show, and `peekScene` (never `manifest.scenes[id]`) is
 * only a fallback for manifests that keep real programs in memory.
 */

/** The three real story arcs plus "all"; the bytecode has no other arcs. */
export type FlowchartArc = "all" | "dream" | "summer" | "air";

const ARC_FILTERS: ReadonlyArray<{ value: FlowchartArc; label: string }> = [
  { value: "all", label: "All Arcs" },
  { value: "dream", label: "Dream Arc" },
  { value: "summer", label: "Summer Arc" },
  { value: "air", label: "AIR Arc" },
];

export interface FlowNodeData {
  id: string;
  sceneId: string;
  instruction: number;
  label: string;
  dateLabel?: string;
  type: "scene" | "choice" | "ending";
  arc: FlowchartArc;
  options?: string[];
  thumbnailUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentIds: string[];
  isChoiceFork?: boolean;
}

export interface FlowEdgeData {
  id: string;
  from: string;
  to: string;
  /** Scene id the edge originates in, for the "explored" tint. */
  fromSceneId: string;
  label?: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  isChoice?: boolean;
}

interface FlowchartViewProps {
  manifest: GameManifest;
  state: RuntimeState;
  onJumpToScene?: (sceneId: string, instruction?: number) => void;
  onClose?: () => void;
}

// ---- layout constants (unchanged card size; choice forks are small tabs) ----
const CARD_WIDTH = 96;
const CARD_HEIGHT = 64;
/** A `select` is a fork inside a scene, so it draws as a narrow paper tab. */
const CHIP_WIDTH = 84;
const CHIP_HEIGHT = 19;
const CHIP_GAP = 5;
const CHIP_OFFSET = 8;
const HORIZONTAL_GAP = 26;
const VERTICAL_GAP = 46;
const PADDING = 60;
const MIN_ZOOM = 0.18;
const MAX_ZOOM = 2.2;

type GraphNode = {
  id: string;
  sceneId: string;
  instruction: number;
  label: string;
  date?: string;
  arc: FlowchartArc;
  type: "scene" | "choice" | "ending";
  options: string[];
  thumb?: string;
};

export type FlowchartGraph = {
  nodes: Map<string, GraphNode>;
  /** Spanning-tree children per node (scene -> child scenes and choice tabs). */
  children: Map<string, string[]>;
  /** Choice tab ids per scene, in bytecode order. */
  choices: Map<string, string[]>;
  /** First scene parent per node, used to unlock a path to the root. */
  parentOf: Map<string, string>;
  /** Every edge in the manifest graph, deduplicated by endpoints. */
  edges: FlowchartEdge[];
  /** Scene nodes that no other scene transitions into, in a stable order. */
  roots: string[];
  /** Every node in breadth-first order from the roots. */
  order: string[];
  sceneCount: number;
};

function arcOf(node: FlowchartNode): FlowchartArc {
  return node.arc === "dream" || node.arc === "summer" || node.arc === "air" ? node.arc : "all";
}

function typeOf(node: FlowchartNode): "scene" | "choice" | "ending" {
  if (node.kind === "choice") return "choice";
  if (node.kind === "ending") return "ending";
  return "scene";
}

/**
 * Index the manifest graph: nodes by id, a spanning tree for layout, and the
 * parent links used to reveal a path once a scene has been seen.
 *
 * The graph is nearly a tree, but a few scenes are reachable from more than one
 * place (`seen0444` has three parents) and `seen0230`/`seen0232` form a loop.
 * Layout therefore needs a spanning tree; every edge is still drawn.
 */
export function buildFlowchartGraph(flowchart: { nodes: FlowchartNode[]; edges: FlowchartEdge[] } | undefined): FlowchartGraph {
  const nodes = new Map<string, GraphNode>();
  for (const node of flowchart?.nodes ?? []) {
    if (!node?.id) continue;
    nodes.set(node.id, {
      id: node.id,
      sceneId: node.sceneId,
      instruction: node.instruction ?? 0,
      label: node.label || node.sceneId,
      date: node.date,
      arc: arcOf(node),
      type: typeOf(node),
      options: Array.isArray(node.options) ? node.options : [],
      thumb: node.thumb,
    });
  }

  const edges: FlowchartEdge[] = [];
  const outgoing = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const choiceOf = new Map<string, string[]>();
  const seenEdge = new Set<string>();
  for (const edge of flowchart?.edges ?? []) {
    if (!edge?.from || !edge?.to) continue;
    // Both endpoints must exist: a manifest may be older than the graph code.
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push(edge);
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
    if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
    if (nodes.get(edge.to)?.type === "choice") {
      const chips = choiceOf.get(edge.from) ?? [];
      chips.push(edge.to);
      choiceOf.set(edge.from, chips);
    }
  }
  // Choice tabs keep bytecode order so the option list matches the game.
  for (const chips of choiceOf.values()) {
    chips.sort((left, right) => (nodes.get(left)?.instruction ?? 0) - (nodes.get(right)?.instruction ?? 0));
  }

  const targets = [...outgoing.values()].flat();
  const hasIncoming = new Set(targets);
  const arcRank: Record<string, number> = { dream: 0, summer: 1, air: 2 };
  const sceneIds = [...nodes.values()]
    .filter((node) => node.type !== "choice")
    .map((node) => node.id)
    .sort((left, right) => {
      const rank = (arcRank[nodes.get(left)!.arc] ?? 9) - (arcRank[nodes.get(right)!.arc] ?? 9);
      return rank || left.localeCompare(right);
    });
  // Scene nodes nothing transitions into: the three story entries, in the
  // order the title selector offers them.
  const roots = sceneIds.filter((id) => !hasIncoming.has(id));

  // Breadth-first spanning tree. Roots first, then any remaining component the
  // roots cannot reach (the synthetic demo route is a loop with no true root).
  const children = new Map<string, string[]>();
  const order: string[] = [];
  const placed = new Set<string>();
  const grow = (start: string): void => {
    if (placed.has(start)) return;
    placed.add(start);
    order.push(start);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      // Scene children first so the tree follows story flow; a scene's select
      // tabs are appended in bytecode order.
      const scenes = (outgoing.get(current) ?? []).filter((kid) => nodes.get(kid)?.type !== "choice");
      const chips = choiceOf.get(current) ?? [];
      const kids = [...scenes, ...chips].filter((kid) => !placed.has(kid));
      for (const kid of kids) {
        placed.add(kid);
        order.push(kid);
        queue.push(kid);
      }
      children.set(current, kids);
    }
  };
  for (const root of roots) grow(root);
  for (const id of [...sceneIds, ...choiceOf.values()].flat()) if (!placed.has(id)) grow(id);
  for (const node of nodes.values()) if (!children.has(node.id)) children.set(node.id, []);

  return {
    nodes,
    children,
    choices: choiceOf,
    parentOf,
    edges,
    roots,
    order,
    sceneCount: sceneIds.length,
  };
}

export type FlowchartLayout = {
  nodes: FlowNodeData[];
  edges: FlowEdgeData[];
  bounds: { width: number; height: number };
  visibleSceneCount: number;
};

/**
 * Vertical tidy-tree layout: one row per transition depth, scenes as cards,
 * each scene's `select` forks stacked as tabs beside the card.
 *
 * A subtree is measured as a half-width either side of its card centre, so
 * every card sits directly under its parent's card. A scene with fork tabs
 * reserves the same room on both sides -- the tabs themselves stay right of the
 * card -- which keeps its arrows clear without shifting its children. Rows are
 * as tall as their tallest card, so a scene with 13 forks does not squeeze its
 * neighbours.
 */
export function layoutFlowchart(
  graph: FlowchartGraph,
  isVisible: (node: GraphNode) => boolean,
  thumbnailFor: (node: GraphNode) => string | undefined,
): FlowchartLayout {
  const visible = (id: string) => {
    const node = graph.nodes.get(id);
    return Boolean(node && isVisible(node));
  };
  // `children` holds both scene children and the scene's select tabs, so the
  // layout splits them: tabs are placed beside the card, not in the tree.
  const childrenOf = (id: string) =>
    (graph.children.get(id) ?? []).filter((kid) => graph.nodes.get(kid)?.type !== "choice" && visible(kid));
  const chipsOf = (id: string) => (graph.choices.get(id) ?? []).filter(visible);

  const treeParent = new Map<string, string>();
  for (const [id, kids] of graph.children) {
    for (const kid of kids) if (!treeParent.has(kid)) treeParent.set(kid, id);
  }
  // A node starts its own subtree when the arc filter hides its parent.
  const roots = graph.order.filter((id) => {
    if (!visible(id)) return false;
    const parent = treeParent.get(id);
    return !parent || !visible(parent);
  });
  // A closed loop has no root at all (the synthetic demo route is one), so the
  // first node becomes the top of the chart instead of everything sharing a row.
  if (!roots.length) {
    const first = graph.order.find(visible);
    if (first) roots.push(first);
  }

  const depth = new Map<string, number>();
  for (const root of roots) {
    if (depth.has(root)) continue;
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const kid of graph.children.get(current) ?? []) {
        if (graph.nodes.get(kid)?.type === "choice" || !visible(kid) || depth.has(kid)) continue;
        depth.set(kid, (depth.get(current) ?? 0) + 1);
        queue.push(kid);
      }
    }
  }

  /**
   * Half-width of a subtree, measured symmetrically from its card centre, so
   * every card sits directly under its parent's card. A scene with fork tabs
   * reserves the same room on both sides; the tabs themselves stay right of the
   * card, which keeps a card's arrows clear without shifting its children.
   */
  const halfWidths = new Map<string, number>();
  const halfWidthOf = (id: string): number => {
    const cached = halfWidths.get(id);
    if (cached !== undefined) return cached;
    const node = graph.nodes.get(id);
    if (!node) return CARD_WIDTH / 2;
    const own = node.type === "choice"
      ? CHIP_WIDTH / 2
      : CARD_WIDTH / 2 + (chipsOf(id).length ? CHIP_OFFSET + CHIP_WIDTH : 0);
    // Cycle guard: a self-referencing component measures as its own card until
    // the real children are known.
    halfWidths.set(id, own);
    const kids = childrenOf(id);
    const childrenWidth = kids.length
      ? kids.reduce((sum, kid) => sum + halfWidthOf(kid) * 2, 0) + (kids.length - 1) * HORIZONTAL_GAP
      : 0;
    const half = Math.max(own, childrenWidth / 2);
    halfWidths.set(id, half);
    return half;
  };

  const cardHeightOf = (id: string): number => {
    const node = graph.nodes.get(id);
    if (!node) return CARD_HEIGHT;
    if (node.type === "choice") return CHIP_HEIGHT;
    const chips = chipsOf(id);
    const stack = chips.length ? chips.length * CHIP_HEIGHT + (chips.length - 1) * CHIP_GAP : 0;
    return Math.max(CARD_HEIGHT, stack);
  };

  const rowHeights = new Map<number, number>();
  for (const [id, row] of depth) {
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, cardHeightOf(id)));
  }
  const rowTops = new Map<number, number>();
  let cursorY = PADDING;
  for (const row of [...rowHeights.keys()].sort((left, right) => left - right)) {
    rowTops.set(row, cursorY);
    cursorY += rowHeights.get(row)! + VERTICAL_GAP;
  }

  const nodeList: FlowNodeData[] = [];
  const placed = new Map<string, FlowNodeData>();
  let minX = 0;
  let maxX = 0;

  const push = (data: FlowNodeData): void => {
    nodeList.push(data);
    placed.set(data.id, data);
    minX = Math.min(minX, data.x);
    maxX = Math.max(maxX, data.x + data.width);
  };

  const place = (id: string, anchor: number): void => {
    if (placed.has(id)) return;
    const node = graph.nodes.get(id)!;
    const top = rowTops.get(depth.get(id) ?? 0) ?? PADDING;

    if (node.type === "choice") {
      push({
        id: node.id,
        sceneId: node.sceneId,
        instruction: node.instruction,
        label: node.label,
        dateLabel: node.label,
        type: "choice",
        arc: node.arc,
        options: node.options.length ? node.options : undefined,
        x: Math.round(anchor - CHIP_WIDTH / 2),
        y: Math.round(top),
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT,
        parentIds: graph.parentOf.has(id) ? [graph.parentOf.get(id)!] : [],
      });
      return;
    }

    const cardX = Math.round(anchor - CARD_WIDTH / 2);
    const chips = chipsOf(id);
    push({
      id: node.id,
      sceneId: node.sceneId,
      instruction: node.instruction,
      label: node.label,
      dateLabel: node.date ?? node.label,
      type: node.type,
      arc: node.arc,
      options: node.options.length ? node.options : undefined,
      thumbnailUrl: thumbnailFor(node),
      x: cardX,
      y: Math.round(top),
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      parentIds: graph.parentOf.has(id) ? [graph.parentOf.get(id)!] : [],
      isChoiceFork: chips.length > 0,
    });

    // Choice tabs stack beside the card, so a fork never gets in the way of
    // the scene-to-scene arrows leaving the card's bottom edge.
    chips.forEach((chipId, index) => {
      const chip = graph.nodes.get(chipId)!;
      push({
        id: chip.id,
        sceneId: chip.sceneId,
        instruction: chip.instruction,
        label: chip.label,
        dateLabel: chip.options[0] ?? chip.label,
        type: "choice",
        arc: chip.arc,
        options: chip.options.length ? chip.options : undefined,
        x: cardX + CARD_WIDTH + CHIP_OFFSET,
        y: Math.round(top + index * (CHIP_HEIGHT + CHIP_GAP)),
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT,
        parentIds: [id],
      });
    });

    const kids = childrenOf(id);
    if (!kids.length) return;
    const total = kids.reduce((sum, kid) => sum + halfWidthOf(kid) * 2, 0) + (kids.length - 1) * HORIZONTAL_GAP;
    let cursor = anchor - total / 2;
    for (const kid of kids) {
      const half = halfWidthOf(kid);
      place(kid, cursor + half);
      cursor += half * 2 + HORIZONTAL_GAP;
    }
  };

  let cursorX = PADDING;
  for (const root of roots) {
    if (placed.has(root)) continue;
    const half = halfWidthOf(root);
    place(root, cursorX + half);
    cursorX += half * 2 + HORIZONTAL_GAP;
  }
  // Anything the roots cannot reach still belongs on the chart.
  for (const id of graph.order) {
    if (placed.has(id) || !visible(id)) continue;
    const half = halfWidthOf(id);
    place(id, cursorX + half);
    cursorX += half * 2 + HORIZONTAL_GAP;
  }

  const edgeList: FlowEdgeData[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const isChoice = to.type === "choice";
    edgeList.push({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      fromSceneId: from.sceneId,
      label: edge.label,
      // Choice forks leave the card's right edge into the tab; scene
      // transitions leave the card's bottom edge and enter the child's top.
      fromX: isChoice ? from.x + from.width : Math.round(from.x + from.width / 2),
      fromY: isChoice ? Math.round(to.y + to.height / 2) : from.y + from.height,
      toX: isChoice ? to.x : Math.round(to.x + to.width / 2),
      toY: isChoice ? Math.round(to.y + to.height / 2) : to.y,
      isChoice,
    });
  }

  let maxY = 0;
  for (const node of nodeList) maxY = Math.max(maxY, node.y + node.height);

  return {
    nodes: nodeList,
    edges: edgeList,
    bounds: {
      width: Math.max(maxX - Math.min(minX, 0) + PADDING * 2, 720),
      height: Math.max(maxY + PADDING * 2, 480),
    },
    visibleSceneCount: nodeList.filter((node) => node.type !== "choice").length,
  };
}

function resolveAssetUrl(manifest: GameManifest, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const aliasId = manifest.assetAliases?.[name.toUpperCase()];
  if (aliasId) {
    const asset = manifest.assets?.[aliasId];
    if (asset) return asset.url;
  }
  const direct = manifest.assets?.[name];
  return direct ? direct.url : undefined;
}

export const FlowchartView: React.FC<FlowchartViewProps> = ({
  manifest,
  state,
  onJumpToScene,
  onClose,
}) => {
  const [selectedArc, setSelectedArc] = useState<FlowchartArc>("all");
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<FlowNodeData | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const didFitRef = useRef(false);

  const graph = useMemo(() => buildFlowchartGraph(manifest.flowchart), [manifest.flowchart]);

  const visitedScenes = useMemo(() => {
    const visited = new Set<string>();
    try {
      const saved = localStorage.getItem("air_discovered_scenes");
      if (saved) {
        for (const id of JSON.parse(saved) as string[]) visited.add(id);
      }
    } catch {
      // Ignore storage errors
    }

    if (manifest.startScene) visited.add(manifest.startScene);
    if (state.sceneId) visited.add(state.sceneId);
    for (const entry of state.backlog) {
      if (entry.sceneId) visited.add(entry.sceneId);
      const prefix = entry.id.split(":")[0];
      if (prefix) visited.add(prefix);
    }
    for (const item of state.selectionHistory) {
      if (item.sceneId) visited.add(item.sceneId);
    }

    // Reveal the path: a visited scene also marks the scenes leading to it, so
    // the chart shows a route rather than scattered islands. The parents come
    // from the manifest graph, not from a curated tree.
    for (const sceneId of [...visited]) {
      let current = graph.parentOf.get(`${sceneId}:scene`) ?? graph.parentOf.get(sceneId);
      let guard = 0;
      while (current && guard++ < 512) {
        const scene = graph.nodes.get(current)?.sceneId ?? current.replace(/:scene$/, "");
        if (visited.has(scene)) break;
        visited.add(scene);
        current = graph.parentOf.get(current);
      }
    }

    try {
      localStorage.setItem("air_discovered_scenes", JSON.stringify([...visited]));
    } catch {
      // Ignore storage errors
    }

    return visited;
  }, [graph, manifest.startScene, state.backlog, state.sceneId, state.selectionHistory]);

  /**
   * Card image: the backdrop name recorded on the node while preparing. Packed
   * builds only expose a scene program after it has been loaded, so the
   * fallback reads `peekScene` (never `manifest.scenes[...].instructions`).
   */
  const thumbnailFor = useCallback(
    (node: GraphNode): string | undefined => {
      const recorded = resolveAssetUrl(manifest, node.thumb);
      if (recorded) return recorded;
      const scene = peekScene(manifest, node.sceneId);
      if (!scene) return undefined;
      for (const instruction of scene.instructions) {
        if (instruction.op === "image" && instruction.asset) {
          const asset = manifest.assets?.[instruction.asset];
          if (asset) return asset.url;
        }
      }
      return undefined;
    },
    [manifest, manifest.assetAliases, manifest.assets],
  );

  const isVisible = useCallback(
    (node: GraphNode) => {
      if (selectedArc === "all") return true;
      // A node whose arc is unknown (a hand-written or synthetic manifest) is
      // kept visible: hiding data the manifest cannot classify would be worse
      // than showing one extra card.
      if (node.arc === "all") return true;
      // The manifest arcs are real reachability from the three story entries,
      // and no scene transition crosses arcs, so this filter is exact.
      return node.arc === selectedArc;
    },
    [selectedArc],
  );

  const { nodes, edges, bounds, visibleSceneCount } = useMemo(
    () => layoutFlowchart(graph, isVisible, thumbnailFor),
    [graph, isVisible, thumbnailFor],
  );

  /**
   * Fit the chart's *width* to the window and start at the top. The chart is 29
   * rows tall, so fitting both axes would shrink the cards into an unreadable
   * grid; the player reads downward and scrolls as the story advances.
   */
  const fitToView = useCallback(() => {
    const container = containerRef.current;
    if (!container || !bounds.width) return;
    const next = Math.min(1, Math.max(0.3, (container.clientWidth - 48) / bounds.width));
    setZoom(next);
    setPan({
      x: Math.round((container.clientWidth - bounds.width * next) / 2),
      y: 16,
    });
  }, [bounds.width]);

  // A 204-node chart does not fit at 100%, so open fitted once.
  useEffect(() => {
    if (didFitRef.current) return;
    if (!bounds.width) return;
    didFitRef.current = true;
    fitToView();
  }, [bounds.width, fitToView]);

  const handleMouseDown = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest(".flow-card, .flow-toolbar, .flow-tabs")) return;
    setIsDragging(true);
    setDragStart({ x: event.clientX - pan.x, y: event.clientY - pan.y });
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: event.clientX - dragStart.x,
      y: event.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Lock document body scroll when Flowchart is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  // Attach non-passive wheel listener: scroll up/down and left/right naturally
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl + Wheel: Zoom in / out
        const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
        setZoom((prev) => Math.min(Math.max(prev * zoomFactor, MIN_ZOOM), MAX_ZOOM));
      } else {
        // Normal Wheel: Pan Vertically & Horizontally (Up, Down, Left, Right)
        setPan((prev) => ({
          x: Math.round(prev.x - e.deltaX),
          y: Math.round(prev.y - e.deltaY),
        }));
      }
    };
    container.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => container.removeEventListener("wheel", onNativeWheel);
  }, []);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev * 1.2, MAX_ZOOM));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev * 0.8, MIN_ZOOM));
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleCenterCurrent = () => {
    const currentNode = nodes.find((n) => n.type !== "choice" && n.sceneId === state.sceneId);
    if (!currentNode || !containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    const nextZoom = Math.max(zoom, 0.6);
    setZoom(nextZoom);
    setPan({
      x: containerWidth / 2 - (currentNode.x + currentNode.width / 2) * nextZoom,
      y: containerHeight / 3 - (currentNode.y + currentNode.height / 2) * nextZoom,
    });
  };

  const handleNodeClick = (node: FlowNodeData) => {
    const isUnlocked = visitedScenes.has(node.sceneId) || node.sceneId === manifest.startScene;
    if (!isUnlocked) return;
    // Choice nodes are NOT jumpable. A `select` reads its option text from
    // string memory that only the earlier part of the scene populates, so
    // resuming at the fork shows whatever text happens to be left over from the
    // previous scene — mislabelled options the player can actually pick.
    // Jumping to the scene's start replays the route up to the fork instead.
    if (node.type === "choice") {
      onJumpToScene?.(node.sceneId, 0);
      return;
    }
    onJumpToScene?.(node.sceneId, node.instruction);
  };

  const discoveredCount = useMemo(
    () => nodes.filter((node) => node.type !== "choice" && (visitedScenes.has(node.sceneId) || node.sceneId === manifest.startScene)).length,
    [manifest.startScene, nodes, visitedScenes],
  );

  const percent = visibleSceneCount ? Math.round((discoveredCount / visibleSceneCount) * 100) : 0;

  return (
    <div className="flowchart-fullscreen" role="dialog" aria-modal="true" aria-label="Story Flowchart">
      <div className="flow-header">
        <div className="flow-title-group">
          <h2>Story Flowchart</h2>
          <span className="flow-stats">
            {discoveredCount} / {visibleSceneCount} Discovered ({percent}%)
          </span>
        </div>

        <div className="flow-tabs">
          {ARC_FILTERS.map((filter) => (
            <button
              key={filter.value}
              className={selectedArc === filter.value ? "active" : ""}
              onClick={() => setSelectedArc(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {onClose && (
          <button className="flow-close-btn" onClick={onClose} aria-label="Close Flowchart">
            ✕ Close
          </button>
        )}
      </div>

      <div
        ref={containerRef}
        className={`flow-canvas-container ${isDragging ? "dragging" : ""}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="flow-canvas-content"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            width: bounds.width,
            height: bounds.height,
          }}
        >
          <svg className="flow-svg-layer" width={bounds.width} height={bounds.height}>
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {edges.map((edge) => {
              const isTraversed = visitedScenes.has(edge.fromSceneId);
              const yMid = Math.round(edge.fromY + (edge.toY - edge.fromY) / 2);
              const pathD = edge.isChoice
                ? `M ${edge.fromX} ${edge.fromY} h ${CHIP_OFFSET / 2} V ${edge.toY} H ${edge.toX}`
                : `M ${edge.fromX} ${edge.fromY} V ${yMid} H ${edge.toX} V ${edge.toY}`;

              return (
                <g key={edge.id} className="flow-edge-group">
                  <path
                    d={pathD}
                    className={`flow-edge-path ${isTraversed ? "traversed" : "locked"}`}
                    stroke={isTraversed ? "#38bdf8" : "#334155"}
                    strokeWidth={isTraversed ? 2.5 : 1.8}
                    fill="none"
                  />
                  {edge.label && !edge.isChoice && isTraversed && (
                    <text
                      x={edge.toX}
                      y={yMid - 6}
                      className="flow-edge-label"
                      textAnchor="middle"
                    >
                      {edge.label.length > 28 ? edge.label.slice(0, 26) + "…" : edge.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {nodes.map((node) => {
            const isUnlocked = visitedScenes.has(node.sceneId) || node.sceneId === manifest.startScene;
            const isActive = node.type !== "choice" && node.sceneId === state.sceneId;
            const isChoice = node.type === "choice";

            return (
              <div
                key={node.id}
                className={`flow-card-wrapper ${isActive ? "active" : ""} ${
                  isUnlocked ? "unlocked" : "locked"
                }`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                }}
                title={isChoice && node.options ? node.options.join(" / ") : undefined}
                onClick={() => handleNodeClick(node)}
                onMouseEnter={() => setHoveredNode(node)}
                onMouseLeave={() => setHoveredNode(null)}
              >
                {node.isChoiceFork && (
                  <div className="flow-choice-diamond" title="Choice point">
                    ?
                  </div>
                )}

                <div className="flow-card">
                  {isUnlocked ? (
                    isChoice ? (
                      <div className="flow-card-badge">
                        <span>{node.options?.[0] ?? "Choice"}</span>
                        {(node.options?.length ?? 0) > 1 ? <span>{` +${node.options!.length - 1}`}</span> : null}
                      </div>
                    ) : (
                      <>
                        {node.thumbnailUrl ? (
                          <ResolvedImage
                            className="flow-card-img"
                            url={node.thumbnailUrl}
                            alt={node.label}
                            loading="lazy"
                          />
                        ) : (
                          <div className="flow-card-placeholder-bg" />
                        )}
                        <div className="flow-card-badge">
                          <span>{node.dateLabel ?? node.label}</span>
                        </div>
                        {node.type === "ending" && <div className="flow-ending-star">★</div>}
                      </>
                    )
                  ) : (
                    <div className="flow-card-locked-body">
                      <svg className="flow-locked-x" viewBox="0 0 100 70" preserveAspectRatio="none">
                        <line x1="0" y1="0" x2="100" y2="70" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
                        <line x1="100" y1="0" x2="0" y2="70" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
                        <rect x="1" y="1" width="98" height="68" rx="6" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flow-toolbar">
        <button onClick={handleZoomIn} title="Zoom In">
          +
        </button>
        <button onClick={handleZoomOut} title="Zoom Out">
          −
        </button>
        <button onClick={handleResetView} title="Reset View (100%)">
          100%
        </button>
        <button onClick={fitToView} title="Fit Chart to Window">
          Fit
        </button>
        <button onClick={handleCenterCurrent} title="Center Current Scene">
          📍 Center
        </button>
      </div>

      {hoveredNode && (
        <div className="flow-tooltip">
          <strong>{hoveredNode.label}</strong>
          <small>
            Scene: {hoveredNode.sceneId}
            {hoveredNode.type === "choice" ? ` · instruction ${hoveredNode.instruction}` : ""}
            {hoveredNode.type === "ending" ? " · ending" : ""}
            {" · "}
            {visitedScenes.has(hoveredNode.sceneId) ? "✓ Discovered (Click to jump)" : "🔒 Undiscovered"}
          </small>
          {hoveredNode.options && hoveredNode.options.length > 0 && (
            <div className="flow-tooltip-options">
              {hoveredNode.options.map((opt, i) => (
                <div key={i}>• {opt || "(unresolved)"}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
