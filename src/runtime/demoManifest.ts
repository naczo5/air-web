import type { GameManifest } from "../types";

export const demoManifest: GameManifest = {
  id: "air-se",
  title: "AIR",
  logicalSize: { width: 640, height: 480 },
  generatedAt: "demo",
  scenes: {
    demo: {
      id: "demo",
      title: "AIR",
      instructions: [
        { op: "text", text: "The AIR web player is ready." },
        { op: "text", text: "Run npm run prepare:air with your original game data to load the full story." },
        { op: "choice", options: ["Start a small test scene", "Return to title"], targets: [3, 0] },
        { op: "text", text: "This vertical slice exercises text, choices, save/load, and the browser UI." },
        { op: "end" },
      ],
    },
  },
  assets: {},
  flowchart: {
    nodes: [
      { id: "demo:0", sceneId: "demo", instruction: 0, label: "Opening" },
      { id: "demo:2", sceneId: "demo", instruction: 2, label: "Choice" },
      { id: "demo:3", sceneId: "demo", instruction: 3, label: "Test scene" },
    ],
    edges: [
      { from: "demo:0", to: "demo:2" },
      { from: "demo:2", to: "demo:3", label: "Start" },
      { from: "demo:2", to: "demo:0", label: "Title" },
    ],
  },
};
