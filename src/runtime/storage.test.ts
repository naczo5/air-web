import { describe, expect, it } from "vitest";
import { AirRuntimeImpl } from "./airRuntime";
import { demoManifest } from "./demoManifest";
import { defaultSettings, exportSave, importSave, loadSettings, saveSettings, type SaveSlot } from "./storage";

const validSave = (): SaveSlot => ({
  version: 1, slot: 1, title: "Save", timestamp: "2026-09-16T00:00:00.000Z",
  state: new AirRuntimeImpl(demoManifest).save(),
});

describe("save import validation", () => {
  it("round-trips runtime saves including choice checkpoints", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    await runtime.advance();
    await runtime.advance();
    await runtime.advance();
    const slot = { ...validSave(), state: runtime.save() };
    expect(importSave(exportSave(slot))).toEqual(slot);
  });

  it.each([null, [], {}, { version: 1, slot: 1, state: { sceneId: "demo", instructionPointer: 0 } }])("rejects incomplete or non-object imports: %j", (value) => {
    expect(() => importSave(JSON.stringify(value))).toThrow("Unsupported or invalid AIR save file");
  });

  it.each([
    { backlog: [null] }, { layers: {} }, { audio: null }, { audio: { effects: [3] } },
    { instructionPointer: -1 }, { pendingChoice: { options: null } },
    { waiting: "choice" }, { callStack: ["bad"] }, { integerMemory: { A: "bad" } },
    { selectionHistory: [{ sceneId: "demo" }] },
  ])("rejects malformed runtime state: %j", (change) => {
    const slot = validSave();
    expect(() => importSave(JSON.stringify({ ...slot, state: { ...slot.state, ...change } }))).toThrow("Unsupported or invalid AIR save file");
  });

  it.each([{ slot: 101 }, { slot: 0 }, { title: null }, { timestamp: "not a date" }, { thumbnail: {} }])("rejects invalid slot metadata: %j", (change) => {
    expect(() => importSave(JSON.stringify({ ...validSave(), ...change }))).toThrow("Unsupported or invalid AIR save file");
  });

  it("persists settings through IndexedDB", async () => {
    const settings = { ...defaultSettings, textSpeed: 79, displayMode: "pixel" as const, autoplay: true };
    await saveSettings(settings);
    expect(await loadSettings()).toEqual(settings);
    await saveSettings(defaultSettings);
  });
});
