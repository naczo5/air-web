import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameStage } from "./components/GameStage";
import { FlowchartView } from "./components/FlowchartView";
import { loadManifest } from "./runtime/loadManifest";
import { AirRuntimeImpl } from "./runtime/airRuntime";
import { PackedImage, playPackedAudio } from "./runtime/packedMedia";
import { resolveAudioUrl } from "./runtime/packResolver";
import { AssetLoader } from "./runtime/assetLoader";
import { preloadImage, preloadAudioUrl, warmedAudioUrl } from "./runtime/preloader";
import { formatDuration, galleryEntries, galleryPercent, musicTracks, type MusicTrack } from "./runtime/gallery";
import { hasScene, sceneTitle } from "./runtime/sceneStore";
import { DATE_PLATE_OBJECT, datePlateLabel, drawnObject } from "./runtime/display";
import { autoAdvanceDelayRange, defaultSettings, exportSave, getLastActiveSlot, importSave, listReadTextIds, listSaveSlots, listUnlockedAssets, loadAutosave, hasAutosave, loadQuickSlot, loadSettings, markTextRead, saveAutosave, saveQuickSlot, saveSettings, saveSlot, setLastActiveSlot, unlockAsset, validateQuickSlot, windowOpacityRange, type SaveSlot, type UserSettings } from "./runtime/storage";
import type { BacklogEntry, GameManifest, RuntimeDiagnostic, RuntimeEvent, RuntimeState } from "./types";
import "./styles.css";

type Panel = "none" | "menu" | "save" | "load" | "settings" | "backlog" | "gallery" | "music" | "flowchart";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Please try again.";

function PanelButton({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return <button className={`menu-button${className ? ` ${className}` : ""}`} onClick={onClick}>{children}</button>;
}

export default function App() {
  const [manifest, setManifest] = useState<GameManifest>();
  const [runtime, setRuntime] = useState<AirRuntimeImpl>();
  const [state, setState] = useState<RuntimeState>();
  const [started, setStarted] = useState(false);
  const [text, setText] = useState("Loading AIR game data…");
  const [currentEntry, setCurrentEntry] = useState<BacklogEntry>();
  const [textRevealed, setTextRevealed] = useState(true);
  const [choice, setChoice] = useState<string[]>();
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostic[]>([]);
  const [panel, setPanel] = useState<Panel>("none");
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  /** Whether a rolling autosave exists, so Continue is enabled without a manual save. */
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [lastActiveSlot, setLastActiveSlotState] = useState<number | undefined>();
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loadingError, setLoadingError] = useState<string>();
  const importInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** One cache for stage painting, prefetch hints and audio resolution. */
  const loaderRef = useRef<AssetLoader | undefined>(undefined);
  const musicRef = useRef<HTMLAudioElement>(null);
  const voiceRef = useRef<HTMLAudioElement>(null);
  /** Ambient beds, keyed by asset id so a repeated cue does not restart them. */
  const effectPlayers = useRef(new Map<string, HTMLAudioElement>());
  const textRevealedRef = useRef(true);
  const currentTextRef = useRef(text);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;
    void Promise.all([loadManifest(), listReadTextIds().catch(() => [])]).then(([loaded, readTextIds]) => {
      if (!active) return;
      const instance = new AirRuntimeImpl(loaded, {
        readTextIds,
        onTextRead: (id) => { void markTextRead(id).catch(() => undefined); },
      });
      const unsubscribe = instance.onEvent((event: RuntimeEvent) => {
        if (event.type === "text") {
          setText(event.entry.text);
          currentTextRef.current = event.entry.text;
          setCurrentEntry(event.entry);
          const isSkipping = instance.mode === "skip" || instance.mode === "skip-read";
          textRevealedRef.current = isSkipping;
          setTextRevealed(isSkipping);
          setChoice(undefined);
        } else if (event.type === "choice") {
          setChoice(event.options);
        } else if (event.type === "prefetch") {
          // Warm what the next lines need while the current one is on screen.
          // This is the whole point on a slow link: the network is idle during
          // reading, and every packed asset is a separate round trip.
          for (const id of event.images) loaderRef.current?.preload(id);
          const assets = loaded.assets;
          for (const id of event.audio) {
            const asset = assets[id];
            if (asset) void preloadAudioUrl(asset.url, resolveAudioUrl);
          }
        } else if (event.type === "diagnostic") {
          setDiagnostics((current) => [...current.slice(-9), event.diagnostic]);
        } else if (event.type === "ended") {
          const endingMsg = "◆ Route Completed ◆\nClick anywhere or press Enter to return to the Title Screen.";
          setText(endingMsg);
          currentTextRef.current = endingMsg;
          setCurrentEntry({ id: "end", sceneId: instance.state.sceneId, text: endingMsg, speaker: "AIR" });
          textRevealedRef.current = true;
          setTextRevealed(true);
          setChoice(undefined);
        }
        setState({ ...instance.state, layers: instance.state.layers.map((layer) => ({ ...layer })) });
      });
      loaderRef.current = new AssetLoader(loaded.assets);
      setManifest(loaded);
      setRuntime(instance);
      setState(instance.state);
      cleanup = () => { unsubscribe(); instance.dispose(); };
    }).catch((failure: unknown) => {
      if (active) setLoadingError(`Unable to load AIR: ${errorMessage(failure)}`);
    });
    return () => { active = false; cleanup?.(); };
  }, []);

  const refreshSaves = useCallback(() => {
    void listSaveSlots().then(setSaves).catch((failure: unknown) => setError(`Unable to list saves: ${errorMessage(failure)}`));
    void hasAutosave().then(setAutoAvailable).catch(() => setAutoAvailable(false));
  }, []);

  useEffect(() => {
    refreshSaves();
    void getLastActiveSlot().then(setLastActiveSlotState).catch(() => undefined);
  }, [refreshSaves]);

  useEffect(() => {
    let active = true;
    void loadSettings().then((loaded) => {
      if (!active) return;
      setSettings(loaded);
      setSettingsLoaded(true);
    }).catch((failure: unknown) => {
      if (active) setError(`Unable to load settings: ${errorMessage(failure)}`);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    // Never overwrite stored preferences with defaults before hydration completes.
    if (!settingsLoaded) return;
    void saveSettings(settings).catch((failure: unknown) => setError(`Unable to save settings: ${errorMessage(failure)}`));
  }, [settings, settingsLoaded]);

  useEffect(() => {
    if (!started || !state) return;
    const ids = new Set<string>([
      ...state.layers.flatMap((layer) => layer.asset ? [layer.asset] : []),
      ...(state.audio.music ? [state.audio.music] : []),
      ...(state.audio.voice ? [state.audio.voice] : []),
      ...state.audio.effects,
    ]);
    void Promise.all([...ids].map((id) => unlockAsset(id))).catch(() => undefined);
  }, [started, state]);

  useEffect(() => {
    const audio = musicRef.current;
    if (!audio) return;
    if (!started || !manifest) {
      audio.pause();
      audio.removeAttribute("src");
      return;
    }
    // A stopped track (`1:20:105`) must not tear down the element: the script
    // fades out and immediately re-issues the same track, and pausing here made
    // music restart from zero (and audibly hitch) on every scene transition.
    // Only a *different* track replaces the source.
    const asset = state?.audio.music ? manifest.assets[state.audio.music] : undefined;
    if (!asset) {
      // `1:20:105` stops the current track and the very next instruction often
      // starts another, so pausing immediately produced an audible hiccup on
      // every transition. Defer the pause briefly: if no track replaces it, the
      // music really did stop and the element is halted.
      const timer = window.setTimeout(() => { audio.pause(); }, 400);
      return () => window.clearTimeout(timer);
    }
    let active = true;
    const source = preloadAudioUrl(asset.url, resolveAudioUrl);
    void source.then((resolved) => {
      if (!active || !resolved) return;
      const absolute = new URL(resolved, window.location.href).href;
      if (audio.src !== absolute) {
        // New track: only now reset the position.
        audio.src = resolved;
        try {
          audio.currentTime = (state?.audio.musicPositionMs ?? 0) / 1000;
        } catch {
          // Ignore unready audio state
        }
      }
      audio.loop = state?.audio.musicLoop ?? asset.loop ?? true;
      audio.volume = Math.max(0, Math.min(1, settings.musicVolume));
      if (audio.paused) void audio.play().catch(() => undefined);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [manifest, settings.musicVolume, started, state?.audio.music, state?.audio.musicLoop]);

  useEffect(() => {
    const audio = voiceRef.current;
    if (!audio) return;
    if (!started || !state?.audio.voice || !manifest) {
      audio.pause();
      audio.removeAttribute("src");
      return;
    }
    const asset = manifest.assets[state.audio.voice];
    if (!asset) return;
    let active = true;
    // Reuse the prefetched source when there is one: without this the voice
    // would issue a second identical range request right after warming it.
    const source = warmedAudioUrl(asset.url) ?? preloadAudioUrl(asset.url, resolveAudioUrl);
    void source.then((resolved) => {
      if (!active || !resolved) return;
      audio.src = resolved;
      audio.loop = false;
      audio.volume = Math.max(0, Math.min(1, settings.voiceVolume));
      void audio.play().catch(() => undefined);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [manifest, settings.voiceVolume, started, state?.audio.voice]);

  const lastEffectId = state?.audio.effects.at(-1);
  /**
   * Identity of the live effect list, as a string.
   *
   * The runtime replaces the array on every cue, so depending on the array
   * itself would re-run on unrelated state changes. Joining gives a value that
   * only changes when the list actually changes.
   */
  const effectKey = state?.audio.effects.join("\u0000") ?? "";

  /**
   * Reconcile ambient beds against the live effect list.
   *
   * Effects are keyed by asset and stop only when the runtime drops them
   * (`1:21:5/20/105`). Reconcile — rather than reacting to "the list is now
   * empty" — because 14 real sites clear and then start a bed inside the same
   * text block, so React never observes an empty list and the old bed would
   * keep playing underneath the new one (e.g. `seen0203` starts `KUMA` while
   * `KUMA_LOW` still loops).
   */
  useEffect(() => {
    if (!started || !manifest) return;
    const live = new Set(state?.audio.effects ?? []);
    // Stop anything the script no longer lists.
    for (const [id, player] of [...effectPlayers.current]) {
      if (live.has(id)) continue;
      try {
        player.pause();
        player.removeAttribute("src");
      } catch {
        // Safe disposal
      }
      effectPlayers.current.delete(id);
    }
    // Start or refresh anything it does list.
    for (const id of live) {
      const asset = manifest.assets[id];
      if (!asset) continue;
      let audio = effectPlayers.current.get(id);
      if (!audio) {
        audio = new Audio();
        audio.loop = true;
        effectPlayers.current.set(id, audio);
      }
      const player = audio;
      const source = warmedAudioUrl(asset.url) ?? preloadAudioUrl(asset.url, resolveAudioUrl);
      void source.then((resolved) => {
        if (!resolved || !effectPlayers.current.has(id)) return;
        const absolute = new URL(resolved, window.location.href).href;
        if (player.src !== absolute) player.src = resolved;
        player.loop = true;
        player.volume = Math.max(0, Math.min(1, settings.effectVolume));
        if (player.paused) void player.play().catch(() => undefined);
      }).catch(() => undefined);
    }
  }, [effectKey, manifest, settings.effectVolume, started]);

  useEffect(() => () => {
    for (const player of [...effectPlayers.current.values()]) {
      try {
        player.pause();
        player.removeAttribute("src");
      } catch {
        // Safe disposal
      }
    }
    effectPlayers.current.clear();
  }, []);

  useEffect(() => {
    // The UI owns autoplay timing. Runtime auto mode can advance immediately
    // when enabled, before Typewriter has revealed the current line.
    if (!started || panel !== "none" || !settings.autoplay || !textRevealed || choice || state?.waiting !== "text" || runtime?.mode !== "normal") return;
    const timer = window.setTimeout(() => { void runtime.advance(); }, settings.autoAdvanceDelayMs);
    return () => window.clearTimeout(timer);
  }, [choice, panel, runtime, runtime?.mode, settings.autoplay, settings.autoAdvanceDelayMs, started, textRevealed, state?.sceneId, state?.instructionPointer, state?.waiting]);

  const advance = useCallback(() => {
    if (!runtime || choice || !started || panel !== "none") return;
    if (state?.waiting === "end") {
      runtime.setMode("normal");
      setPanel("none");
      setStarted(false);
      return;
    }
    if (!textRevealedRef.current) {
      // Typewriter does not call onComplete when forcibly revealed.
      textRevealedRef.current = true;
      setTextRevealed(true);
      return;
    }
    void runtime.advance().catch((failure: unknown) => {
      // A rejected advance must surface instead of leaving the player idle.
      setError(`Unable to continue: ${errorMessage(failure)}`);
    });
  }, [choice, panel, runtime, started, state?.waiting]);

  /**
   * Overlay panels are modal: keep Tab inside the dialog and return focus to
   * whatever opened it. Without this, keyboard users tab into the game chrome
   * rendered behind the overlay and cannot reach the panel's lower controls.
   */
  useEffect(() => {
    if (panel === "none" || panel === "flowchart") return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => {
      const root = panelRef.current;
      if (!root) return [];
      return [...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null || element === document.activeElement);
    };
    // Move focus into the dialog so the first Tab lands inside it.
    const initial = focusable()[0];
    if (initial) initial.focus();
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleTab);
    return () => {
      document.removeEventListener("keydown", handleTab);
      previous?.focus?.();
    };
  }, [panel]);

  const toggleSkip = useCallback((mode: "skip" | "skip-read") => {
    if (!runtime) return;
    setPanel("none");
    runtime.setMode(runtime.mode === mode ? "normal" : mode);
  }, [runtime]);

  const ctrlSkippingRef = useRef(false);

  useEffect(() => {
    if (!runtime || (started && panel === "none")) return;
    ctrlSkippingRef.current = false;
    runtime.setMode("normal");
  }, [panel, runtime, started]);

  useEffect(() => {
    const releaseControl = () => {
      if (!ctrlSkippingRef.current) return;
      ctrlSkippingRef.current = false;
      if (runtime?.mode === "skip") runtime.setMode("normal");
    };
    const handleVisibility = () => { if (document.hidden) releaseControl(); };
    window.addEventListener("blur", releaseControl);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("blur", releaseControl);
      document.removeEventListener("visibilitychange", handleVisibility);
      releaseControl();
    };
  }, [runtime]);

  const persistState = useCallback(async (slot: number): Promise<boolean> => {
    if (!runtime) return false;
    runtime.setMusicPosition((musicRef.current?.currentTime ?? 0) * 1000);
    let thumbnail: string | undefined = undefined;
    try {
      thumbnail = document.querySelector<HTMLCanvasElement>(".game-canvas")?.toDataURL("image/png");
    } catch {
      // Ignore canvas read errors
    }
    setError(undefined);
    try {
      await saveSlot({ version: 1, slot, title: text.slice(0, 80) || "AIR", timestamp: new Date().toISOString(), state: runtime.save(), thumbnail });
      setLastActiveSlotState(slot);
      return true;
    } catch (failure) {
      setError(`Unable to save game: ${errorMessage(failure)}`);
      return false;
    }
  }, [runtime, text]);

  const saveCurrent = useCallback(async (slot: number) => {
    if (await persistState(slot)) { refreshSaves(); setPanel("none"); }
  }, [persistState, refreshSaves]);

  /** Quick save: one rolling snapshot, never touching the numbered slots. */
  const quickSave = useCallback(async () => {
    if (!runtime) return;
    runtime.setMusicPosition((musicRef.current?.currentTime ?? 0) * 1000);
    let thumbnail: string | undefined = undefined;
    try {
      thumbnail = document.querySelector<HTMLCanvasElement>(".game-canvas")?.toDataURL("image/png");
    } catch {
      // Ignore canvas read errors
    }
    setError(undefined);
    try {
      await saveQuickSlot({ version: 1, slot: 0, title: text.slice(0, 80) || "AIR", timestamp: new Date().toISOString(), state: runtime.save(), thumbnail });
      setNotice("Quick saved");
    } catch (failure) {
      setError(`Unable to quick save: ${errorMessage(failure)}`);
    }
  }, [runtime, text]);

  /**
   * Autosave.
   *
   * Mirrors the reference port's behaviour: one rolling snapshot, refreshed as
   * the player advances, in its own store so it can never overwrite a
   * deliberate quick save or a numbered slot. Debounced because advancing is
   * cheap and writing a save (plus a canvas thumbnail) is not; skipped in skip
   * modes, where the player is racing through lines they already know and the
   * only save that matters is wherever they stop.
   */
  useEffect(() => {
    if (!started || !runtime || !settings.autosave) return;
    if (runtime.mode === "skip" || runtime.mode === "skip-read") return;
    if (!state?.sceneId || state.waiting === "end") return;
    const timer = window.setTimeout(() => {
      runtime.setMusicPosition((musicRef.current?.currentTime ?? 0) * 1000);
      let thumbnail: string | undefined;
      try {
        thumbnail = document.querySelector<HTMLCanvasElement>(".game-canvas")?.toDataURL("image/png");
      } catch {
        // A tainted or unavailable canvas must not block the save.
      }
      // Silent: a quota failure mid-scene must not interrupt reading.
      void saveAutosave({
        version: 1,
        slot: 0,
        title: text.slice(0, 80) || "AIR",
        timestamp: new Date().toISOString(),
        state: runtime.save(),
        thumbnail,
      }, { silent: true });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [runtime, settings.autosave, started, state?.sceneId, state?.instructionPointer, text]);

  const loadCurrent = useCallback((slot: SaveSlot) => {    if (!runtime) return;
    setError(undefined);
    try {
      // The quick slot is number 0, which the numbered-slot validator rejects;
      // validate it through its own entry point instead.
      const validated = slot.slot === 0 ? validateQuickSlot(slot) : importSave(exportSave(slot));
      runtime.setMode("normal");
      runtime.load(validated.state);
      if (slot.slot > 0) void setLastActiveSlot(slot.slot).then(() => setLastActiveSlotState(slot.slot)).catch((failure: unknown) => setError(`Unable to remember save slot: ${errorMessage(failure)}`));
      setPanel("none");
      setStarted(true);
      setText(validated.state.backlog.at(-1)?.text ?? "");
      currentTextRef.current = validated.state.backlog.at(-1)?.text ?? "";
      setCurrentEntry(validated.state.backlog.at(-1));
      textRevealedRef.current = true;
      setTextRevealed(true);
      setChoice(validated.state.pendingChoice?.options);
    } catch (failure) {
      setError(`Unable to load game: ${errorMessage(failure)}`);
    }
  }, [runtime]);

  /** Quick load from the rolling snapshot. */
  const quickLoad = useCallback(async () => {
    if (!runtime || !manifest) return;
    setError(undefined);
    try {
      const slot = await loadQuickSlot();
      if (!slot) { setNotice("No quick save yet"); return; }
      if (!hasScene(manifest, slot.state.sceneId)) throw new Error("This quick save belongs to an unavailable scene.");
      loadCurrent(slot);
      setNotice("Quick save loaded");
    } catch (failure) {
      setError(`Unable to quick load: ${errorMessage(failure)}`);
    }
  }, [loadCurrent, manifest, runtime]);

  /** Resume from the rolling autosave, without touching the quick slot. */
  const resumeAutosave = useCallback(async () => {
    if (!runtime || !manifest) return;
    setError(undefined);
    try {
      const slot = await loadAutosave();
      if (!slot) { setNotice("No autosave yet"); return; }
      if (!hasScene(manifest, slot.state.sceneId)) throw new Error("This autosave belongs to an unavailable scene.");
      loadCurrent(slot);
      setNotice("Autosave resumed");
    } catch (failure) {
      setError(`Unable to resume autosave: ${errorMessage(failure)}`);
    }
  }, [loadCurrent, manifest, runtime]);

  useEffect(() => {
    if (!started || !runtime) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inFormControl = target instanceof Element && target.closest("button, input, textarea, select, a, [contenteditable]:not([contenteditable='false']), [role='button']");

      // Cancel is the original engine's global "back" key (CANCELCALL=9040):
      // it must work even when focus sits on a menu button or a slider.
      if (event.key === "Escape" && !event.repeat) {
        event.preventDefault();
        setPanel((current) => (current === "none" ? "menu" : "none"));
        return;
      }
      if (event.key === "F5" && !event.repeat) {
        // Quick save/load mirror the original's always-available SYSCOM entries.
        event.preventDefault();
        void quickSave();
        return;
      }
      if (event.key === "F9" && !event.repeat) {
        event.preventDefault();
        void quickLoad();
        return;
      }

      if (inFormControl) {
        // Let a focused control handle its own activation keys.
        if (event.key === "Enter" || event.key === " ") {
          const element = target as HTMLElement;
          if (element.closest("button, [role='button']") && panel !== "none") return;
        }
        return;
      }

      if (event.key === "Control" && !event.repeat && !ctrlSkippingRef.current) {
        if (panel === "none" && !choice && runtime.mode === "normal") {
          ctrlSkippingRef.current = true;
          runtime.setMode("skip");
        }
      } else if (event.key === "Enter" || event.key === " ") {
        if (panel === "none" && !choice) {
          event.preventDefault();
          advance();
        }
      } else if (event.key === "PageUp" || event.key === "h" || event.key === "H") {
        if (panel === "none" || panel === "backlog") {
          event.preventDefault();
          setPanel((current) => (current === "backlog" ? "none" : "backlog"));
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" && ctrlSkippingRef.current) {
        ctrlSkippingRef.current = false;
        if (runtime.mode === "skip") {
          runtime.setMode("normal");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [advance, choice, panel, quickLoad, quickSave, runtime, started]);


  const handleImport = async (file: File) => {
    setError(undefined);
    try {
      const parsed = importSave(await file.text());
      if (!manifest || !hasScene(manifest, parsed.state.sceneId)) throw new Error("This save belongs to an unavailable scene.");
      await saveSlot(parsed);
      setLastActiveSlotState(parsed.slot);
      refreshSaves();
    } catch (failure) {
      setError(`Unable to import save: ${errorMessage(failure)}`);
    }
  };

  const exportCurrent = useCallback(() => {
    if (!runtime) return;
    runtime.setMusicPosition((musicRef.current?.currentTime ?? 0) * 1000);
    const payload = exportSave({ version: 1, slot: 1, title: text.slice(0, 80) || "AIR", timestamp: new Date().toISOString(), state: runtime.save() });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "air-save.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [runtime, text]);

  /**
   * New game entry point. The original title selector (`seen9038`) picks one of
   * three story entries from `$5[1013]`: 0 = prologue (`seen0170`), 1 = Summer
   * arc (`seen0700`), 2 = AIR/Sora arc (`seen0163`). Starting only at the
   * prologue made the Summer and AIR arcs structurally unreachable, because
   * neither is linked from the prologue's scene graph.
   */
  const startGame = useCallback((route: "prologue" | "summer" | "air" = "prologue") => {
    if (!runtime) return;
    const entryScene = route === "summer" ? "seen0700" : route === "air" ? "seen0163" : undefined;
    if (entryScene && hasScene(manifest!, entryScene)) {
      runtime.load({
        sceneId: entryScene,
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
        objects: {},
      });
    } else {
      runtime.startNewGame();
    }
    runtime.setMode("normal");
    setPanel("none");
    setError(undefined);
    setStarted(true);
    setText("Starting AIR…");
    currentTextRef.current = "Starting AIR…";
    setChoice(undefined);
    setCurrentEntry(undefined);
    textRevealedRef.current = true;
    setTextRevealed(true);
    void runtime.advance().catch((failure: unknown) => setError(`Unable to start: ${errorMessage(failure)}`));
  }, [manifest, runtime]);

  const continueGame = useCallback(async () => {
    if (!runtime) return startGame("prologue");
    // Prefer a deliberate save; fall back to the autosave so "Continue" works
    // even for a player who never pressed F5 — which is the whole point of
    // autosaving.
    const slot = saves.find((candidate) => candidate.slot === lastActiveSlot) ?? saves[0];
    if (slot) { loadCurrent(slot); return; }
    try {
      const auto = await loadAutosave();
      if (auto) { loadCurrent(auto); return; }
    } catch {
      // A corrupt autosave must not block starting a new game.
    }
    startGame("prologue");
  }, [lastActiveSlot, loadCurrent, runtime, saves, startGame]);

  const visibleSaves = useMemo(() => Array.from({ length: 100 }, (_, index) => saves.find((slot) => slot.slot === index + 1)), [saves]);

  const jumpToScene = useCallback((sceneId: string, instruction: number = 0) => {
    if (!runtime) return;
    runtime.load({
      sceneId,
      instructionPointer: instruction,
      waiting: undefined,
      layers: [],
      textBuffer: "",
      backlog: state?.backlog ?? [],
      audio: { effects: [], musicPositionMs: 0 },
      flags: state?.flags ?? {},
      variables: state?.variables ?? {},
      integerMemory: state?.integerMemory ?? {},
      stringMemory: state?.stringMemory ?? {},
      callStack: [],
      selectionHistory: [],
      viewedAssets: state?.viewedAssets ?? [],
      graphicsBuffers: {},
      storeRegister: 0,
      objects: {},
    });
    setStarted(true);
    setPanel("none");
    setText(`Jumping to ${sceneId}…`);
    currentTextRef.current = `Jumping to ${sceneId}…`;
    setChoice(undefined);
    setCurrentEntry(undefined);
    textRevealedRef.current = true;
    setTextRevealed(true);
    runtime.setMode("normal");
    void runtime.advance();
  }, [runtime, state]);

  const errorNotice = error && (
    <div className="error-notice" role="alert">
      <p>{error}</p>
      <button onClick={() => setError(undefined)}>Dismiss error</button>
    </div>
  );

  // Transient confirmations (quick save/load) fade out on their own.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (loadingError) return (
    <main className="loading-screen">
      <div className="loading-inner" role="alert">
        <span className="loading-mark" aria-hidden="true">AIR</span>
        <p>{loadingError}</p>
        <button className="text-button" onClick={() => window.location.reload()}>Retry</button>
      </div>
    </main>
  );
  if (!manifest || !runtime || !state) return (
    <main className="loading-screen">
      <div className="loading-inner" aria-live="polite">
        <span className="loading-mark" aria-hidden="true">AIR</span>
        <p>Loading AIR…</p>
      </div>
    </main>
  );

  if (!started) {
    const titleAssetId = ["S_TT_BG10", "S_TT_BG11", "S_TT_BG12", "S_TT_BG13"]
      .map((alias) => manifest.assetAliases?.[alias])
      .find((assetId) => Boolean(assetId));
    const titleAsset = titleAssetId ? manifest.assets[titleAssetId] : undefined;
    return (
      <main className="title-screen">
        <div className="title-sheet">
          <div className={`title-painting${titleAsset ? "" : " title-painting-fallback"}`}>
            {titleAsset ? (
              <PackedImage className="title-art" asset={titleAsset} alt={`AIR — ${sceneTitle(manifest, manifest.startScene) ?? "title screen"}`} draggable={false} />
            ) : (
              <div className="title-fallback" aria-hidden="true">
                <div className="title-fallback-sky">
                  <span className="title-fallback-logo">AIR</span>
                  <span className="title-fallback-sub">Standard Edition</span>
                </div>
                <span className="title-fallback-note">Load your own AIR game data to begin</span>
              </div>
            )}
            <nav className="title-menu" aria-label="Title menu">
              <button className="title-menu-button" onClick={() => startGame("prologue")}>New Game</button>
              <button className="title-menu-button" disabled={!saves.length && !autoAvailable} onClick={() => void continueGame()}>Continue</button>
              <button className="title-menu-button" onClick={() => setPanel("flowchart")}>Story Flowchart</button>
            </nav>
            {/* The original title selector offers three story entries (DREAM /
                SUMMER / AIR). They are separate entry points in the bytecode,
                so a single "New Game" would leave two arcs unreachable. */}
            <nav className="title-routes" aria-label="Story entry">
              <span className="title-routes-label">Begin from</span>
              <button className="title-route-button" onClick={() => startGame("prologue")}>Dream</button>
              <button className="title-route-button" onClick={() => startGame("summer")}>Summer</button>
              <button className="title-route-button" onClick={() => startGame("air")}>Air</button>
            </nav>
          </div>
          <p className="title-credit">
            <span>Standard Edition</span>
            <span>VisualArt&rsquo;s / Key</span>
            <span>Unofficial browser player</span>
          </p>
          {errorNotice}
        </div>
        {panel === "flowchart" && (
          <FlowchartView manifest={manifest} state={state} onJumpToScene={jumpToScene} onClose={() => setPanel("none")} />
        )}
      </main>
    );
  }

  // The original prints the current date as a graphic plate in the top-left,
  // drawn by the engine's object table (slot 83). The port now implements that
  // table, so the date is a canvas graphic rather than text: a text caption in
  // the same corner would print the date twice, and would print it on lines
  // where the engine has not opened its date window yet (the prologue's first
  // lines run before `1:30:0`; `seen0163` disables the window outright).
  /**
   * Canvas graphics are invisible to assistive technology, so the stage's label
   * carries the date. It is read from the plate that was actually drawn, not
   * from scene metadata, so the announcement cannot disagree with the picture,
   * and it is gated by the same setting so a user who hid the date is not told
   * it either.
   */
  const drawnPlate = drawnObject(state.objects, DATE_PLATE_OBJECT, { showDateCaption: settings.showDateCaption });
  /**
   * Month and day come from the plate's own resource name. The weekday is not
   * announced: it is painted into the graphic, and one scene title
   * (`seen0503`, "August 4 (Thursday)") disagrees with the 2000 calendar, so
   * deriving it from the title could announce a weekday the badge does not show.
   */
  const plateDate = datePlateLabel(drawnPlate?.asset);
  const stageLabel = plateDate ? `AIR game stage — ${plateDate}` : "AIR game stage";

  return (
    <main className={`app-shell display-${settings.displayMode}`} style={{ "--window-opacity": settings.windowOpacity } as React.CSSProperties}>
      {panel === "none" && errorNotice}
      <header className="top-bar">
        <div className="brand-lockup">
          <span className="brand-mark">AIR</span>
          <span className="brand-sub">Standard Edition</span>
        </div>
        <nav className="top-actions" aria-label="Game controls">
          <button className={runtime.mode === "skip" ? "active" : ""} aria-pressed={runtime.mode === "skip"} onClick={() => toggleSkip("skip")}>Skip All</button>
          <button className={runtime.mode === "skip-read" ? "active" : ""} aria-pressed={runtime.mode === "skip-read"} onClick={() => toggleSkip("skip-read")}>Skip Read</button>
          <button onClick={() => setPanel("backlog")}>History</button>
          <button onClick={() => setPanel("flowchart")}>Flowchart</button>
          <button onClick={() => setPanel("menu")}>Menu</button>
        </nav>
      </header>

      <section className="player" tabIndex={0} onContextMenu={(event) => { event.preventDefault(); setPanel((current) => (current === "none" ? "menu" : "none")); }}>
        <div className="stage-column">
          <GameStage manifest={manifest} state={state} onClick={advance} showDateCaption={settings.showDateCaption} label={stageLabel} />
          <div className="dialogue" aria-live="polite">
            {currentEntry?.speaker && <div className="speaker-name">{currentEntry.speaker}</div>}
            <div className="dialogue-text"><Typewriter text={text} speed={settings.textSpeed} revealed={textRevealed} onComplete={(completedText) => { if (completedText !== currentTextRef.current) return; textRevealedRef.current = true; setTextRevealed(true); }} /></div>
            {choice && <div className="choice-list">{choice.map((option, index) => <button key={`${index}:${option}`} onClick={() => void runtime.choose(index)}>{option}</button>)}</div>}
            {!choice && (
              <div className="advance-hint">
                {state.waiting === "end" ? "Click or press Enter to return to Title Screen" : "Click or press Enter to continue"}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="status-bar"><span>{manifest.title}</span><span>Scene: {state.sceneId}</span><span>Mode: {settings.autoplay && runtime.mode === "normal" ? "auto" : runtime.mode}</span></footer>

      {notice && <div className="toast" role="status">{notice}</div>}

      {panel === "flowchart" && (
        <FlowchartView manifest={manifest} state={state} onJumpToScene={jumpToScene} onClose={() => setPanel("none")} />
      )}

      {panel !== "none" && panel !== "flowchart" && <div className="panel-backdrop" onClick={() => setPanel("none")}>
        <section
          className="panel"
          role="dialog"
          aria-modal="true"
          aria-label={panel === "menu" ? "Menu" : panel.charAt(0).toUpperCase() + panel.slice(1)}
          ref={panelRef}
          onClick={(event) => event.stopPropagation()}
        >
          <button className="close-button" onClick={() => setPanel("none")} aria-label="Close panel">×</button>
          {errorNotice}
          {panel === "menu" && <>
            <h2>Menu</h2>
            <div className="menu-index">
              <PanelButton onClick={() => setPanel("save")}>Save</PanelButton>
              <PanelButton onClick={() => { refreshSaves(); setPanel("load"); }}>Load</PanelButton>
              <PanelButton onClick={() => { void quickSave(); }}>Quick save (F5)</PanelButton>
              <PanelButton onClick={() => { void quickLoad(); }}>Quick load (F9)</PanelButton>
              <PanelButton onClick={() => { void resumeAutosave(); }}>Resume autosave</PanelButton>
              <PanelButton onClick={() => setPanel("settings")}>Settings</PanelButton>
              <PanelButton onClick={() => setPanel("gallery")}>CG Gallery</PanelButton>
              <PanelButton onClick={() => setPanel("music")}>Music Mode</PanelButton>
              <PanelButton onClick={() => setPanel("flowchart")}>Story Flowchart</PanelButton>
              <PanelButton onClick={() => { void runtime.returnToPreviousChoice().then((restored) => { if (restored) setPanel("none"); }); }}>Return to previous choice</PanelButton>
              <PanelButton onClick={exportCurrent}>Export current save</PanelButton>
              <PanelButton onClick={() => void document.documentElement.requestFullscreen?.()}>Fullscreen</PanelButton>
              <PanelButton className="menu-button-wide" onClick={() => { runtime.setMode("normal"); setPanel("none"); setStarted(false); }}>Return to title</PanelButton>
            </div>
          </>}
          {panel === "save" && <SavePanel saves={visibleSaves} onSave={saveCurrent} />}
          {panel === "load" && <LoadPanel saves={visibleSaves} onLoad={loadCurrent} onImport={() => importInput.current?.click()} />}
          {panel === "settings" && <>
            <h2>Settings</h2>
            <fieldset className="settings-group">
              <legend>Text</legend>
              <label className="setting-row">
                <span>Text speed</span>
                <span className="setting-control">
                  <input type="range" min="0" max="100" value={settings.textSpeed} onChange={(event) => setSettings({ ...settings, textSpeed: Number(event.target.value) })} />
                  <output>{settings.textSpeed}</output>
                </span>
              </label>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Sound</legend>
              <label className="setting-row">
                <span>Music volume</span>
                <span className="setting-control">
                  <input type="range" min="0" max="1" step="0.05" value={settings.musicVolume} onChange={(event) => setSettings({ ...settings, musicVolume: Number(event.target.value) })} />
                  <output>{Math.round(settings.musicVolume * 100)}%</output>
                </span>
              </label>
              <label className="setting-row">
                <span>Voice volume</span>
                <span className="setting-control">
                  <input type="range" min="0" max="1" step="0.05" value={settings.voiceVolume} onChange={(event) => setSettings({ ...settings, voiceVolume: Number(event.target.value) })} />
                  <output>{Math.round(settings.voiceVolume * 100)}%</output>
                </span>
              </label>
              <label className="setting-row">
                <span>Sound-effect volume</span>
                <span className="setting-control">
                  <input type="range" min="0" max="1" step="0.05" value={settings.effectVolume} onChange={(event) => setSettings({ ...settings, effectVolume: Number(event.target.value) })} />
                  <output>{Math.round(settings.effectVolume * 100)}%</output>
                </span>
              </label>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Window</legend>
              <label className="setting-row">
                <span>Message window opacity</span>
                <span className="setting-control">
                  <input type="range" min={windowOpacityRange.min} max={windowOpacityRange.max} step="0.02" value={settings.windowOpacity} onChange={(event) => setSettings({ ...settings, windowOpacity: Number(event.target.value) })} />
                  <output>{Math.round(settings.windowOpacity * 100)}%</output>
                </span>
              </label>
              <label className="setting-row checkbox-row">
                <span>Show date caption</span>
                <input type="checkbox" checked={settings.showDateCaption} onChange={(event) => setSettings({ ...settings, showDateCaption: event.target.checked })} />
              </label>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Saving</legend>
              <label className="setting-row checkbox-row">
                <span>Autosave</span>
                <input type="checkbox" checked={settings.autosave} onChange={(event) => setSettings({ ...settings, autosave: event.target.checked })} />
              </label>
              <p className="setting-note">Keeps one rolling snapshot as you read, so a closed tab resumes at the last line. It never overwrites a quick save or a numbered slot.</p>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Display</legend>
              <label className="setting-row">
                <span>Display mode</span>
                <select value={settings.displayMode} onChange={(event) => setSettings({ ...settings, displayMode: event.target.value as UserSettings["displayMode"] })}><option value="fit">Fit to window</option><option value="pixel">Pixel sharp</option></select>
              </label>
              <label className="setting-row checkbox-row">
                <span>Autoplay</span>
                <input type="checkbox" checked={settings.autoplay} onChange={(event) => { const autoplay = event.target.checked; setSettings({ ...settings, autoplay }); runtime.setMode("normal"); }} />
              </label>
              <label className="setting-row">
                <span>Auto-advance delay</span>
                <span className="setting-control">
                  <input type="range" min={autoAdvanceDelayRange.min} max={autoAdvanceDelayRange.max} step="50" value={settings.autoAdvanceDelayMs} disabled={!settings.autoplay} onChange={(event) => setSettings({ ...settings, autoAdvanceDelayMs: Number(event.target.value) })} />
                  <output>{(settings.autoAdvanceDelayMs / 1000).toFixed(2)}s</output>
                </span>
              </label>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Reading</legend>
              <div className="setting-actions">
                <PanelButton onClick={() => toggleSkip("skip")}>{runtime.mode === "skip" ? "Stop Skip All" : "Skip All Text"}</PanelButton>
                <PanelButton onClick={() => toggleSkip("skip-read")}>{runtime.mode === "skip-read" ? "Stop Skip Read" : "Skip Read Text Only"}</PanelButton>
              </div>
              <p className="setting-note">Skip All advances every line; Skip Read stops at text you have not read before.</p>
            </fieldset>
          </>}
          {panel === "backlog" && <>
            <h2>History</h2><div className="backlog">{state.backlog.length ? state.backlog.map((entry) => <p key={entry.id}><span><strong>{entry.speaker}</strong> {entry.text}</span>{entry.voice && <button aria-label="Replay voice" onClick={() => { const asset = manifest.assets[entry.voice!]; const audio = voiceRef.current; if (!asset || !audio) return; void playPackedAudio(audio, asset.url, settings.voiceVolume); }}>▶</button>}</p>) : <p>No history yet.</p>}</div>
          </>}
          {panel === "gallery" && <Gallery manifest={manifest} />}
          {panel === "music" && <MusicMode manifest={manifest} volume={settings.musicVolume} />}
          {diagnostics.length > 0 && <details className="diagnostics"><summary>Runtime diagnostics ({diagnostics.length})</summary>{diagnostics.map((item, index) => <pre key={index}>{JSON.stringify(item, null, 2)}</pre>)}</details>}
        </section>
      </div>}
      <audio ref={musicRef} hidden onTimeUpdate={(event) => runtime.setMusicPosition(event.currentTarget.currentTime * 1000)} />
      <audio ref={voiceRef} hidden />
      <input ref={importInput} type="file" accept="application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); event.currentTarget.value = ""; }} />
    </main>
  );
}

function SavePanel({ saves, onSave }: { saves: Array<SaveSlot | undefined>; onSave: (slot: number) => void }) {
  return <PagedSlots title="Save" saves={saves} render={(slot, slotNumber) => <button className="save-slot" onClick={() => onSave(slotNumber)}>{slot?.thumbnail ? <img className="save-thumbnail" src={slot.thumbnail} alt="" /> : <span className="save-thumbnail empty-thumbnail" /> }<strong>Slot {slotNumber}</strong><span>{slot?.title ?? "Empty"}</span><small>{slot ? new Date(slot.timestamp).toLocaleString() : ""}</small></button>} />;
}

function LoadPanel({ saves, onLoad, onImport }: { saves: Array<SaveSlot | undefined>; onLoad: (slot: SaveSlot) => void; onImport: () => void }) {
  return <><PagedSlots title="Load" saves={saves} render={(slot, slotNumber) => <button className="save-slot" disabled={!slot} onClick={() => slot && onLoad(slot)}>{slot?.thumbnail ? <img className="save-thumbnail" src={slot.thumbnail} alt="" /> : <span className="save-thumbnail empty-thumbnail" /> }<strong>Slot {slotNumber}</strong><span>{slot?.title ?? "Empty"}</span><small>{slot ? new Date(slot.timestamp).toLocaleString() : ""}</small></button>} /><button className="menu-button" onClick={onImport}>Import save JSON</button></>;
}

function PagedSlots({ title, saves, render }: { title: string; saves: Array<SaveSlot | undefined>; render: (slot: SaveSlot | undefined, slotNumber: number) => React.ReactNode }) {
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const pages = Math.ceil(saves.length / pageSize);
  const pageItems = saves.slice(page * pageSize, (page + 1) * pageSize);
  return <><h2>{title}</h2><div className="slot-pagination"><button aria-label="Previous page" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>←</button><span>Slots {page * pageSize + 1}–{Math.min((page + 1) * pageSize, saves.length)} of {saves.length}</span><button aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>→</button></div><div className="slot-grid">{pageItems.map((slot, index) => <div key={page * pageSize + index}>{render(slot, page * pageSize + index + 1)}</div>)}</div></>;
}

/**
 * Graphics gallery. AIR Standard Edition splits its 134 CGM entries into four
 * pages (`seen9035` walks `$6[400]` = 0..3 with `$6[401]` = page 0..1) and
 * gates each cell on the `1:4:1504` "seen" query. The percentage plate above
 * the grid is the same `1:4:1502` value the original prints.
 */
function Gallery({ manifest }: { manifest: GameManifest }) {
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  useEffect(() => { void listUnlockedAssets().then(setUnlocked).catch(() => setUnlocked([])); }, []);
  const categories = useMemo(() => galleryEntries(manifest, unlocked), [manifest, unlocked]);
  const total = categories.reduce((sum, category) => sum + category.entries.length, 0);
  const seen = categories.reduce((sum, category) => sum + category.unlockedCount, 0);
  const percent = galleryPercent(manifest, unlocked);
  const active = categories[Math.min(page, Math.max(0, categories.length - 1))];
  return <>
    <h2>Gallery</h2>
    <div className="gallery-progress">
      <span className="gallery-percent">{percent}<small>%</small></span>
      <span className="gallery-count">{seen} of {total} images seen</span>
    </div>
    {categories.length > 0 && (
      <nav className="gallery-pages" aria-label="Gallery pages">
        {categories.map((category, index) => (
          <button key={category.prefix} className={index === page ? "active" : ""} aria-pressed={index === page} onClick={() => setPage(index)}>
            {category.label}<small>{category.unlockedCount}/{category.entries.length}</small>
          </button>
        ))}
      </nav>
    )}
    {active && active.entries.some((entry) => entry.unlocked) ? (
      <div className="gallery-grid">
        {active.entries.map((entry) => entry.unlocked
          ? <PackedImage key={entry.id} asset={entry.asset} alt={entry.asset.source ?? entry.id} loading="lazy" />
          : <span key={entry.id} className="gallery-locked" aria-label="Not yet seen" />)}
      </div>
    ) : (
      <div className="gallery-empty">
        <div className="gallery-empty-sheet" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>
        <p>Images appear here once you have seen them in the story.</p>
      </div>
    )}
  </>;
}

/**
 * Music mode. `seen9036` enumerates 27 tracks (`BGM00`-`BGM26`) with a duration
 * column and stops playback through `1:20:105`; the same two commands drive
 * this panel. Tracks play through the shared packed-audio resolver.
 */
function MusicMode({ manifest, volume }: { manifest: GameManifest; volume: number }) {
  const [heard, setHeard] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>();
  const playerRef = useRef<HTMLAudioElement | undefined>(undefined);
  useEffect(() => { void listUnlockedAssets().then(setHeard).catch(() => setHeard([])); }, []);
  const tracks = useMemo(() => musicTracks(manifest, heard), [manifest, heard]);
  const stop = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      player.pause();
      player.removeAttribute("src");
    }
    playerRef.current = undefined;
    setCurrent(undefined);
  }, []);
  useEffect(() => () => {
    playerRef.current?.pause();
    playerRef.current?.removeAttribute("src");
  }, []);
  const play = (track: MusicTrack) => {
    if (current === track.id) { stop(); return; }
    stop();
    const player = new Audio();
    playerRef.current = player;
    player.loop = true;
    setCurrent(track.id);
    void playPackedAudio(player, track.asset.url, volume);
    void unlockAsset(track.id).catch(() => undefined);
  };
  return <>
    <h2>Music</h2>
    <p>{tracks.filter((track) => track.heard).length} of {tracks.length} tracks heard.</p>
    <div className="music-gallery">
      {tracks.map((track) => (
        <button key={track.id} className={current === track.id ? "playing" : ""} aria-pressed={current === track.id} onClick={() => play(track)}>
          <span title={track.asset.source ?? track.id}>{track.label}{!track.heard && <em className="track-unheard"> · unheard</em>}</span>
          <small>{formatDuration(track.asset.durationMs)}</small>
        </button>
      ))}
    </div>
  </>;
}



function Typewriter({ text, speed, revealed, onComplete }: { text: string; speed: number; revealed: boolean; onComplete: (text: string) => void }) {
  const [visible, setVisible] = useState("");
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  useEffect(() => {
    if (revealed || speed >= 100) {
      setVisible(text);
      if (!revealed) onCompleteRef.current(text);
      return;
    }
    let position = 0;
    setVisible("");
    const delay = Math.max(5, (100 - speed) * 0.35);
    const timer = window.setInterval(() => {
      position += 1;
      setVisible(text.slice(0, position));
      if (position >= text.length) {
        window.clearInterval(timer);
        onCompleteRef.current(text);
      }
    }, delay);
    return () => window.clearInterval(timer);
  }, [revealed, speed, text]);
  return <>{visible}</>;
}
