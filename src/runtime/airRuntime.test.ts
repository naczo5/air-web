import { describe, expect, it } from "vitest";
import { AirRuntimeImpl } from "./airRuntime";
import { demoManifest } from "./demoManifest";
import type { GameManifest } from "../types";

describe("AirRuntimeImpl", () => {
  it("pauses at text and advances through a choice", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    const events: string[] = [];
    runtime.onEvent((event) => events.push(event.type));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.at(-1)?.text).toContain("AIR web player");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("choice");
    await runtime.choose(0);
    expect(runtime.state.backlog.at(-1)?.text).toContain("vertical slice");
    expect(events).toContain("choice");
  });

  it("round-trips serializable state", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    const saved = runtime.save();
    await runtime.advance();
    runtime.load(saved);
    expect(runtime.state.instructionPointer).toBe(saved.instructionPointer);
    expect(runtime.state.backlog).toEqual(saved.backlog);
  });

  it("reports invalid instruction pointers without throwing", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    const diagnostics: string[] = [];
    runtime.onEvent((event) => { if (event.type === "diagnostic") diagnostics.push(event.diagnostic.message); });
    runtime.load({ ...runtime.save(), instructionPointer: 999 });
    await runtime.advance();
    expect(diagnostics.some((message) => message.includes("outside scene"))).toBe(true);
  });

  it("resets skip and auto modes for a genuinely new game", () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.setMode("skip");
    runtime.startNewGame();
    expect(runtime.mode).toBe("normal");
  });

  it("continues through a cross-scene jump without exposing trailing data", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "opening",
      scenes: {
        opening: {
          id: "opening",
          instructions: [
            { op: "text", text: "Before transition" },
            { op: "scene", sceneId: "next" },
            { op: "text", text: "Unreachable engine data" },
          ],
        },
        next: {
          id: "next",
          instructions: [{ op: "text", text: "After transition" }, { op: "end" }],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("Before transition");
    await runtime.advance();
    expect(runtime.state.sceneId).toBe("next");
    expect(runtime.state.backlog.at(-1)?.text).toBe("After transition");
    expect(runtime.state.backlog.some((entry) => entry.text.includes("Unreachable"))).toBe(false);
  });

  it("skips only previously read lines in skip-read mode", async () => {
    const readIds: string[] = [];
    const runtime = new AirRuntimeImpl(demoManifest, {
      readTextIds: ["demo:0"],
      onTextRead: (id) => readIds.push(id),
    });
    runtime.setMode("skip-read");
    await runtime.advance();
    expect(runtime.state.instructionPointer).toBe(2);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.map((entry) => entry.text)).toEqual([
      "The AIR web player is ready.",
      "Run npm run prepare:air with your original game data to load the full story.",
    ]);
    expect(readIds).toEqual(["demo:1"]);
  });

  it("skips every encountered line in skip-all mode", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.setMode("skip");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("choice");
  });

  it("returns to and replays the previous choice checkpoint", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.setMode("skip");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("choice");
    await runtime.choose(0);
    expect(runtime.state.backlog.at(-1)?.text).toContain("vertical slice");
    runtime.setMode("normal");
    expect(await runtime.returnToPreviousChoice()).toBe(true);
    expect(runtime.state.waiting).toBe("choice");
    expect(runtime.state.pendingChoice?.options).toHaveLength(2);
  });

  it("composites RealLive background-multi assets into ordered layers", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      assetAliases: { BG: "bg", CHARACTER: "character" },
      assets: {
        bg: { id: "bg", kind: "image", url: "/bg.png" },
        character: { id: "character", kind: "image", url: "/character.png" },
      },
      scenes: {
        opening: {
          id: "opening",
          instructions: [{
            op: "command",
            offset: 0,
            moduleType: 1,
            module: 40,
            opcode: 100,
            argc: 1,
            overload: 1,
            args: [
              { kind: "string", value: "BG" },
              { kind: "special", tag: 2, values: [{ kind: "string", value: "CHARACTER" }] },
            ],
          }, { op: "end" }],
        },
      },
      startScene: "opening",
    };
    const runtime = new AirRuntimeImpl(manifest);
    await runtime.advance();
    expect(runtime.state.layers.slice(0, 2).map((layer) => layer.asset)).toEqual(["bg", "character"]);
    expect(runtime.state.viewedAssets).toEqual(["bg", "character"]);
  });

  it("handles rlBabel localization bridge (2:1:12) and formats dialogue without error fallback", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "dialogue_test",
      scenes: {
        dialogue_test: {
          id: "dialogue_test",
          instructions: [
            // Assign input text to strS[1900]
            {
              op: "command",
              offset: 0,
              moduleType: 1,
              module: 10,
              opcode: 0,
              argc: 2,
              overload: 0,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1900 } } },
                { kind: "string", value: "\u0001Yukito\u0002Good morning!" },
              ],
            },
            // Call rlBabel FormatText (2:1:12 with sub-op 10)
            {
              op: "command",
              offset: 10,
              moduleType: 2,
              module: 1,
              opcode: 12,
              argc: 3,
              overload: 2,
              args: [
                { kind: "expression", value: { kind: "int", value: 0 } },
                { kind: "expression", value: { kind: "int", value: 10 } },
                { kind: "expression", value: { kind: "int", value: 1181548 } },
              ],
            },
            // Print formatted strS[1901] to buffer
            {
              op: "command",
              offset: 20,
              moduleType: 1,
              module: 10,
              opcode: 100,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1901 } } }],
            },
            // Flush dialogue (0:3:17)
            {
              op: "command",
              offset: 30,
              moduleType: 0,
              module: 3,
              opcode: 17,
              argc: 0,
              overload: 0,
              args: [],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    const lastEntry = runtime.state.backlog.at(-1);
    expect(lastEntry?.speaker).toBe("Yukito");
    expect(lastEntry?.text).toBe("Good morning!");
    expect(runtime.state.storeRegister).toBe(1);
  });

  it("emits the immediate first line of dialogue in branch after a choice", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "choice_dialogue_test",
      scenes: {
        choice_dialogue_test: {
          id: "choice_dialogue_test",
          instructions: [
            // Choice definition
            {
              op: "select",
              offset: 0,
              moduleType: 0,
              module: 2,
              opcode: 1,
              argc: 2,
              overload: 0,
              options: [
                { text: "Option A", conditions: [] },
                { text: "Option B", conditions: [] },
              ],
            },
            // Assign choice index to memory[5:399]
            {
              op: "assign",
              offset: 10,
              expression: {
                kind: "binary",
                op: 30,
                left: { kind: "memory", bank: 5, index: { kind: "int", value: 399 } },
                right: { kind: "store" },
              },
            },
            // Branch if memory[5:399] != 0 goto 50
            {
              op: "branch",
              offset: 20,
              moduleType: 0,
              module: 1,
              opcode: 2,
              argc: 0,
              overload: 0,
              kind: "gotoUnless",
              expression: {
                kind: "binary",
                op: 40,
                left: { kind: "memory", bank: 5, index: { kind: "int", value: 399 } },
                right: { kind: "int", value: 0 },
              },
              targets: [6],
            },
            // Option 0 branch: set strS[1900]
            {
              op: "command",
              offset: 30,
              moduleType: 1,
              module: 10,
              opcode: 0,
              argc: 2,
              overload: 0,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1900 } } },
                { kind: "string", value: "You picked Option A!" },
              ],
            },
            {
              op: "command",
              offset: 40,
              moduleType: 1,
              module: 10,
              opcode: 100,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1901 } } }],
            },
            // Flush dialogue (0:3:17)
            {
              op: "command",
              offset: 45,
              moduleType: 0,
              module: 3,
              opcode: 17,
              argc: 0,
              overload: 0,
              args: [],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.waiting).toBe("choice");
    await runtime.choose(0);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.at(-1)?.text).toBe("You picked Option A!");
  });

  it("handles string manipulation opcodes str_len, str_cmp, and str_copy_part", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "str_test",
      scenes: {
        str_test: {
          id: "str_test",
          instructions: [
            // strS[10] = "AIR"
            {
              op: "command",
              offset: 0,
              moduleType: 1,
              module: 10,
              opcode: 0,
              argc: 2,
              overload: 0,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 10 } } },
                { kind: "string", value: "AIR" },
              ],
            },
            // str_len(strS[10]) -> $store
            {
              op: "command",
              offset: 10,
              moduleType: 1,
              module: 10,
              opcode: 3,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 10 } } }],
            },
            // assign mem[0:1] = $store
            {
              op: "assign",
              offset: 20,
              expression: {
                kind: "binary",
                op: 30,
                left: { kind: "memory", bank: 0, index: { kind: "int", value: 1 } },
                right: { kind: "store" },
              },
            },
            // str_cmp(strS[10], "AIR") -> $store == 0
            {
              op: "command",
              offset: 30,
              moduleType: 1,
              module: 10,
              opcode: 4,
              argc: 2,
              overload: 0,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 10 } } },
                { kind: "string", value: "AIR" },
              ],
            },
            // assign mem[0:2] = $store
            {
              op: "assign",
              offset: 40,
              expression: {
                kind: "binary",
                op: 30,
                left: { kind: "memory", bank: 0, index: { kind: "int", value: 2 } },
                right: { kind: "store" },
              },
            },
            // str_copy_part: strS[11] = slice(strS[10], 1, 2) -> "IR"
            {
              op: "command",
              offset: 50,
              moduleType: 1,
              module: 10,
              opcode: 11,
              argc: 4,
              overload: 1,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 11 } } },
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 10 } } },
                { kind: "expression", value: { kind: "int", value: 1 } },
                { kind: "expression", value: { kind: "int", value: 2 } },
              ],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.integerMemory["0:1"]).toBe(3);
    expect(runtime.state.integerMemory["0:2"]).toBe(0);
    expect(runtime.state.stringMemory["18:11"]).toBe("IR");
  });

  it("unwinds multi-level cross-scene scenario call stack (0:1:12 and 0:1:10)", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "scene_a",
      scenes: {
        scene_a: {
          id: "scene_a",
          instructions: [
            { op: "text", text: "In scene A" },
            // Gosub scene_b (opcode 12)
            {
              op: "command",
              offset: 10,
              moduleType: 0,
              module: 1,
              opcode: 12,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "int", value: 2 } }],
            },
            { op: "text", text: "Back in scene A" },
            { op: "end" },
          ],
        },
        seen0002: {
          id: "seen0002",
          instructions: [
            { op: "text", text: "In scene B" },
            // Return to caller (opcode 10)
            {
              op: "command",
              offset: 10,
              moduleType: 0,
              module: 1,
              opcode: 10,
              argc: 0,
              overload: 0,
              args: [],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("In scene A");
    await runtime.advance();
    expect(runtime.state.sceneId).toBe("seen0002");
    expect(runtime.state.backlog.at(-1)?.text).toBe("In scene B");
    await runtime.advance();
    expect(runtime.state.sceneId).toBe("scene_a");
    expect(runtime.state.backlog.at(-1)?.text).toBe("Back in scene A");
  });

  it("handles transition timer loops (module 1:4:620/630) and advances to dialogue in caller scene", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "prologue",
      scenes: {
        prologue: {
          id: "prologue",
          instructions: [
            // Call transition animation subroutine scene 8993
            {
              op: "command",
              offset: 0,
              moduleType: 0,
              module: 1,
              opcode: 12,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "int", value: 8993 } }],
            },
            // Dialogue in prologue
            {
              op: "command",
              offset: 10,
              moduleType: 1,
              module: 10,
              opcode: 0,
              argc: 2,
              overload: 0,
              args: [
                { kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1900 } } },
                { kind: "string", value: "I was gliding through the wind..." },
              ],
            },
            {
              op: "command",
              offset: 20,
              moduleType: 1,
              module: 10,
              opcode: 100,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1901 } } }],
            },
            {
              op: "command",
              offset: 30,
              moduleType: 0,
              module: 3,
              opcode: 17,
              argc: 0,
              overload: 0,
              args: [],
            },
            { op: "end" },
          ],
        },
        seen8993: {
          id: "seen8993",
          instructions: [
            // Start transition (1:4:620)
            {
              op: "command",
              offset: 0,
              moduleType: 1,
              module: 4,
              opcode: 620,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "int", value: 1000 } }],
            },
            // Query timer (1:4:630) -> returns $store == 0
            {
              op: "command",
              offset: 10,
              moduleType: 1,
              module: 4,
              opcode: 630,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "memory", bank: 2, index: { kind: "int", value: 1 } } }],
            },
            // assign memory[2:0] = $store
            {
              op: "assign",
              offset: 20,
              expression: {
                kind: "binary",
                op: 30,
                left: { kind: "memory", bank: 2, index: { kind: "int", value: 0 } },
                right: { kind: "store" },
              },
            },
            // Branch if memory[2:0] != 0 goto loop (target 1)
            {
              op: "branch",
              offset: 30,
              moduleType: 0,
              module: 1,
              opcode: 2,
              argc: 0,
              overload: 0,
              kind: "gotoUnless",
              expression: {
                kind: "binary",
                op: 40,
                left: { kind: "memory", bank: 2, index: { kind: "int", value: 0 } },
                right: { kind: "int", value: 0 },
              },
              targets: [5],
            },
            // Return to caller (0:1:10)
            {
              op: "command",
              offset: 40,
              moduleType: 0,
              module: 1,
              opcode: 10,
              argc: 0,
              overload: 0,
              args: [],
            },
            // Loop back target
            {
              op: "branch",
              offset: 50,
              moduleType: 0,
              module: 1,
              opcode: 0,
              argc: 0,
              overload: 0,
              kind: "goto",
              targets: [1],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.sceneId).toBe("prologue");
    expect(runtime.state.backlog.at(-1)?.text).toBe("I was gliding through the wind...");
  });

  it("handles BGM timestamp queries (1:4:114) and advances through OP movie scene (seen8005)", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "scene_with_op",
      scenes: {
        scene_with_op: {
          id: "scene_with_op",
          instructions: [
            { op: "text", text: "Leaving this wingless flesh on the ground..." },
            // Gosub OP movie scene 8005 (opcode 12)
            {
              op: "command",
              offset: 10,
              moduleType: 0,
              module: 1,
              opcode: 12,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "int", value: 8005 } }],
            },
            { op: "text", text: "I'm hungry." },
            { op: "end" },
          ],
        },
        seen8005: {
          id: "seen8005",
          instructions: [
            // Query BGM position (1:4:114)
            {
              op: "command",
              offset: 0,
              moduleType: 1,
              module: 4,
              opcode: 114,
              argc: 1,
              overload: 0,
              args: [{ kind: "expression", value: { kind: "int", value: 0 } }],
            },
            // assign mem[0:100] = $store
            {
              op: "assign",
              offset: 10,
              expression: {
                kind: "binary",
                op: 30,
                left: { kind: "memory", bank: 0, index: { kind: "int", value: 100 } },
                right: { kind: "store" },
              },
            },
            // gotoUnless (47950 <= mem[0:100]) -> target 4 (loop back)
            {
              op: "branch",
              offset: 20,
              moduleType: 0,
              module: 1,
              opcode: 2,
              argc: 0,
              overload: 0,
              kind: "gotoUnless",
              expression: {
                kind: "binary",
                op: 42,
                left: { kind: "int", value: 47950 },
                right: { kind: "memory", bank: 0, index: { kind: "int", value: 100 } },
              },
              targets: [4],
            },
            // Return to caller (opcode 13)
            {
              op: "command",
              offset: 30,
              moduleType: 0,
              module: 1,
              opcode: 13,
              argc: 0,
              overload: 0,
              args: [],
            },
            // Loop back (instruction 4)
            {
              op: "branch",
              offset: 40,
              moduleType: 0,
              module: 1,
              opcode: 0,
              argc: 0,
              overload: 0,
              kind: "goto",
              targets: [0],
            },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("Leaving this wingless flesh on the ground...");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.sceneId).toBe("scene_with_op");
    expect(runtime.state.backlog.at(-1)?.text).toBe("I'm hungry.");
  });
});

let cachedRealManifest: GameManifest | undefined = undefined;
function loadRealManifest(): GameManifest | undefined {
  if (cachedRealManifest) return cachedRealManifest;
  const manifestPath = "./.air-web-assets/manifest.json";
  const fs = require("fs");
  if (!fs.existsSync(manifestPath)) return undefined;
  cachedRealManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as GameManifest;
  return cachedRealManifest;
}

describe.skipIf(!require("node:fs").existsSync("./.air-web-assets/manifest.json"))("Real Game Manifest Integration", () => {
  it("plays through Prologue (seen0170), OP sequence (seen8005), and enters town arrival in real game data", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const diagnostics: string[] = [];
    const runtime = new AirRuntimeImpl(manifest);
    runtime.onEvent((event) => {
      if (event.type === "diagnostic") {
        diagnostics.push(`[${event.diagnostic.sceneId}:${event.diagnostic.instructionPointer}] ${event.diagnostic.message}`);
      }
    });

    runtime.startNewGame();
    runtime.setMode("skip");

    // In skip mode, advance processes through prologue and scene 8005 into seen0180
    await runtime.advance();

    expect(diagnostics.filter((d) => d.includes("guard"))).toEqual([]);
    const allBacklog = runtime.state.backlog.map((e) => e.text);
    expect(allBacklog.some((t) => t.includes("gliding"))).toBe(true);
    expect(allBacklog.some((t) => t.includes("wingless"))).toBe(true);
    expect(allBacklog.some((t) => t.includes("hungry") || t.includes("road"))).toBe(true);
    expect(runtime.state.sceneId).toBe("seen0180");
  }, 30000);

  it("traverses choices in scene 0180 (July 18) without any crashes or guard timeouts in real game data", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const diagnostics: string[] = [];
    const runtime = new AirRuntimeImpl(manifest);
    runtime.onEvent((event) => {
      if (event.type === "diagnostic") {
        diagnostics.push(`[${event.diagnostic.sceneId}:${event.diagnostic.instructionPointer}] ${event.diagnostic.message}`);
      }
    });

    runtime.load({
      sceneId: "seen0180",
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
      storeRegister: 0,
    });

    runtime.setMode("skip");
    let choiceCount = 0;

    for (let i = 0; i < 2; i++) {
      await runtime.advance();
      if (runtime.state.waiting === "choice") {
        choiceCount++;
        await runtime.choose(0);
      }
      if (runtime.state.waiting === "end") break;
    }

    expect(diagnostics.filter((d) => d.includes("guard"))).toEqual([]);
    expect(choiceCount).toBeGreaterThan(0);
  }, 30000);

  it("plays through Summer Arc (seen0700 / Ryuuya) with zero crashes or guard errors", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const diagnostics: string[] = [];
    const runtime = new AirRuntimeImpl(manifest);
    runtime.onEvent((event) => {
      if (event.type === "diagnostic") {
        diagnostics.push(`[${event.diagnostic.sceneId}:${event.diagnostic.instructionPointer}] ${event.diagnostic.message}`);
      }
    });

    runtime.load({
      sceneId: "seen0700",
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
      storeRegister: 0,
    });

    runtime.setMode("normal");
    await runtime.advance();

    expect(diagnostics.filter((d) => d.includes("guard"))).toEqual([]);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.length).toBeGreaterThan(0);
    expect(runtime.state.backlog.at(-1)?.text).toContain("Something was falling");
  }, 10000);

  it("plays through AIR Arc (seen0400 / Sora) with zero crashes or guard errors", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const diagnostics: string[] = [];
    const runtime = new AirRuntimeImpl(manifest);
    runtime.onEvent((event) => {
      if (event.type === "diagnostic") {
        diagnostics.push(`[${event.diagnostic.sceneId}:${event.diagnostic.instructionPointer}] ${event.diagnostic.message}`);
      }
    });

    runtime.load({
      sceneId: "seen0400",
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
      storeRegister: 0,
    });

    runtime.setMode("normal");
    while (runtime.state.waiting !== "text" && runtime.state.instructionPointer < 100) {
      await runtime.advance();
    }

    expect(diagnostics.filter((d) => d.includes("guard"))).toEqual([]);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.length).toBeGreaterThan(0);
  }, 10000);

  it("loads isolated choice strings without concatenation in real seen0231", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const runtime = new AirRuntimeImpl(manifest);
    // Jump just before the puppet choice at instruction 120 in seen0231
    runtime.load({
      sceneId: "seen0231",
      instructionPointer: 120,
      waiting: undefined,
      layers: [],
      textBuffer: "",
      backlog: [],
      audio: { effects: [], musicPositionMs: 0 },
      flags: {},
      variables: {},
      integerMemory: {},
      stringMemory: {
        "18:1903": "I want a ramen set",
        "18:1904": "Find me another T-shirt",
        "18:1905": "Take on the dare with the stegosaurus T-shirt",
        "18:1906": "Nope, not cute",
      },
      callStack: [],
      selectionHistory: [],
      viewedAssets: [],
      graphicsBuffers: {},
      storeRegister: 0,
    });

    runtime.setMode("normal");
    // Advance to trigger the choice
    while (runtime.state.waiting !== "choice" && runtime.state.instructionPointer < 145) {
      await runtime.advance();
    }

    expect(runtime.state.waiting).toBe("choice");
    const options = runtime.state.pendingChoice?.options ?? [];
    expect(options.length).toBe(3);
    // Confirm each option is clean and isolated
    expect(options[0]).toContain("solar-powered");
    expect(options[0]).not.toContain("ramen");
    expect(options[1]).toContain("creature from outer space");
    expect(options[1]).not.toContain("stegosaurus");
    expect(options[2]).toContain("tea");
    expect(options[2]).not.toContain("cute");
  });

  it("positions multi-character sprites with horizontal offsets instead of stacking at center in seen0317", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const runtime = new AirRuntimeImpl(manifest);
    runtime.load({
      sceneId: "seen0317",
      instructionPointer: 3915,
      waiting: undefined,
      layers: [{ asset: "image:G00_BG018N.g00", x: 0, y: 0, alpha: 1 }],
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
      storeRegister: 0,
    });

    runtime.setMode("normal");
    while (runtime.state.instructionPointer < 3925 && runtime.state.waiting !== "text") {
      await runtime.advance();
    }

    const activeLayers = runtime.state.layers.filter((l) => Boolean(l.asset));
    expect(activeLayers.length).toBeGreaterThanOrEqual(2);
    // The two character sprites should NOT have identical x positions
    const charLayers = activeLayers.filter((l) => l.asset && !l.asset.includes("BG"));
    if (charLayers.length >= 2) {
      expect(charLayers[0].x).not.toEqual(charLayers[1].x);
    }
  });

  it("emits ended event and sets state.waiting to 'end' on route completion in seen0311", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;

    const events: string[] = [];
    const runtime = new AirRuntimeImpl(manifest);
    runtime.onEvent((event) => events.push(event.type));

    runtime.load({
      sceneId: "seen0311",
      instructionPointer: 2925,
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
      storeRegister: 0,
    });

    runtime.setMode("normal");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("end");
    expect(events).toContain("ended");
  });
});
