import { describe, expect, it } from "vitest";
import { AirRuntimeImpl } from "./airRuntime";
import { demoManifest } from "./demoManifest";
import type { DataValue, GameManifest } from "../types";

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
                { kind: "string", value: "Test line one." },
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
    expect(runtime.state.backlog.at(-1)?.text).toBe("Test line one.");
  });

  it("handles BGM timestamp queries (1:4:114) and advances through OP movie scene (seen8005)", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "scene_with_op",
      scenes: {
        scene_with_op: {
          id: "scene_with_op",
          instructions: [
            { op: "text", text: "Synthetic prologue line." },
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
    expect(runtime.state.backlog.at(-1)?.text).toBe("Synthetic prologue line.");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.sceneId).toBe("scene_with_op");
    expect(runtime.state.backlog.at(-1)?.text).toBe("I'm hungry.");
  });
});

/**
 * AIR's `1:40:100` composite call is `(backdrop, slot, sp(name, slot), ...)`.
 * The backdrop argument is usually the string memory `$12[1000]`, which scenes
 * rewrite immediately before the call (e.g. seen0180:524 sets "BG001" and
 * seen0180:554 then draws `($12[1000], 48)`). Reading only literal arguments
 * leaves the previous backdrop on screen, so these tests pin the memory case.
 */
describe("GrpOpen display commands", () => {
  const assets = {
    "image:BG_ONE": { id: "image:BG_ONE", kind: "image" as const, url: "/bg1.png" },
    "image:BG_TWO": { id: "image:BG_TWO", kind: "image" as const, url: "/bg2.png" },
    "image:CG_Z": { id: "image:CG_Z", kind: "image" as const, url: "/cg.png" },
  };
  const aliases = { BG_ONE: "image:BG_ONE", BG_TWO: "image:BG_TWO", CG_Z: "image:CG_Z" };
  const memory = (index: number) => ({ kind: "memory" as const, bank: 0x12, index: { kind: "int" as const, value: index } });
  /** `1:40:100 ($12[1000], slot, sp(...))` — the standard stage call. */
  const stage = (extra: DataValue[]) => ({
    op: "command" as const, offset: 0, moduleType: 1, module: 40, opcode: 100, argc: 1 + extra.length, overload: 1,
    args: [{ kind: "expression" as const, value: memory(1000) }, ...extra] as DataValue[],
  });
  const number = (value: number): DataValue => ({ kind: "expression", value: { kind: "int", value } });
  const sprite = (name: string, slot: number): DataValue => ({
    kind: "special", tag: 2,
    values: [{ kind: "string", value: name }, number(slot)],
  });
  const writeString = (index: number, value: string) => ({
    op: "command" as const, offset: 0, moduleType: 1, module: 10, opcode: 0, argc: 2, overload: 0,
    args: [
      { kind: "expression" as const, value: memory(index) },
      { kind: "string" as const, value },
    ] as DataValue[],
  });

  const build = (instructions: GameManifest["scenes"][string]["instructions"]): GameManifest => ({
    ...demoManifest, startScene: "s", assets, assetAliases: aliases,
    scenes: { s: { id: "s", instructions: [...instructions, { op: "end" }] } },
  });

  it("reads the backdrop from string memory and places the sprite over it", async () => {
    const runtime = new AirRuntimeImpl(build([
      writeString(1000, "BG_ONE"),
      stage([number(48), sprite("CG_Z", 61)]),
      { op: "text", text: "cg over bg" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    const layers = runtime.state.layers.filter((layer) => layer.asset);
    expect(layers.map((layer) => layer.asset)).toEqual(["image:BG_ONE", "image:CG_Z"]);
    expect(layers[1].x).toBe(0);
  });

  it("replaces the backdrop when a scene changes $12[1000] before drawing alone", async () => {
    const runtime = new AirRuntimeImpl(build([
      writeString(1000, "BG_ONE"),
      stage([number(0)]),
      { op: "text", text: "first" },
      writeString(1000, "BG_TWO"),
      stage([number(0)]),
      { op: "text", text: "second" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.layers[0].asset).toBe("image:BG_ONE");
    await runtime.advance();
    expect(runtime.state.layers[0].asset).toBe("image:BG_TWO");
  });

  it("uses the GAMEEXE.INI slot offsets for a two-character scene", async () => {
    const runtime = new AirRuntimeImpl(build([
      writeString(1000, "BG_ONE"),
      stage([number(60), sprite("CG_Z", 62), sprite("BG_TWO", 63)]),
      { op: "text", text: "two characters" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    const sprites = runtime.state.layers.filter((layer) => layer.asset).slice(1);
    expect(sprites.map((layer) => layer.x)).toEqual([-130, 130]);
  });

  it("replays a buffered background with 1:33:70 and 1:33:77", async () => {
    const runtime = new AirRuntimeImpl(build([
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 70, argc: 2, overload: 0,
        args: [{ kind: "string", value: "BG_ONE" }, { kind: "expression", value: { kind: "int", value: 2 } }] },
      { op: "text", text: "buffered" },
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 77, argc: 1, overload: 0,
        args: [{ kind: "expression", value: { kind: "int", value: 2 } }] },
      { op: "text", text: "replayed" },
    ]));
    runtime.startNewGame();
    // Buffering a layer is not itself a draw; the replay is.
    await runtime.advance();
    expect(runtime.state.layers.find((layer) => layer.asset)).toBeUndefined();
    await runtime.advance();
    expect(runtime.state.layers[0].asset).toBe("image:BG_ONE");
  });

  it("opens a buffered CG without clearing the backdrop", async () => {
    const runtime = new AirRuntimeImpl(build([
      writeString(1000, "BG_ONE"),
      stage([number(0)]),
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 70, argc: 2, overload: 0,
        args: [{ kind: "string", value: "CG_Z" }, { kind: "expression", value: { kind: "int", value: 61 } }] },
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 77, argc: 1, overload: 0,
        args: [{ kind: "expression", value: { kind: "int", value: 61 } }] },
      { op: "text", text: "cg" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    const layers = runtime.state.layers.filter((layer) => layer.asset);
    expect(layers.map((layer) => layer.asset)).toEqual(["image:BG_ONE", "image:CG_Z"]);
  });

  it("draws a background immediately with 1:33:73 and replaces it on the next call", async () => {
    // 809 story call sites use this direct load-and-open form, e.g. seen0163:40.
    const runtime = new AirRuntimeImpl(build([
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 73, argc: 2, overload: 0,
        args: [{ kind: "string", value: "BG_ONE" }, { kind: "expression", value: { kind: "int", value: 0 } }] },
      { op: "text", text: "immediate" },
      { op: "command", offset: 0, moduleType: 1, module: 33, opcode: 73, argc: 2, overload: 0,
        args: [{ kind: "string", value: "BG_TWO" }, { kind: "expression", value: { kind: "int", value: 0 } }] },
      { op: "text", text: "replaced" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.layers[0].asset).toBe("image:BG_ONE");
    await runtime.advance();
    expect(runtime.state.layers[0].asset).toBe("image:BG_TWO");
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
    // Skip mode must have emitted real dialogue from both the prologue and the
    // OP scene, then reached the next story scene. Assert structure only.
    expect(allBacklog.length).toBeGreaterThan(2);
    expect(allBacklog.every((t) => typeof t === "string")).toBe(true);
    expect(allBacklog.some((t) => t.trim().length > 10)).toBe(true);
    expect(new Set(allBacklog).size).toBeGreaterThan(1);
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
      objects: {},
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
      objects: {},
      storeRegister: 0,
    });

    runtime.setMode("normal");
    await runtime.advance();

    expect(diagnostics.filter((d) => d.includes("guard"))).toEqual([]);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog.length).toBeGreaterThan(0);
    // Assert structure, not story text: expectations must not carry dialogue.
    expect(runtime.state.backlog.at(-1)?.text.trim().length).toBeGreaterThan(0);
    expect(runtime.state.backlog.at(-1)?.sceneId).toBe("seen0700");
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
      objects: {},
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
        "18:1903": "JUNK-MARKER-1903",
        "18:1904": "JUNK-MARKER-1904",
        "18:1905": "JUNK-MARKER-1905",
        "18:1906": "JUNK-MARKER-1906",
      },
      callStack: [],
      selectionHistory: [],
      viewedAssets: [],
      graphicsBuffers: {},
      objects: {},
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
    // Each option must be a clean, isolated string: the scene loads its own
    // text from the script, and none of the seeded memory strings may leak in
    // or get concatenated with another option.
    for (const option of options) {
      expect(typeof option).toBe("string");
      expect(option.trim().length).toBeGreaterThan(0);
      expect(option).not.toContain("JUNK-MARKER");
    }
    expect(new Set(options).size).toBe(options.length);
    for (const a of options) {
      for (const b of options) {
        if (a !== b) expect(a).not.toContain(b);
      }
    }
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
      objects: {},
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
      objects: {},
      storeRegister: 0,
    });

    runtime.setMode("normal");
    await runtime.advance();
    expect(runtime.state.waiting).toBe("end");
    expect(events).toContain("ended");
  });

  /**
   * `1:10:17 ($5[n], $18[m], width)` formats an integer into string memory.
   * The source is argument 0 and the destination argument 1; reading them the
   * other way left every date plaque ($18[0]) empty and produced plate names
   * like "SDT07" instead of the real "SDT0716".
   */
  it("formats an integer into string memory with the source first and zero padding", async () => {
    const mem = (bank: number, index: number): DataValue => ({
      kind: "expression",
      value: { kind: "memory", bank, index: { kind: "int", value: index } },
    });
    const int = (value: number): DataValue => ({
      kind: "expression",
      value: { kind: "int", value },
    });
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "format",
      scenes: {
        format: {
          id: "format",
          instructions: [
            // $5[3] holds the day, formatted into $18[0] as two digits.
            { op: "command", offset: 0, moduleType: 1, module: 10, opcode: 0, argc: 1, overload: 0, args: [int(7)] },
            {
              op: "command", offset: 10, moduleType: 1, module: 10, opcode: 17, argc: 3, overload: 0,
              args: [mem(5, 3), mem(18, 0), int(2)],
            },
            { op: "text", text: "done" },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.load({
      sceneId: "format", instructionPointer: 0, waiting: undefined, layers: [], textBuffer: "", backlog: [],
      audio: { effects: [], musicPositionMs: 0 }, flags: {}, variables: {},
      integerMemory: { "5:3": 16 }, stringMemory: {}, callStack: [], selectionHistory: [],
      viewedAssets: [], graphicsBuffers: {}, objects: {}, storeRegister: 0,
    });
    await runtime.advance();
    expect(runtime.state.stringMemory["18:0"]).toBe("16");
    // The destination must not be written with the day under its own key.
    expect(runtime.state.stringMemory["5:3"]).toBeUndefined();
  });

  /**
   * A voice selected by `1:23:x` belongs to the next line only. The script has
   * no "clear voice" call, so keeping it in `audio.voice` attached a stale clip
   * to narration for the rest of the scene.
   */
  it("attaches a queued voice to exactly one line", async () => {
    const manifest: GameManifest = {
      ...demoManifest,
      startScene: "voiced",
      assets: {
        "voice:Z000000001": { id: "voice:Z000000001", kind: "voice", url: "/voices/a.ogg" },
      },
      assetAliases: { Z000000001: "voice:Z000000001" },
      scenes: {
        voiced: {
          id: "voiced",
          instructions: [
            { op: "command", offset: 0, moduleType: 1, module: 23, opcode: 0, argc: 1, overload: 0, args: [{ kind: "expression", value: { kind: "int", value: 1 } }] },
            { op: "text", text: "first" },
            { op: "text", text: "second" },
            { op: "end" },
          ],
        },
      },
    };
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("first");
    expect(runtime.state.backlog.at(-1)?.voice).toBe("voice:Z000000001");
    await runtime.advance();
    expect(runtime.state.backlog.at(-1)?.text).toBe("second");
    expect(runtime.state.backlog.at(-1)?.voice).toBeUndefined();
    expect(runtime.state.audio.voice).toBeUndefined();
  });

  /**
   * Real-data guard for the voice ordering. Each script block appends the
   * PREVIOUS line, writes the current one and then flushes, so a `1:23:x` in a
   * block names the line that the NEXT flush emits. Getting this off by one
   * attaches a clip to the wrong line — measurable as voiced lines that have no
   * speaker, because narration would inherit a character's clip.
   *
   * A regression here would not fail any unit test and would not surface in the
   * browser harnesses, so it is asserted against the real dataset.
   */
  it("attributes real voice clips to spoken lines, not narration", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;
    const runtime = new AirRuntimeImpl(manifest);
    runtime.load({
      sceneId: "seen0180", instructionPointer: 0, waiting: undefined, layers: [], textBuffer: "", backlog: [],
      audio: { effects: [], musicPositionMs: 0 }, flags: {}, variables: {}, integerMemory: {}, stringMemory: {},
      callStack: [], selectionHistory: [], viewedAssets: [], graphicsBuffers: {}, objects: {}, storeRegister: 0,
    });
    for (let step = 0; step < 400; step += 1) {
      await runtime.advance();
      if (runtime.state.pendingChoice) await runtime.choose(0);
      if (runtime.state.waiting === "end") break;
    }
    const voiced = runtime.state.backlog.filter((entry) => entry.voice);
    expect(voiced.length).toBeGreaterThan(20);
    const withSpeaker = voiced.filter((entry) => entry.speaker).length;
    // Before the ordering fix this sat near 62%; correct attribution is ~100%
    // for a scene whose voiced lines all belong to named characters.
    expect(withSpeaker / voiced.length).toBeGreaterThan(0.9);
    // And a clip must not be repeated across consecutive lines.
    const ids = voiced.map((entry) => entry.voice);
    const repeats = ids.filter((id, index) => index > 0 && id === ids[index - 1]).length;
    expect(repeats).toBe(0);
  }, 30000);

  /**
   * `1:4:3501` returns the result of the preceding `1:4:3502` text-width query.
   * `seen0440:1599-1602` pads a dialogue buffer by appending it to itself and
   * doubling `$store` until it passes 512. With `3501` unimplemented, `$store`
   * stayed 0, `0 * 2 === 0` never satisfied the exit, and the buffer doubled
   * without bound until V8 threw `RangeError: Invalid string length` — a hard
   * crash that no assertion in the suite caught.
   */
  it("terminates the dialogue padding loop instead of growing a string without bound", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;
    const runtime = new AirRuntimeImpl(manifest);
    runtime.load({
      sceneId: "seen0440", instructionPointer: 1598, waiting: undefined, layers: [], textBuffer: "", backlog: [],
      audio: { effects: [], musicPositionMs: 0 }, flags: {}, variables: {}, integerMemory: {}, stringMemory: {},
      callStack: [], selectionHistory: [], viewedAssets: [], graphicsBuffers: {}, objects: {}, storeRegister: 0,
    });
    // One advance runs the whole loop: seed `$store`, pad, and exit at 512.
    await runtime.advance();
    const buffer = runtime.state.stringMemory["18:1900"] ?? "";
    expect(buffer.length).toBe(512);
    expect(runtime.state.storeRegister).toBe(512);
    // And it must not have run away into the defensive cap.
    expect(buffer.length).toBeLessThan(1 << 20);
  }, 30000);
});

/**
 * RealLive's object table. These pin the semantics of every object opcode the
 * port honours, because a silent misread (an argument off by one, or treating
 * `1:60:1` as "create, hidden") leaves the date badge blank without failing
 * anything else.
 */
describe("object opcodes", () => {
  const num = (value: number): DataValue => ({ kind: "expression", value: { kind: "int", value } });
  const str = (value: string): DataValue => ({ kind: "string", value });
  const command = (module: number, opcode: number, args: DataValue[], overload = 0): GameManifest["scenes"][string]["instructions"][number] => ({
    op: "command", offset: 0, moduleType: 1, module, opcode, argc: args.length, overload, args,
  });
  const assets = {
    "image:G00_SDT0717.g00": { id: "image:G00_SDT0717.g00", kind: "image" as const, url: "/images/G00__SDT0717.png", width: 150, height: 154 },
    "image:G00_S_TT_BG10.g00": { id: "image:G00_S_TT_BG10.g00", kind: "image" as const, url: "/images/G00__S_TT_BG10.png", width: 640, height: 480 },
    "image:G00_S_TT_BTN00.g00": { id: "image:G00_S_TT_BTN00.g00", kind: "image" as const, url: "/images/G00__S_TT_BTN00.png", width: 200, height: 84 },
  };
  const aliases = { SDT0717: "image:G00_SDT0717.g00", S_TT_BG10: "image:G00_S_TT_BG10.g00", S_TT_BTN00: "image:G00_S_TT_BTN00.g00" };
  const build = (instructions: GameManifest["scenes"][string]["instructions"]): GameManifest => ({
    ...demoManifest, startScene: "s", assets, assetAliases: aliases,
    scenes: { s: { id: "s", instructions: [...instructions, { op: "end" }] } },
  });

  it("assigns a graphic, position and visibility to the date plate", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(62, 10, [num(83)]),
      command(60, 1, [num(83)]),
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      command(82, 1000, [num(83), num(16), num(16)]),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    const plate = runtime.state.objects["83"];
    expect(plate.asset).toBe("image:G00_SDT0717.g00");
    expect(plate.x).toBe(16);
    expect(plate.y).toBe(16);
    expect(plate.visible).toBe(true);
    expect(plate.alpha).toBe(1);
    // No rectangle was set, so the canvas uses the PNG's natural size.
    expect(plate.width).toBeUndefined();
  });

  it("opens the object on 1:60:1 rather than treating it as create-hidden", async () => {
    // Slot 83 is never given a `1:81:1004`/`1:82:1004`; `1:60:1` is the only
    // visibility source in all 76 scenes that draw the plate.
    const runtime = new AirRuntimeImpl(build([
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      command(82, 1000, [num(83), num(16), num(16)]),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["83"].visible).toBe(false);
    expect(runtime.state.objects["83"].x).toBe(16);
  });

  it("drops the object table when the scene changes, so a date-off scene shows no date", async () => {
    // Object 83 is never destroyed by the script (zero `1:60:2(83)` and zero
    // `1:81:1004/1:82:1004(83)` calls exist), and dated scenes gate the plate
    // behind `$5[2]`. Without a scene-boundary reset the previous scene's plate
    // leaks through: the Sora ending used to display a July plate for 93 lines.
    const twoScenes: GameManifest = {
      ...demoManifest,
      startScene: "dated",
      assets: {
        "image:G00_SDT0717.g00": { id: "image:G00_SDT0717.g00", kind: "image", url: "/images/G00__SDT0717.png" },
      },
      assetAliases: { SDT0717: "image:G00_SDT0717.g00" },
      scenes: {
        dated: {
          id: "dated",
          instructions: [
            command(60, 1, [num(83)]),
            command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
            command(82, 1000, [num(83), num(16), num(16)]),
            { op: "text", text: "dated line" },
            { op: "scene", sceneId: "undated" },
          ],
        },
        undated: {
          id: "undated",
          instructions: [{ op: "text", text: "no date here" }, { op: "end" }],
        },
      },
    };
    const runtime = new AirRuntimeImpl(twoScenes);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["83"]?.asset).toBe("image:G00_SDT0717.g00");
    await runtime.advance();
    // Scene changed: the table is empty, so nothing stale is drawn.
    expect(runtime.state.sceneId).toBe("undated");
    expect(runtime.state.objects["83"]).toBeUndefined();
    expect(Object.keys(runtime.state.objects)).toEqual([]);
  });

  it("moves the plate to 16,66 when the message window is at the bottom", async () => {
    // Every dated scene re-issues the position before each line, choosing
    // y=16 for a top window and y=66 for a bottom one.
    const runtime = new AirRuntimeImpl(build([
      command(60, 1, [num(83)]),
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      command(82, 1000, [num(83), num(16), num(16)]),
      { op: "text", text: "top" },
      command(82, 1000, [num(83), num(16), num(66)]),
      { op: "text", text: "bottom" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["83"].y).toBe(16);
    await runtime.advance();
    expect(runtime.state.objects["83"].y).toBe(66);
  });

  it("accepts both arities of 1:72:1000, with mode only on the 3-arg form", async () => {
    const runtime = new AirRuntimeImpl(build([
      // Title background: `(10, "S_TT_BG10")` — no mode argument.
      command(72, 1000, [num(10), str("S_TT_BG10")], 0),
      // Menu button: `(20, "S_TT_BTN00")`.
      command(72, 1000, [num(20), str("S_TT_BTN00")], 0),
      // Date plate: `(83, "SDT0717", 1)` — the trailing 1 is the draw mode.
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["10"].asset).toBe("image:G00_S_TT_BG10.g00");
    expect(runtime.state.objects["20"].asset).toBe("image:G00_S_TT_BTN00.g00");
    expect(runtime.state.objects["83"].asset).toBe("image:G00_SDT0717.g00");
    // Mode is a draw mode, not geometry: the 3-arg form must not consume it.
    expect(runtime.state.objects["83"].x).toBe(0);
  });

  it("records the message-window bar rectangles from 1:72:1101", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(72, 1101, [num(81), num(0), num(0), num(640), num(50), num(1)], 2),
      command(72, 1101, [num(82), num(0), num(430), num(640), num(50), num(1)], 2),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["81"]).toMatchObject({ x: 0, y: 0, width: 640, height: 50 });
    expect(runtime.state.objects["82"]).toMatchObject({ x: 0, y: 430, width: 640, height: 50 });
  });

  it("applies 1:82:1016 colour and 0-255 alpha", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(72, 1101, [num(81), num(0), num(0), num(640), num(50), num(1)], 2),
      command(82, 1016, [num(81), num(0), num(0), num(0), num(255)]),
      command(60, 1, [num(81)]),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["81"].fill).toEqual({ r: 0, g: 0, b: 0 });
    expect(runtime.state.objects["81"].alpha).toBe(1);
    expect(runtime.state.objects["81"].visible).toBe(true);
    // The DOM window owns the text; 1:81:1003 is only recorded for saves.
    expect(runtime.state.objects["81"].text).toBeUndefined();
  });

  it("toggles visibility through 1:81:1004 / 1:82:1004", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(60, 1, [num(20)]),
      command(81, 1004, [num(20), num(0)]),
      { op: "text", text: "hidden" },
      command(82, 1004, [num(20), num(1)]),
      { op: "text", text: "shown" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["20"].visible).toBe(false);
    await runtime.advance();
    expect(runtime.state.objects["20"].visible).toBe(true);
  });

  it("records 1:81:1034 rectangles and 1:81:1003 text without drawing them", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(81, 1000, [num(1), num(240), num(170)]),
      command(81, 1034, [num(1), num(240), num(170), num(160), num(120)]),
      command(81, 1003, [num(1), str("AIR")]),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["1"]).toMatchObject({ x: 240, y: 170, width: 160, height: 120, text: "AIR" });
  });

  it("resets the table on 1:60:111 and drops a slot on 1:60:2", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(60, 1, [num(83)]),
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      command(60, 2, [num(83)]),
      command(60, 1, [num(0)]),
      { op: "text", text: "after delete" },
      command(60, 111, []),
      { op: "text", text: "after clear" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.objects["83"]).toBeUndefined();
    expect(runtime.state.objects["0"]).toBeDefined();
    await runtime.advance();
    expect(runtime.state.objects).toEqual({});
  });

  it("keeps the object table JSON-serialisable for saves", async () => {
    const runtime = new AirRuntimeImpl(build([
      command(60, 1, [num(83)]),
      command(72, 1000, [num(83), str("SDT0717"), num(1)], 1),
      command(82, 1000, [num(83), num(16), num(16)]),
      { op: "text", text: "line" },
    ]));
    runtime.startNewGame();
    await runtime.advance();
    const saved = runtime.save();
    const round = JSON.parse(JSON.stringify(saved)) as typeof saved;
    expect(round.objects["83"].asset).toBe("image:G00_SDT0717.g00");
    // Small: one slot with seven primitive fields.
    expect(JSON.stringify(saved.objects).length).toBeLessThan(400);
    const restored = new AirRuntimeImpl(build([{ op: "end" }]));
    restored.load(round);
    expect(restored.state.objects["83"]).toMatchObject({ asset: "image:G00_SDT0717.g00", x: 16, y: 16, visible: true });
  });
});

describe("date badge (real data)", () => {
  it("advancing into seen0170 leaves object 83 holding a resolvable plate at 16,16", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    // The scene opens its message window and draws its chrome (`1:30:0`,
    // `1:62:10(83)`, `1:60:1(83)`, `1:72:1000`, `1:82:1000`) after the opening
    // narration, and re-issues the plate before every later line. Advance until
    // it appears rather than assuming a fixed offset.
    let steps = 0;
    while (!runtime.state.objects["83"] && steps < 40) {
      await runtime.advance();
      steps += 1;
      if (runtime.state.pendingChoice) await runtime.choose(0);
    }
    expect(runtime.state.sceneId).toBe("seen0170");
    expect(runtime.state.waiting).toBe("text");
    const plate = runtime.state.objects["83"];
    expect(plate, "object 83 must exist once the date window is open").toBeDefined();
    expect(plate.visible).toBe(true);
    expect(plate.x).toBe(16);
    expect(plate.y).toBe(16);
    expect(plate.asset).toMatch(/^image:G00_SDT07\d\d\.g00$/);
    // The name must resolve through assetAliases, and the resolved asset must
    // be the 150x154 plate so the canvas draws it at its natural size.
    const name = /SDT(\d{4})/.exec(plate.asset!)?.[1];
    expect(manifest.assetAliases?.[`SDT${name}`]).toBe(plate.asset);
    expect(manifest.assets[plate.asset!]).toMatchObject({ kind: "image", width: 150, height: 154 });
    expect(plate.width).toBeUndefined();
    // 17 July is the prologue date, so the plate is the 17th day of July.
    expect(plate.asset).toBe("image:G00_SDT0717.g00");
  }, 30000);

  it("keeps the badge on screen across a real playthrough, at 16,16 or 16,66", async () => {
    const manifest = loadRealManifest();
    if (!manifest) return;
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    // The prologue sets `$5[2]` (the engine's date-window flag) to 1, which is
    // what every dated scene gates its plate setup on. Play normally and sample
    // the badge at every line once it first appears.
    const seen = new Map<string, { x: number; y: number; asset: string }>();
    let sampled = 0;
    for (let step = 0; step < 160 && runtime.state.waiting !== "end"; step += 1) {
      await runtime.advance();
      if (runtime.state.pendingChoice) await runtime.choose(0);
      const plate = runtime.state.objects["83"];
      if (!plate) continue;
      sampled += 1;
      const id = runtime.state.sceneId;
      expect(plate.visible, `${id} step ${step}`).toBe(true);
      expect(plate.asset && Boolean(manifest.assets[plate.asset]), `${id} plate asset`).toBe(true);
      expect(plate.x, `${id} x`).toBe(16);
      expect([16, 66], `${id} y`).toContain(plate.y);
      if (!seen.has(id)) seen.set(id, { x: plate.x, y: plate.y, asset: plate.asset! });
    }
    expect(sampled).toBeGreaterThan(10);
    expect(seen.size).toBeGreaterThan(0);
    for (const [sceneId, plate] of seen) {
      expect(plate.asset, sceneId).toMatch(/^image:G00_SDT0[78]\d\d\.g00$/);
    }
  }, 60000);

  it("hides the badge in scenes whose date-window flag is off", async () => {
    // seen0163 sets `$5[2] = 0` at instruction 6 and gates the plate setup on
    // it, so the Sora opening legitimately has no date. This is the engine's
    // own behaviour, not a port limitation, and the DOM caption must not
    // invent a date there either (`sceneTitle` is the fallback only).
    const manifest = loadRealManifest();
    if (!manifest) return;
    const runtime = new AirRuntimeImpl(manifest);
    runtime.load({
      sceneId: "seen0163", instructionPointer: 0, waiting: undefined, layers: [], textBuffer: "", backlog: [],
      audio: { effects: [], musicPositionMs: 0 }, flags: {}, variables: {}, integerMemory: {}, stringMemory: {},
      callStack: [], selectionHistory: [], viewedAssets: [], graphicsBuffers: {}, objects: {}, storeRegister: 0,
    });
    await runtime.advance();
    expect(runtime.state.integerMemory["5:2"]).toBe(0);
    expect(runtime.state.objects["83"]?.asset).toBeUndefined();
  }, 30000);

});
