import { describe, expect, it, vi } from "vitest";
import { AirRuntimeImpl } from "./airRuntime";
import type { GameManifest, RuntimeState } from "../types";

const textScene = (id: string, lines: string[]): GameManifest["scenes"][string] => ({
  id,
  instructions: lines.map((text) => ({ op: "text", text })),
});

const testManifest = (scenes: GameManifest["scenes"], startScene?: string): GameManifest => ({
  id: "air-se",
  title: "execution tests",
  logicalSize: { width: 640, height: 480 },
  generatedAt: "test",
  scenes,
  assets: {},
  flowchart: { nodes: [], edges: [] },
  ...(startScene ? { startScene } : {}),
});

const waitState = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  sceneId: "skip_scene",
  instructionPointer: 0,
  waiting: "text",
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
  ...overrides,
});

describe("runtime execution concurrency", () => {
  it("coalesces overlapping advances on a text pause into a single run", async () => {
    const manifest = testManifest({
      main: {
        id: "main",
        instructions: [
          ...[0, 1, 2].map((index) => ({ op: "text" as const, text: `Line ${index}` })),
          { op: "end" },
        ],
      },
    }, "main");
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    await runtime.advance();
    expect(runtime.state.waiting).toBe("text");

    // Several advance() calls race while the first run is still in flight.
    const [first] = await Promise.all([runtime.advance(), runtime.advance(), runtime.advance()]);
    // Only one extra line may be consumed by the coalesced run.
    expect(runtime.state.backlog.map((entry) => entry.text)).toEqual(["Line 0", "Line 1"]);
    expect(runtime.state.waiting).toBe("text");

    await first;
    expect(runtime.state.waiting).toBe("text");
  });

  it("stops an in-flight skip loop when load replaces the state", async () => {
    const manifest = testManifest({
      skip_scene: {
        id: "skip_scene",
        instructions: [
          ...Array.from({ length: 200 }, (_, index) => ({ op: "text" as const, text: `Skip line ${index}` })),
          { op: "end" },
        ],
      },
    }, "skip_scene");
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    runtime.setMode("skip");

    const skipRun = runtime.advance();
    // Load a fresh state while the skip loop is mid-await inside its skip delay.
    await vi.waitFor(() => expect(runtime.state.instructionPointer).toBeGreaterThan(1));
    runtime.load(waitState());
    await skipRun;

    expect(runtime.state.sceneId).toBe("skip_scene");
    expect(runtime.state.instructionPointer).toBe(0);
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.backlog).toHaveLength(0);
  });

  it("never lets a disposed loop run on the new runtime state", async () => {
    const manifest = testManifest({ main: textScene("main", ["Only line"]) }, "main");
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    const pending = runtime.advance();
    runtime.dispose();
    await pending;
    expect(runtime.state.backlog).toHaveLength(0);
    // Post-dispose API calls are inert.
    await runtime.advance();
    expect(runtime.state.backlog).toHaveLength(0);
  });

  it("drops a stale loop that resumes after startNewGame", async () => {
    const manifest = testManifest({
      main: {
        id: "main",
        instructions: [
          ...Array.from({ length: 120 }, (_, index) => ({ op: "text" as const, text: `Old line ${index}` })),
          { op: "end" },
        ],
      },
    }, "main");
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    const staleRun = runtime.advance();
    runtime.startNewGame();
    await staleRun;
    expect(runtime.state.backlog).toHaveLength(0);
    expect(runtime.state.sceneId).toBe("main");
    expect(runtime.state.instructionPointer).toBe(0);
  });

  it("stops on the current text when skip is cancelled during its delay", async () => {
    const manifest = testManifest({
      skip_scene: {
        id: "skip_scene",
        instructions: [
          ...Array.from({ length: 800 }, (_, index) => ({ op: "text" as const, text: `Fast line ${index}` })),
          { op: "end" },
        ],
      },
    }, "skip_scene");
    const runtime = new AirRuntimeImpl(manifest);
    runtime.startNewGame();
    runtime.setMode("skip");
    const skipRun = runtime.advance();
    await vi.waitFor(() => expect(runtime.state.instructionPointer).toBeGreaterThan(5));

    runtime.setMode("normal");
    const pausedAt = runtime.state.instructionPointer;
    expect(runtime.state.waiting).toBe("text");
    await skipRun;

    // The loop must stop at the text it was paused on, not keep skipping.
    expect(runtime.state.waiting).toBe("text");
    expect(runtime.state.instructionPointer).toBe(pausedAt);
  });

  it("treats emitted command text as read in skip-read mode regardless of the op", async () => {
    const manifest = testManifest({
      command_scene: {
        id: "command_scene",
        instructions: [
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
              { kind: "string", value: "Emitted command line" },
            ],
          },
          {
            op: "command",
            offset: 10,
            moduleType: 1,
            module: 10,
            opcode: 100,
            argc: 1,
            overload: 0,
            args: [{ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: 1901 } } }],
          },
          {
            op: "command",
            offset: 20,
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
    }, "command_scene");
    const readIds: string[] = [];
    const runtime = new AirRuntimeImpl(manifest, {
      readTextIds: ["command_scene:2"],
      onTextRead: (id) => readIds.push(id),
    });
    runtime.startNewGame();
    runtime.setMode("skip-read");
    await runtime.advance();

    // The pre-existing read set applies to the flush's text even though the
    // instruction is a command, and the line is not re-announced as new.
    expect(runtime.state.waiting).toBe("end");
    expect(runtime.state.backlog.map((entry) => entry.text)).toEqual(["Emitted command line"]);
    expect(readIds).toEqual([]);
  });

  it("reports invalid instruction pointers from load without throwing", async () => {
    const manifest = testManifest({ main: textScene("main", ["Line"]) }, "main");
    const runtime = new AirRuntimeImpl(manifest);
    const diagnostics: string[] = [];
    runtime.onEvent((event) => {
      if (event.type === "diagnostic") diagnostics.push(event.diagnostic.message);
    });
    runtime.load(waitState({ sceneId: "main", instructionPointer: 999, waiting: undefined }));
    await runtime.advance();
    expect(diagnostics.some((message) => message.includes("outside scene"))).toBe(true);
  });
});
