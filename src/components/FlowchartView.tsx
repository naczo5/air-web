import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameManifest, RuntimeState } from "../types";

export type FlowchartArc = "all" | "dream" | "misuzu" | "kano" | "minagi" | "summer" | "air";

export interface FlowNodeData {
  id: string;
  sceneId: string;
  instruction: number;
  label: string;
  dateLabel?: string;
  type: "scene" | "choice" | "ending";
  arc: "dream" | "misuzu" | "kano" | "minagi" | "summer" | "air" | "other";
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

interface StoryTreeNodeDef {
  id: string;
  sceneId: string;
  instruction?: number;
  label: string;
  dateLabel?: string;
  type: "scene" | "choice" | "ending";
  arc: "dream" | "misuzu" | "kano" | "minagi" | "summer" | "air";
  bgAlias?: string;
  options?: string[];
  children?: StoryTreeNodeDef[];
}

const STORY_TREE_ROOT: StoryTreeNodeDef = {
      id: "seen0170:scene",
      sceneId: "seen0170",
      instruction: 0,
      label: "July 17 (Monday)",
      dateLabel: "7/17 Prologue",
      type: "scene",
      arc: "dream",
      bgAlias: "FGMZ15D",
      children: [
        {
          id: "seen0180:scene",
          sceneId: "seen0180",
          instruction: 0,
          label: "July 18 (Tuesday)",
          dateLabel: "7/18 Town Arrival",
          type: "scene",
          arc: "dream",
          bgAlias: "BG008",
          children: [
            {
              id: "seen0180:choice:255",
              sceneId: "seen0180",
              instruction: 255,
              label: "Search for puppet",
              dateLabel: "Choice: Puppet Search",
              type: "choice",
              arc: "dream",
              options: ["Find other ways", "Go look for my puppet"],
              children: [
                {
                  id: "seen0180:choice:1443",
                  sceneId: "seen0180",
                  instruction: 1443,
                  label: "Meet Misuzu Kamio",
                  dateLabel: "Choice: Misuzu Encounter",
                  type: "choice",
                  arc: "dream",
                  options: ["Walk away", "Run away"],
                  children: [
                    {
                      id: "seen0190:scene",
                      sceneId: "seen0190",
                      instruction: 0,
                      label: "July 19 (Wednesday)",
                      dateLabel: "7/19 Sea Breeze",
                      type: "scene",
                      arc: "dream",
                      bgAlias: "BG007o",
                      children: [
                        {
                          id: "seen0200:scene",
                          sceneId: "seen0200",
                          instruction: 0,
                          label: "July 20 (Thursday)",
                          dateLabel: "7/20 Clinic & Beach",
                          type: "scene",
                          arc: "dream",
                          bgAlias: "BG030",
                          children: [
                            {
                              id: "seen0210:scene",
                              sceneId: "seen0210",
                              instruction: 0,
                              label: "July 21 (Friday)",
                              dateLabel: "7/21 Sunset Station",
                              type: "scene",
                              arc: "dream",
                              bgAlias: "BG018Y",
                              children: [
                                {
                                  id: "seen0220:scene",
                                  sceneId: "seen0220",
                                  instruction: 0,
                                  label: "July 22 (Saturday)",
                                  dateLabel: "7/22 Festival",
                                  type: "scene",
                                  arc: "dream",
                                  bgAlias: "BG003",
                                  children: [
                                    {
                                      id: "seen0230:scene",
                                      sceneId: "seen0230",
                                      instruction: 0,
                                      label: "July 23 (Sunday) - Branch Point",
                                      dateLabel: "7/23 Branch Split",
                                      type: "choice",
                                      arc: "dream",
                                      options: ["Misuzu Path", "Kano Path", "Minagi Path", "Common Path"],
                                      children: [
                                        {
                                          id: "seen0275:scene",
                                          sceneId: "seen0275",
                                          instruction: 0,
                                          label: "July 27 (Misuzu Route)",
                                          dateLabel: "7/27 Misuzu",
                                          type: "scene",
                                          arc: "misuzu",
                                          bgAlias: "BG005",
                                          children: [
                                            {
                                              id: "seen0285:scene",
                                              sceneId: "seen0285",
                                              instruction: 0,
                                              label: "July 28 (Misuzu)",
                                              dateLabel: "7/28 Misuzu",
                                              type: "scene",
                                              arc: "misuzu",
                                              bgAlias: "BG006",
                                              children: [
                                                {
                                                  id: "seen0295:scene",
                                                  sceneId: "seen0295",
                                                  instruction: 0,
                                                  label: "July 29 (Misuzu)",
                                                  dateLabel: "7/29 Misuzu",
                                                  type: "scene",
                                                  arc: "misuzu",
                                                  bgAlias: "BG007",
                                                  children: [
                                                    {
                                                      id: "seen0305:scene",
                                                      sceneId: "seen0305",
                                                      instruction: 0,
                                                      label: "July 30 (Misuzu)",
                                                      dateLabel: "7/30 Misuzu",
                                                      type: "scene",
                                                      arc: "misuzu",
                                                      bgAlias: "BG008",
                                                      children: [
                                                        {
                                                          id: "seen0315:scene",
                                                          sceneId: "seen0315",
                                                          instruction: 0,
                                                          label: "July 31 (Misuzu Dream End)",
                                                          dateLabel: "7/31 Misuzu End",
                                                          type: "ending",
                                                          arc: "misuzu",
                                                          bgAlias: "BG007N",
                                                        },
                                                      ],
                                                    },
                                                  ],
                                                },
                                              ],
                                            },
                                          ],
                                        },
                                        {
                                          id: "seen0277:scene",
                                          sceneId: "seen0277",
                                          instruction: 0,
                                          label: "July 27 (Kano Route)",
                                          dateLabel: "7/27 Kano",
                                          type: "scene",
                                          arc: "kano",
                                          bgAlias: "BG030",
                                          children: [
                                            {
                                              id: "seen0287:scene",
                                              sceneId: "seen0287",
                                              instruction: 0,
                                              label: "July 28 (Kano)",
                                              dateLabel: "7/28 Kano",
                                              type: "scene",
                                              arc: "kano",
                                              bgAlias: "BG031",
                                              children: [
                                                {
                                                  id: "seen0297:scene",
                                                  sceneId: "seen0297",
                                                  instruction: 0,
                                                  label: "July 29 (Kano)",
                                                  dateLabel: "7/29 Kano",
                                                  type: "scene",
                                                  arc: "kano",
                                                  bgAlias: "BG032",
                                                  children: [
                                                    {
                                                      id: "seen0317:scene",
                                                      sceneId: "seen0317",
                                                      instruction: 0,
                                                      label: "July 31 (Kano)",
                                                      dateLabel: "7/31 Kano",
                                                      type: "scene",
                                                      arc: "kano",
                                                      bgAlias: "BG032",
                                                      children: [
                                                        {
                                                          id: "seen0506:scene",
                                                          sceneId: "seen0506",
                                                          instruction: 0,
                                                          label: "August 13 (Kano Epilogue)",
                                                          dateLabel: "8/13 Kano End",
                                                          type: "ending",
                                                          arc: "kano",
                                                          bgAlias: "BG030",
                                                        },
                                                      ],
                                                    },
                                                  ],
                                                },
                                              ],
                                            },
                                          ],
                                        },
                                        {
                                          id: "seen0601:scene",
                                          sceneId: "seen0601",
                                          instruction: 0,
                                          label: "August 1 (Minagi Route)",
                                          dateLabel: "8/1 Minagi",
                                          type: "scene",
                                          arc: "minagi",
                                          bgAlias: "BG018",
                                          children: [
                                            {
                                              id: "seen0603:scene",
                                              sceneId: "seen0603",
                                              instruction: 0,
                                              label: "August 3 (Rooftop)",
                                              dateLabel: "8/3 Minagi",
                                              type: "scene",
                                              arc: "minagi",
                                              bgAlias: "BG019",
                                              children: [
                                                {
                                                  id: "seen0608:scene",
                                                  sceneId: "seen0608",
                                                  instruction: 0,
                                                  label: "August 8 (Michiru)",
                                                  dateLabel: "8/8 Michiru",
                                                  type: "scene",
                                                  arc: "minagi",
                                                  bgAlias: "BG020",
                                                  children: [
                                                    {
                                                      id: "seen0614:scene",
                                                      sceneId: "seen0614",
                                                      instruction: 0,
                                                      label: "Minagi Epilogue",
                                                      dateLabel: "Minagi End",
                                                      type: "ending",
                                                      arc: "minagi",
                                                      bgAlias: "BG018Y",
                                                    },
                                                  ],
                                                },
                                              ],
                                            },
                                          ],
                                        },
                                        {
                                          id: "seen0240:scene",
                                          sceneId: "seen0240",
                                          instruction: 0,
                                          label: "July 24 (Common)",
                                          dateLabel: "7/24 Common",
                                          type: "scene",
                                          arc: "dream",
                                          bgAlias: "BG008",
                                          children: [
                                            {
                                              id: "seen0700:scene",
                                              sceneId: "seen0700",
                                              instruction: 0,
                                              label: "Summer Arc: [ Shinto Shrine ] / Ryuuya",
                                              dateLabel: "Summer Arc",
                                              type: "scene",
                                              arc: "summer",
                                              bgAlias: "BG040",
                                              children: [
                                                {
                                                  id: "seen0701:scene",
                                                  sceneId: "seen0701",
                                                  instruction: 0,
                                                  label: "Summer Arc: [ Mountain Path ]",
                                                  dateLabel: "Summer 2",
                                                  type: "scene",
                                                  arc: "summer",
                                                  bgAlias: "BG041",
                                                  children: [
                                                    {
                                                      id: "seen0703:scene",
                                                      sceneId: "seen0703",
                                                      instruction: 0,
                                                      label: "Summer Arc: [ Skydream ]",
                                                      dateLabel: "Summer End",
                                                      type: "ending",
                                                      arc: "summer",
                                                      bgAlias: "BG043",
                                                      children: [
                                                        {
                                                          id: "seen0400:scene",
                                                          sceneId: "seen0400",
                                                          instruction: 0,
                                                          label: "AIR Arc: August 1 / Sora",
                                                          dateLabel: "AIR Arc (Sora)",
                                                          type: "scene",
                                                          arc: "air",
                                                          bgAlias: "BG009",
                                                          children: [
                                                            {
                                                              id: "seen0410:scene",
                                                              sceneId: "seen0410",
                                                              instruction: 0,
                                                              label: "August 5 / Sora",
                                                              dateLabel: "AIR 8/5",
                                                              type: "scene",
                                                              arc: "air",
                                                              bgAlias: "BG008",
                                                              children: [
                                                                {
                                                                  id: "seen0420:scene",
                                                                  sceneId: "seen0420",
                                                                  instruction: 0,
                                                                  label: "August 8 / Sora",
                                                                  dateLabel: "AIR 8/8",
                                                                  type: "scene",
                                                                  arc: "air",
                                                                  bgAlias: "BG005",
                                                                  children: [
                                                                    {
                                                                      id: "seen0440:scene",
                                                                      sceneId: "seen0440",
                                                                      instruction: 0,
                                                                      label: "AIR Epilogue / Sora",
                                                                      dateLabel: "AIR Epilogue",
                                                                      type: "scene",
                                                                      arc: "air",
                                                                      bgAlias: "BG008",
                                                                      children: [
                                                                        {
                                                                          id: "seen0444:scene",
                                                                          sceneId: "seen0444",
                                                                          instruction: 0,
                                                                          label: "A Fresh Start (True Ending)",
                                                                          dateLabel: "AIR True End",
                                                                          type: "ending",
                                                                          arc: "air",
                                                                          bgAlias: "BG009",
                                                                        },
                                                                      ],
                                                                    },
                                                                  ],
                                                                },
                                                              ],
                                                            },
                                                          ],
                                                        },
                                                      ],
                                                    },
                                                  ],
                                                },
                                              ],
                                            },
                                          ],
                                        },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

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

    // Build parent map from storyTreeRoot to propagate unlocked status to all ancestors
    const parentMap = new Map<string, string>();
    const registerParents = (node: StoryTreeNodeDef) => {
      if (node.children) {
        for (const child of node.children) {
          parentMap.set(child.sceneId, node.sceneId);
          registerParents(child);
        }
      }
    };
    registerParents(STORY_TREE_ROOT);

    // Propagate ancestors: if a descendant node is visited, all its ancestor nodes are unlocked
    const initialVisited = Array.from(visited);
    for (const sceneId of initialVisited) {
      let current: string | undefined = sceneId;
      while (current) {
        visited.add(current);
        current = parentMap.get(current);
      }
    }

    try {
      localStorage.setItem("air_discovered_scenes", JSON.stringify(Array.from(visited)));
    } catch {
      // Ignore storage errors
    }

    return visited;
  }, [manifest.startScene, state.backlog, state.sceneId, state.selectionHistory]);

  const resolveThumbnail = useCallback(
    (sceneId: string, bgAlias?: string): string | undefined => {
      if (bgAlias) {
        const aliasId = manifest.assetAliases?.[bgAlias.toUpperCase()];
        if (aliasId && manifest.assets[aliasId]) return manifest.assets[aliasId].url;
        if (manifest.assets[bgAlias]) return manifest.assets[bgAlias].url;
      }
      const sceneThumbMap: Record<string, string> = {
        seen0170: "FGMZ15D",
        seen0180: "BG008",
        seen0190: "BG007o",
        seen0200: "BG030",
        seen0210: "BG018Y",
        seen0220: "BG003",
        seen0230: "BG005",
        seen0275: "BG005",
        seen0285: "BG006",
        seen0295: "BG007",
        seen0305: "BG008",
        seen0315: "BG007N",
        seen0277: "BG030",
        seen0287: "BG031",
        seen0297: "BG032",
        seen0307: "BG030",
        seen0317: "BG032",
        seen0501: "BG030",
        seen0601: "BG018",
        seen0603: "BG019",
        seen0608: "BG020",
        seen0614: "BG018Y",
        seen0700: "BG040",
        seen0701: "BG041",
        seen0702: "BG042",
        seen0703: "BG043",
        seen0400: "BG009",
        seen0410: "BG008",
        seen0420: "BG005",
        seen0430: "BG007N",
        seen0440: "BG008",
        seen0444: "BG009",
      };

      const thumbAlias = sceneThumbMap[sceneId];
      if (thumbAlias) {
        const aliasId = manifest.assetAliases?.[thumbAlias.toUpperCase()];
        if (aliasId && manifest.assets[aliasId]) return manifest.assets[aliasId].url;
        if (manifest.assets[thumbAlias]) return manifest.assets[thumbAlias].url;
      }

      const scene = manifest.scenes[sceneId];
      if (!scene) return undefined;
      for (const inst of scene.instructions) {
        if (inst.op === "image" && inst.asset && manifest.assets[inst.asset]) {
          return manifest.assets[inst.asset].url;
        }
      }
      return undefined;
    },
    [manifest.assetAliases, manifest.assets, manifest.scenes]
  );



  const { nodes, edges, bounds } = useMemo(() => {
    const nodeList: FlowNodeData[] = [];
    const edgeList: FlowEdgeData[] = [];

    const CARD_WIDTH = 96;
    const CARD_HEIGHT = 64;
    const HORIZONTAL_GAP = 36;
    const VERTICAL_GAP = 54;

    const filterMatches = (nodeDef: StoryTreeNodeDef): boolean => {
      if (selectedArc === "all") return true;
      if (selectedArc === "dream") return nodeDef.arc === "dream";
      if (selectedArc === "misuzu") return nodeDef.arc === "dream" || nodeDef.arc === "misuzu";
      if (selectedArc === "kano") return nodeDef.arc === "dream" || nodeDef.arc === "kano";
      if (selectedArc === "minagi") return nodeDef.arc === "dream" || nodeDef.arc === "minagi";
      if (selectedArc === "summer") return nodeDef.arc === "dream" || nodeDef.arc === "summer";
      if (selectedArc === "air") return nodeDef.arc === "dream" || nodeDef.arc === "summer" || nodeDef.arc === "air";
      return true;
    };

    const calculateSubtreeWidth = (nodeDef: StoryTreeNodeDef): number => {
      const filteredChildren = (nodeDef.children || []).filter(filterMatches);
      if (!filteredChildren.length) return CARD_WIDTH;
      let total = 0;
      for (const child of filteredChildren) {
        total += calculateSubtreeWidth(child);
      }
      total += (filteredChildren.length - 1) * HORIZONTAL_GAP;
      return Math.max(CARD_WIDTH, total);
    };

    let minX = 0;
    let maxX = 0;
    let maxY = 0;

    const layoutSubtree = (
      nodeDef: StoryTreeNodeDef,
      xCenter: number,
      yTop: number,
      parentIds: string[]
    ): FlowNodeData => {
      const filteredChildren = (nodeDef.children || []).filter(filterMatches);
      const isChoiceFork = (nodeDef.options && nodeDef.options.length > 1) || filteredChildren.length > 1;

      const nodeData: FlowNodeData = {
        id: nodeDef.id,
        sceneId: nodeDef.sceneId,
        instruction: nodeDef.instruction ?? 0,
        label: nodeDef.label,
        dateLabel: nodeDef.dateLabel,
        type: nodeDef.type,
        arc: nodeDef.arc,
        options: nodeDef.options,
        thumbnailUrl: resolveThumbnail(nodeDef.sceneId, nodeDef.bgAlias),
        x: Math.round(xCenter - CARD_WIDTH / 2),
        y: Math.round(yTop),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        parentIds,
        isChoiceFork,
      };

      nodeList.push(nodeData);

      minX = Math.min(minX, nodeData.x);
      maxX = Math.max(maxX, nodeData.x + CARD_WIDTH);
      maxY = Math.max(maxY, nodeData.y + CARD_HEIGHT);

      if (filteredChildren.length > 0) {
        const totalChildrenWidth = calculateSubtreeWidth(nodeDef);
        let currentChildX = xCenter - totalChildrenWidth / 2;
        const childY = yTop + CARD_HEIGHT + VERTICAL_GAP;

        for (let i = 0; i < filteredChildren.length; i++) {
          const childDef = filteredChildren[i];
          const childSubtreeWidth = calculateSubtreeWidth(childDef);
          const childCenterX = currentChildX + childSubtreeWidth / 2;

          layoutSubtree(childDef, childCenterX, childY, [nodeDef.id]);

          edgeList.push({
            id: `${nodeDef.id}->${childDef.id}`,
            from: nodeDef.id,
            to: childDef.id,
            label: nodeDef.options?.[i] ?? "",
            fromX: Math.round(xCenter),
            fromY: Math.round(yTop + CARD_HEIGHT),
            toX: Math.round(childCenterX),
            toY: Math.round(childY),
            isChoice: isChoiceFork,
          });

          currentChildX += childSubtreeWidth + HORIZONTAL_GAP;
        }
      }

      return nodeData;
    };

    layoutSubtree(STORY_TREE_ROOT, 400, 40, []);

    const padding = 60;
    const offsetX = -minX + padding;
    const offsetY = padding;

    for (const node of nodeList) {
      node.x += offsetX;
      node.y += offsetY;
    }
    for (const edge of edgeList) {
      edge.fromX += offsetX;
      edge.fromY += offsetY;
      edge.toX += offsetX;
      edge.toY += offsetY;
    }

    return {
      nodes: nodeList,
      edges: edgeList,
      bounds: {
        width: maxX - minX + padding * 2 + 100,
        height: maxY + padding * 2 + 100,
      },
    };
  }, [resolveThumbnail, selectedArc]);

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
        setZoom((prev) => Math.min(Math.max(prev * zoomFactor, 0.35), 2.2));
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

  const handleZoomIn = () => setZoom((prev) => Math.min(prev * 1.2, 2.2));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev * 0.8, 0.35));
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleCenterCurrent = () => {
    const currentNode = nodes.find((n) => n.sceneId === state.sceneId);
    if (!currentNode || !containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    setZoom(1);
    setPan({
      x: containerWidth / 2 - currentNode.x - currentNode.width / 2,
      y: containerHeight / 3 - currentNode.y - currentNode.height / 2,
    });
  };

  const handleNodeClick = (node: FlowNodeData) => {
    const isUnlocked = visitedScenes.has(node.sceneId) || node.sceneId === manifest.startScene;
    if (!isUnlocked) return;
    if (onJumpToScene) {
      onJumpToScene(node.sceneId, node.instruction);
    }
  };

  const discoveredCount = useMemo(() => {
    return nodes.filter((n) => visitedScenes.has(n.sceneId) || n.sceneId === manifest.startScene).length;
  }, [manifest.startScene, nodes, visitedScenes]);

  return (
    <div className="flowchart-fullscreen" role="dialog" aria-modal="true" aria-label="Story Flowchart">
      <div className="flow-header">
        <div className="flow-title-group">
          <h2>Story Flowchart</h2>
          <span className="flow-stats">
            {discoveredCount} / {nodes.length} Discovered ({Math.round((discoveredCount / nodes.length) * 100)}%)
          </span>
        </div>

        <div className="flow-tabs">
          <button
            className={selectedArc === "all" ? "active" : ""}
            onClick={() => setSelectedArc("all")}
          >
            All Arcs
          </button>
          <button
            className={selectedArc === "dream" ? "active" : ""}
            onClick={() => setSelectedArc("dream")}
          >
            Dream Arc
          </button>
          <button
            className={selectedArc === "misuzu" ? "active" : ""}
            onClick={() => setSelectedArc("misuzu")}
          >
            Misuzu
          </button>
          <button
            className={selectedArc === "kano" ? "active" : ""}
            onClick={() => setSelectedArc("kano")}
          >
            Kano
          </button>
          <button
            className={selectedArc === "minagi" ? "active" : ""}
            onClick={() => setSelectedArc("minagi")}
          >
            Minagi
          </button>
          <button
            className={selectedArc === "summer" ? "active" : ""}
            onClick={() => setSelectedArc("summer")}
          >
            Summer Arc
          </button>
          <button
            className={selectedArc === "air" ? "active" : ""}
            onClick={() => setSelectedArc("air")}
          >
            AIR Arc
          </button>
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
              const isTraversed =
                visitedScenes.has(edge.from.split(":")[0]) && visitedScenes.has(edge.to.split(":")[0]);
              const yMid = Math.round(edge.fromY + (edge.toY - edge.fromY) / 2);
              const pathD = `M ${edge.fromX} ${edge.fromY} V ${yMid} H ${edge.toX} V ${edge.toY}`;

              return (
                <g key={edge.id} className="flow-edge-group">
                  <path
                    d={pathD}
                    className={`flow-edge-path ${isTraversed ? "traversed" : "locked"}`}
                    stroke={isTraversed ? "#38bdf8" : "#334155"}
                    strokeWidth={isTraversed ? 2.5 : 1.8}
                    fill="none"
                  />
                  {edge.label && isTraversed && (
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
            const isActive = node.sceneId === state.sceneId;

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
                    <>
                      {node.thumbnailUrl ? (
                        <img
                          className="flow-card-img"
                          src={node.thumbnailUrl}
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
                  ) : (
                    <div className="flow-card-locked-body">
                      <svg className="flow-locked-x" viewBox="0 0 100 70">
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
        <button onClick={handleCenterCurrent} title="Center Current Scene">
          📍 Center
        </button>
      </div>

      {hoveredNode && (
        <div className="flow-tooltip">
          <strong>{hoveredNode.label}</strong>
          <small>
            Scene: {hoveredNode.sceneId} · {visitedScenes.has(hoveredNode.sceneId) ? "✓ Discovered (Click to jump)" : "🔒 Undiscovered"}
          </small>
          {hoveredNode.options && hoveredNode.options.length > 0 && (
            <div className="flow-tooltip-options">
              {hoveredNode.options.map((opt, i) => (
                <div key={i}>• {opt}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
