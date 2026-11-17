import { describe, expect, it } from "vitest";
import { AirRuntimeImpl } from "./airRuntime";
import { demoManifest } from "./demoManifest";
import { autoAdvanceDelayRange, defaultSettings, exportSave, hasAutosave, importSave, listSaveSlots, loadAutosave, loadQuickSlot, loadSettings, normalizeSettings, saveAutosave, saveQuickSlot, saveSettings, validateQuickSlot, windowOpacityRange, type SaveSlot, type UserSettings } from "./storage";

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

  it("accepts a real-size PNG thumbnail but rejects a remote URL", () => {
    // A 640x480 stage thumbnail is ~570 KB of base64 in practice.
    const inline = "data:image/png;base64," + "A".repeat(560_000);
    expect(importSave(JSON.stringify({ ...validSave(), thumbnail: inline })).thumbnail).toBe(inline);
    expect(() => importSave(JSON.stringify({ ...validSave(), thumbnail: "https://example.test/track.png" }))).toThrow();
    expect(() => importSave(JSON.stringify({ ...validSave(), thumbnail: "data:text/html;base64,AAAA" }))).toThrow();
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"])("rejects prototype keys as a scene id: %s", (sceneId) => {
    const slot = validSave();
    expect(() => importSave(JSON.stringify({ ...slot, state: { ...slot.state, sceneId } }))).toThrow("Unsupported or invalid AIR save file");
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

  it("round-trips the object table through a save slot", async () => {
    // The date badge lives in `state.objects`; a save that drops it would bring
    // the player back to a scene with no date plate until the next line.
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.load({
      ...new AirRuntimeImpl(demoManifest).save(),
      objects: {
        83: { asset: "image:G00_SDT0717.g00", x: 16, y: 16, visible: true, alpha: 1 },
        81: { x: 0, y: 0, width: 640, height: 50, visible: true, alpha: 1, fill: { r: 0, g: 0, b: 0 } },
      },
    });
    const slot: SaveSlot = { ...validSave(), state: runtime.save() };
    const imported = importSave(exportSave(slot));
    expect(imported.state.objects["83"]).toEqual({ asset: "image:G00_SDT0717.g00", x: 16, y: 16, visible: true, alpha: 1 });
    expect(imported.state.objects["81"].fill).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("accepts a save written before the object layer existed", () => {
    // Older snapshots have no `objects` key at all; the runtime defaults it.
    const slot = validSave();
    const { objects: _objects, ...legacy } = slot.state;
    const imported = importSave(JSON.stringify({ ...slot, state: legacy }));
    expect(imported.state.objects).toBeUndefined();
    expect(() => new AirRuntimeImpl(demoManifest).load(imported.state)).not.toThrow();
  });

  it.each([
    { objects: { 83: "bad" } },
    { objects: { 83: { x: 0, y: 0, alpha: 1 } } },
    { objects: { 83: { x: 0, y: 0, visible: true, alpha: 2 } } },
    { objects: { 83: { x: 0, y: 0, visible: true, alpha: 1, fill: { r: "0", g: 0, b: 0 } } } },
    { objects: { 83: { x: 0, y: 0, visible: "yes", alpha: 1 } } },
  ])("rejects a malformed object entry: %j", (change) => {
    const slot = validSave();
    expect(() => importSave(JSON.stringify({ ...slot, state: { ...slot.state, ...change } }))).toThrow("Unsupported or invalid AIR save file");
  });

  it("persists settings through IndexedDB", async () => {
    const settings = { ...defaultSettings, textSpeed: 79, displayMode: "pixel" as const, autoplay: true };
    await saveSettings(settings);
    expect(await loadSettings()).toEqual(settings);
    await saveSettings(defaultSettings);
  });

  it("clamps stored settings into their documented ranges", () => {
    const normalized = normalizeSettings({
      textSpeed: 400,
      musicVolume: 3,
      voiceVolume: -1,
      effectVolume: 0.25,
      autoAdvanceDelayMs: 99999,
      windowOpacity: 0,
      showDateCaption: false,
      displayMode: "nonsense" as unknown as UserSettings["displayMode"],
    });
    expect(normalized.textSpeed).toBe(100);
    expect(normalized.musicVolume).toBe(1);
    expect(normalized.voiceVolume).toBe(0);
    expect(normalized.effectVolume).toBe(0.25);
    expect(normalized.autoAdvanceDelayMs).toBe(autoAdvanceDelayRange.max);
    expect(normalized.windowOpacity).toBe(windowOpacityRange.min);
    expect(normalized.showDateCaption).toBe(false);
    expect(normalized.displayMode).toBe("fit");
  });

  it("defaults the new message-window options for older stored settings", () => {
    const normalized = normalizeSettings({ textSpeed: 42 });
    expect(normalized.autoAdvanceDelayMs).toBe(defaultSettings.autoAdvanceDelayMs);
    expect(normalized.windowOpacity).toBe(defaultSettings.windowOpacity);
    expect(normalized.showDateCaption).toBe(true);
  });
});

describe("autosave", () => {
  it("round-trips a rolling snapshot that Continue can resume from", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    await runtime.advance();
    const snapshot = { ...validSave(), slot: 0, title: "Auto", state: runtime.save() };
    expect(await saveAutosave(snapshot)).toBe(true);
    expect(await hasAutosave()).toBe(true);
    const loaded = await loadAutosave();
    expect(loaded?.slot).toBe(0);
    expect(loaded?.state.sceneId).toBe(snapshot.state.sceneId);
    expect(loaded?.state.instructionPointer).toBe(snapshot.state.instructionPointer);
    expect(() => runtime.load(loaded!.state)).not.toThrow();
  });

  it("never overwrites the quick save or a numbered slot", async () => {
    // The autosave is the thing that writes constantly; if it shared storage
    // with the quick slot it would silently destroy a save the player made
    // deliberately (and vice versa).
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    await saveQuickSlot({ ...validSave(), slot: 0, title: "Deliberate", state: runtime.save() });
    await runtime.advance();
    await saveAutosave({ ...validSave(), slot: 0, title: "Auto", state: runtime.save() });

    expect((await loadQuickSlot())?.title).toBe("Deliberate");
    expect((await loadAutosave())?.title).toBe("Auto");
    expect(await listSaveSlots()).toEqual([]);
  });

  it("reports no autosave for an unreadable snapshot, so Continue stays disabled", async () => {
    // A stored-but-corrupt snapshot must not advertise itself: clicking
    // Continue on it silently starts a new game, which reads as "the autosave
    // was ignored" rather than "the autosave was invalid".
    const db = await new Promise<IDBDatabase | undefined>((resolve) => {
      const request = indexedDB.open("air-se-web");
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => resolve(request.result);
    });
    if (db && db.objectStoreNames.contains("meta")) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ id: "autosave", value: { version: 1, slot: 0, title: 42, timestamp: "nope", state: { sceneId: "__proto__" } } });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
    db?.close();
    expect(await hasAutosave()).toBe(false);
    await expect(loadAutosave()).rejects.toThrow();
  });

  it("keeps the newest snapshot rather than accumulating", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    await saveAutosave({ ...validSave(), slot: 0, title: "first", state: runtime.save() });
    await runtime.advance();
    await runtime.advance();
    await saveAutosave({ ...validSave(), slot: 0, title: "second", state: runtime.save() });
    const loaded = await loadAutosave();
    expect(loaded?.title).toBe("second");
  });
});

describe("quick save", () => {
  it("round-trips a snapshot outside the numbered slot grid", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    await saveQuickSlot({ ...validSave(), slot: 0, title: "Quick", state: runtime.save() });
    const loaded = await loadQuickSlot();
    expect(loaded?.slot).toBe(0);
    expect(loaded?.state.backlog.at(-1)?.text).toBe(runtime.state.backlog.at(-1)?.text);
    expect(await listSaveSlots()).toEqual([]);
  });

  it("survives the full quick-save -> quick-load -> importSave path used by the UI", async () => {
    const runtime = new AirRuntimeImpl(demoManifest);
    runtime.startNewGame();
    await runtime.advance();
    const snapshot = { ...validSave(), slot: 0, title: "Quick", state: runtime.save() };
    await saveQuickSlot(snapshot);

    const loaded = await loadQuickSlot();
    expect(loaded).toBeDefined();
    expect(loaded?.slot).toBe(0);

    // `loadCurrent` re-validates the snapshot before handing it to the runtime.
    // The quick slot is 0, which the numbered-slot validator rejects, so this
    // must go through validateQuickSlot -- and it must survive a JSON round trip
    // because that is what the real UI path does.
    const validated = validateQuickSlot(loaded!);
    expect(validated.slot).toBe(0);
    expect(validated.state.sceneId).toBe(loaded!.state.sceneId);
    expect(() => runtime.load(validated.state)).not.toThrow();
    expect(() => importSave(exportSave(loaded!))).toThrow("Unsupported or invalid AIR save file");
  });

  it("returns undefined before any quick save exists", async () => {
    // Ordering independence: this test must not depend on another test having
    // left the quick slot empty, so delete it explicitly first. The store falls
    // back to memory when IndexedDB is unavailable, so handle both.
    const db = await new Promise<IDBDatabase | undefined>((resolve) => {
      const request = indexedDB.open("air-se-web");
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => resolve(request.result);
    });
    if (db && db.objectStoreNames.contains("meta")) {
      await new Promise<void>((resolve) => {
        const transaction = db.transaction("meta", "readwrite");
        transaction.objectStore("meta").delete("quickSave");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      });
    }
    db?.close();

    expect(await loadQuickSlot()).toBeUndefined();
  });
});
