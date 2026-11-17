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
    saveQuickSlot: vi.fn(async () => {}),
    loadQuickSlot: vi.fn(async () => undefined),
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

describe("in-idiom quality of life", () => {
  it("opens the menu from a right click on the stage and closes it again", async () => {
    await mount();
    await click(button("New Game"));
    await act(async () => {
      stage().closest(".player")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".panel h2")?.textContent).toBe("Menu");
    await act(async () => {
      stage().closest(".player")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".panel")).toBeNull();
  });

  it("quick saves and quick loads from the menu and the keyboard", async () => {
    vi.useFakeTimers();
    const runtime = new AirRuntimeImpl(manifest);
    await runtime.advance();
    const snapshot: storage.SaveSlot = { version: 1, slot: 0, title: "Quick", timestamp: new Date().toISOString(), state: runtime.save() };
    await mount();
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("Quick save (F5)"));
    expect(storage.saveQuickSlot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.saveQuickSlot).mock.calls[0][0].slot).toBe(0);
    expect(container.querySelector(".toast")?.textContent).toBe("Quick saved");

    vi.mocked(storage.loadQuickSlot).mockResolvedValue(snapshot);
    await click(button("Menu"));
    await click(button("Quick load (F9)"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await click(button("History"));
    expect(history().length).toBeGreaterThan(0);
  });

  it("reports a friendly notice when no quick save exists", async () => {
    await mount();
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("Quick load (F9)"));
    await act(async () => {});
    expect(container.querySelector(".toast")?.textContent).toBe("No quick save yet");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("applies the window opacity and date-caption settings", async () => {
    vi.mocked(storage.loadSettings).mockResolvedValue({ ...storage.defaultSettings, windowOpacity: 0.62, showDateCaption: false });
    await mount();
    await click(button("New Game"));
    const shell = container.querySelector(".app-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--window-opacity")).toBe("0.62");
    // The synthetic test scene has no date caption, so opt back in and confirm
    // the caption gate is driven by the setting rather than the scene.
    expect(container.querySelector(".stage-date")).toBeNull();
  });

  /**
   * Object 83 is the original's own date display. Once the canvas draws it the
   * DOM caption must step aside, otherwise the same date is printed twice in
   * the top-left corner. The setting governs both.
   */
  it("labels the stage with the date only while the badge is drawn", async () => {
    // The plate is canvas, so assistive technology cannot see it. The stage's
    // accessible name carries the date instead, and only when the plate is on
    // screen: on the prologue's first lines the engine has not opened its date
    // window, and `seen0163` keeps it off entirely.
    const dated: GameManifest = {
      ...manifest,
      scenes: {
        test: {
          id: "test",
          title: "July 17 (Monday)",
          instructions: [
            { op: "text", text: "Before the window opens" },
            { op: "command", offset: 0, moduleType: 1, module: 60, opcode: 1, argc: 1, overload: 0, args: [{ kind: "expression", value: { kind: "int", value: 83 } }] },
            { op: "command", offset: 0, moduleType: 1, module: 72, opcode: 1000, argc: 3, overload: 1, args: [
              { kind: "expression", value: { kind: "int", value: 83 } },
              { kind: "string", value: "SDT0717" },
              { kind: "expression", value: { kind: "int", value: 1 } },
            ] },
            { op: "command", offset: 0, moduleType: 1, module: 82, opcode: 1000, argc: 3, overload: 0, args: [
              { kind: "expression", value: { kind: "int", value: 83 } },
              { kind: "expression", value: { kind: "int", value: 16 } },
              { kind: "expression", value: { kind: "int", value: 16 } },
            ] },
            { op: "text", text: "Dated line" },
            { op: "end" },
          ],
        },
      },
      assets: { "image:G00_SDT0717.g00": { id: "image:G00_SDT0717.g00", kind: "image", url: "/images/G00__SDT0717.png", width: 150, height: 154 } },
      assetAliases: { SDT0717: "image:G00_SDT0717.g00" },
    };
    vi.mocked(loadManifest).mockResolvedValue(structuredClone(dated));
    await mount();
    await click(button("New Game"));
    // No plate yet: no date anywhere, and no text caption standing in.
    expect(stage().getAttribute("aria-label")).toBe("AIR game stage");
    expect(container.querySelector(".stage-date")).toBeNull();

    await click(stage());
    await click(stage());
    // Plate drawn: it is announced from the plate's own name, still not as text.
    expect(stage().getAttribute("aria-label")).toBe("AIR game stage — July 17");
    expect(container.querySelector(".stage-date")).toBeNull();

    // Turning the caption off removes the plate, so the label drops the date.
    await openSettings();
    const toggle = container.querySelector<HTMLInputElement>('.checkbox-row input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    await click(toggle);
    await click(button("×"));
    expect(persisted.showDateCaption).toBe(false);
    expect(stage().getAttribute("aria-label")).toBe("AIR game stage");
  });

  it("never renders a text date caption in the corner the plate occupies", async () => {
    const dated: GameManifest = {
      ...manifest,
      scenes: { test: { id: "test", title: "July 17 (Monday)", instructions: [{ op: "text", text: "No plate here" }, { op: "end" }] } },
    };
    vi.mocked(loadManifest).mockResolvedValue(structuredClone(dated));
    await mount();
    await click(button("New Game"));
    // A dated title alone must not produce a text date: without a plate there is
    // no date, exactly as in the original's title/menu/OP programs.
    expect(container.querySelector(".stage-date")).toBeNull();
    expect(stage().getAttribute("aria-label")).toBe("AIR game stage");
  });

  it("exposes a dedicated music mode populated from manifest audio", async () => {
    const withAudio: GameManifest = {
      ...manifest,
      assets: {
        "audio:BGM_BGM02.nwa": { id: "audio:BGM_BGM02.nwa", kind: "audio", url: "/bgm02.wav", source: "BGM/BGM02.nwa", durationMs: 62489 },
      },
    };
    vi.mocked(loadManifest).mockResolvedValue(structuredClone(withAudio));
    await mount();
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("Music Mode"));
    expect(container.querySelector(".panel h2")?.textContent).toBe("Music");
    expect([...container.querySelectorAll(".music-gallery button")].map((item) => item.textContent)).toEqual(["BGM 02 · unheard1:02"]);
  });

  it("shows gallery pages and a percentage instead of a flat asset list", async () => {
    const withCg: GameManifest = {
      ...manifest,
      galleryAssets: ["image:G00_FGMZ01.g00"],
      assets: { "image:G00_FGMZ01.g00": { id: "image:G00_FGMZ01.g00", kind: "image", url: "/cg.png", source: "G00/FGMZ01.g00" } },
    };
    vi.mocked(loadManifest).mockResolvedValue(structuredClone(withCg));
    vi.mocked(storage.listUnlockedAssets).mockResolvedValue(["image:G00_FGMZ01.g00"]);
    await mount();
    await click(button("New Game"));
    await click(button("Menu"));
    await click(button("CG Gallery"));
    expect(container.querySelector(".gallery-percent")?.textContent).toBe("100%");
    expect([...container.querySelectorAll(".gallery-pages button")].map((item) => item.textContent)).toEqual(["Series Z1/1"]);
    expect(container.querySelectorAll(".gallery-grid img")).toHaveLength(1);
  });
});
