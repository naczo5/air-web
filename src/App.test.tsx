// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AirRuntimeImpl } from "./runtime/airRuntime";
import { loadManifest } from "./runtime/loadManifest";
import * as storage from "./runtime/storage";
import type { GameManifest } from "./types";

vi.mock("./runtime/loadManifest", () => ({ loadManifest: vi.fn() }));
vi.mock("./runtime/storage", async (importOriginal) => {
  const original = await importOriginal<typeof storage>();
  return {
    ...original,
    listReadTextIds: vi.fn(async () => []),
    markTextRead: vi.fn(async () => {}),
    listSaveSlots: vi.fn(async () => []),
    getLastActiveSlot: vi.fn(async () => undefined),
    setLastActiveSlot: vi.fn(async () => {}),
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    saveSlot: vi.fn(async () => {}),
    unlockAsset: vi.fn(async () => {}),
    listUnlockedAssets: vi.fn(async () => []),
  };
});

const firstLine = "First line: " + "A long line to reveal before autoplay advances. ".repeat(5).trim();
const manifest: GameManifest = {
  id: "air-se", title: "Component test", generatedAt: "test", logicalSize: { width: 640, height: 480 },
  assets: {}, flowchart: { nodes: [], edges: [] }, startScene: "test",
  scenes: { test: { id: "test", instructions: [
    { op: "text", text: firstLine },
    { op: "text", text: "Second line" },
    { op: "text", text: "Third line" },
    { op: "end" },
  ] } },
};

let container: HTMLDivElement;
let root: Root | undefined;
let persisted: storage.UserSettings;

const mount = async () => {
  root = createRoot(container);
  await act(async () => { root!.render(<StrictMode><App /></StrictMode>); });
};
const unmount = async () => {
  await act(async () => root?.unmount());
  root = undefined;
};
const button = (label: string) => {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const click = async (element: Element) => {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const press = async (key: string, target: EventTarget = window, type = "keydown") => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true })); });
};
const stage = () => container.querySelector(".stage-shell")!;
const history = () => [...container.querySelectorAll(".backlog p")].map((entry) => entry.textContent?.trim());
const openSettings = async () => { await click(button("Menu")); await click(button("Settings")); };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(loadManifest).mockResolvedValue(structuredClone(manifest));
  persisted = { ...storage.defaultSettings };
  vi.mocked(storage.loadSettings).mockImplementation(async () => ({ ...persisted }));
  vi.mocked(storage.saveSettings).mockImplementation(async (settings) => { persisted = { ...settings }; });
  vi.mocked(storage.listSaveSlots).mockResolvedValue([]);
  vi.mocked(storage.listReadTextIds).mockResolvedValue([]);
  vi.mocked(storage.listUnlockedAssets).mockResolvedValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await unmount();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App gameplay", () => {
  it("reveals with one click and actually advances the backlog with the next click", async () => {
    await mount();
    await click(button("New Game"));
    await click(stage());
    expect(container.querySelector(".dialogue-text")?.textContent).toBe(firstLine);
    await click(button("History"));
    expect(history()).toEqual([firstLine]);
    await click(button("×"));
    await click(stage());
    await click(button("History"));
    expect(history()).toEqual([firstLine, "Second line"]);
    await click(button("×"));
    await press("Enter"); // reveal second line
    await press("Enter"); // advance to third line
    await click(button("History"));
    expect(history()).toEqual([firstLine, "Second line", "Third line"]);
  });

  it("does not save defaults while settings load, and persists changed settings across remount", async () => {
    let resolveSettings!: (settings: storage.UserSettings) => void;
    const pending = new Promise<storage.UserSettings>((resolve) => { resolveSettings = resolve; });
    vi.mocked(storage.loadSettings).mockReturnValue(pending);
    await mount();
    expect(storage.saveSettings).not.toHaveBeenCalled();
    await act(async () => { resolveSettings({ ...persisted, textSpeed: 81, displayMode: "pixel" }); });
    await click(button("New Game"));
    await openSettings();
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe("81");
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "fit"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(persisted.displayMode).toBe("fit");
    expect(persisted.textSpeed).toBe(81);
    await unmount();
    vi.mocked(storage.loadSettings).mockImplementation(async () => ({ ...persisted }));
    await mount();
    await click(button("New Game"));
    await openSettings();
    expect(container.querySelector("select")?.value).toBe("fit");
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe("81");
  });

  it("shows malformed import errors without saving or changing the current game", async () => {
    await mount();
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("Load"));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["null"], "broken.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => "null" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to import save");
    expect(storage.saveSlot).not.toHaveBeenCalled();
    await click(button("×"));
    await click(button("History"));
    expect(history()).toEqual([firstLine]);
  });

  it("shows save and load failures instead of closing the panel or entering a broken game", async () => {
    const runtime = new AirRuntimeImpl(manifest);
    const invalidSlot: storage.SaveSlot = { version: 1, slot: 1, title: "Other game", timestamp: new Date().toISOString(), state: { ...runtime.save(), sceneId: "missing" } };
    vi.mocked(storage.listSaveSlots).mockResolvedValue([invalidSlot]);
    vi.mocked(storage.saveSlot).mockRejectedValue(new Error("Storage full"));
    await mount();
    await click(button("Continue"));
    expect(container.querySelector(".title-screen")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to load game");
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("Save"));
    await click(container.querySelector(".save-slot")!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Storage full");
    expect(container.querySelector(".panel h2")?.textContent).toBe("Save");
  });

  it("waits for reveal before autoplay and never advances behind menus", async () => {
    vi.useFakeTimers();
    persisted.autoplay = true;
    await mount();
    await click(button("New Game"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await click(button("History"));
    expect(history()).toEqual([firstLine]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(history()).toEqual([firstLine]);
    await click(button("×"));
    await act(async () => { await vi.advanceTimersByTimeAsync(949); });
    await click(button("History"));
    expect(history()).toEqual([firstLine]);
    await click(button("×"));
    await act(async () => { await vi.advanceTimersByTimeAsync(950); });
    await click(button("History"));
    expect(history()).toEqual([firstLine, "Second line"]);
  });

  it("ignores Control on controls and panels, and releases held skip on window blur", async () => {
    vi.useFakeTimers();
    const setMode = vi.spyOn(AirRuntimeImpl.prototype, "setMode");
    await mount();
    await click(button("New Game"));
    setMode.mockClear();
    await press("Control", button("Menu"));
    expect(setMode).not.toHaveBeenCalledWith("skip");
    await openSettings();
    setMode.mockClear();
    await press("Control", container.querySelector("select")!);
    await press("Control", container.querySelector(".panel")!);
    await press("Control");
    expect(setMode).not.toHaveBeenCalledWith("skip");
    await click(button("×"));
    await press("Control");
    expect(setMode).toHaveBeenLastCalledWith("skip");
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(setMode).toHaveBeenLastCalledWith("normal");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(container.querySelector(".status-bar")?.textContent).toContain("Mode: normal");
  });

  it("stops skip when opening menus and clears panels on title/New Game/Continue", async () => {
    vi.useFakeTimers();
    const runtime = new AirRuntimeImpl(manifest);
    await runtime.advance();
    vi.mocked(storage.listSaveSlots).mockResolvedValue([{ version: 1, slot: 1, title: "Saved", timestamp: new Date().toISOString(), state: runtime.save() }]);
    const setMode = vi.spyOn(AirRuntimeImpl.prototype, "setMode");
    await mount();
    await click(button("New Game"));
    await click(button("Skip All"));
    await click(button("Menu"));
    expect(setMode).toHaveBeenLastCalledWith("normal");
    await click(button("Return to title"));
    await click(button("Continue"));
    expect(container.querySelector(".panel")).toBeNull();
    await click(button("Menu"));
    await click(button("Return to title"));
    await click(button("New Game"));
    expect(container.querySelector(".panel")).toBeNull();
    await click(stage());
    await click(stage());
    await click(button("History"));
    expect(history()).toEqual([firstLine, "Second line"]);
  });

  it("unsubscribes runtime events and disposes the instance on unmount", async () => {
    const dispose = vi.spyOn(AirRuntimeImpl.prototype, "dispose");
    const original = AirRuntimeImpl.prototype.onEvent;
    const unsubscribe = vi.fn();
    vi.spyOn(AirRuntimeImpl.prototype, "onEvent").mockImplementation(function (this: AirRuntimeImpl, listener) {
      const cleanup = original.call(this, listener);
      return () => { unsubscribe(); cleanup(); };
    });
    await mount();
    await unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows manifest loading errors with a retry action", async () => {
    vi.mocked(loadManifest).mockRejectedValue(new Error("Game manifest unavailable"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Game manifest unavailable");
    expect(button("Retry")).toBeDefined();
    expect(container.textContent).not.toContain("Loading AIR…");
  });
});
