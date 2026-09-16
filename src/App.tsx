import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameStage } from "./components/GameStage";
import { FlowchartView } from "./components/FlowchartView";
import { loadManifest } from "./runtime/loadManifest";
import { AirRuntimeImpl } from "./runtime/airRuntime";
import { defaultSettings, exportSave, getLastActiveSlot, importSave, listReadTextIds, listSaveSlots, listUnlockedAssets, loadSettings, markTextRead, saveSettings, saveSlot, setLastActiveSlot, unlockAsset, type SaveSlot, type UserSettings } from "./runtime/storage";
import type { BacklogEntry, GameManifest, RuntimeDiagnostic, RuntimeEvent, RuntimeState } from "./types";
import "./styles.css";

type Panel = "none" | "menu" | "save" | "load" | "settings" | "backlog" | "gallery" | "flowchart";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Please try again.";

function PanelButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button className="menu-button" onClick={onClick}>{children}</button>;
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
  const [lastActiveSlot, setLastActiveSlotState] = useState<number | undefined>();
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [loadingError, setLoadingError] = useState<string>();
  const importInput = useRef<HTMLInputElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const voiceRef = useRef<HTMLAudioElement>(null);
  const effectPlayers = useRef(new Set<HTMLAudioElement>());
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
    if (!started || !state?.audio.music || !manifest) {
      audio.pause();
      audio.removeAttribute("src");
      return;
    }
    const asset = manifest.assets[state.audio.music];
    if (!asset) return;
    const nextSource = new URL(asset.url, window.location.href).href;
    if (audio.src !== nextSource) {
      audio.src = asset.url;
      try {
        audio.currentTime = (state.audio.musicPositionMs ?? 0) / 1000;
      } catch {
        // Ignore unready audio state
      }
    }
    audio.loop = state.audio.musicLoop ?? asset.loop ?? true;
    audio.volume = Math.max(0, Math.min(1, settings.musicVolume));
    void audio.play().catch(() => undefined);
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
    audio.src = asset.url;
    audio.loop = false;
    audio.volume = Math.max(0, Math.min(1, settings.voiceVolume));
    void audio.play().catch(() => undefined);
  }, [manifest, settings.voiceVolume, started, state?.audio.voice]);

  const lastEffectId = state?.audio.effects.at(-1);
  const effectCount = state?.audio.effects.length ?? 0;
  useEffect(() => {
    if (!started || !manifest) return;
    const asset = lastEffectId ? manifest.assets[lastEffectId] : undefined;
    if (!asset) return;
    const audio = new Audio(asset.url);
    effectPlayers.current.add(audio);
    audio.volume = Math.max(0, Math.min(1, settings.effectVolume));
    const cleanup = () => {
      effectPlayers.current.delete(audio);
      audio.removeEventListener("ended", cleanup);
      audio.removeEventListener("error", cleanup);
    };
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });
    void audio.play().catch(() => { cleanup(); });
  }, [effectCount, lastEffectId, manifest, settings.effectVolume, started]);

  useEffect(() => () => {
    for (const player of effectPlayers.current) {
      try {
        player.pause();
        player.src = "";
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
    const timer = window.setTimeout(() => { void runtime.advance(); }, 950);
    return () => window.clearTimeout(timer);
  }, [choice, panel, runtime, runtime?.mode, settings.autoplay, started, textRevealed, state?.sceneId, state?.instructionPointer, state?.waiting]);

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
    void runtime.advance();
  }, [choice, panel, runtime, started, state?.waiting]);

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

  useEffect(() => {
    if (!started || !runtime) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button, input, textarea, select, a, [contenteditable]:not([contenteditable='false']), [role='button']")) return;

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
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPanel((current) => (current === "none" ? "menu" : "none"));
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
  }, [advance, choice, panel, runtime, started]);

  const saveCurrent = useCallback(async (slot: number) => {
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
      await saveSlot({ version: 1, slot, title: text.slice(0, 80) || "AIR", timestamp: new Date().toISOString(), state: runtime.save(), thumbnail });
      setLastActiveSlotState(slot);
      refreshSaves();
      setPanel("none");
    } catch (failure) {
      setError(`Unable to save game: ${errorMessage(failure)}`);
    }
  }, [refreshSaves, runtime, text]);

  const loadCurrent = useCallback((slot: SaveSlot) => {
    if (!runtime) return;
    setError(undefined);
    try {
      const validated = importSave(exportSave(slot));
      runtime.setMode("normal");
      runtime.load(validated.state);
      void setLastActiveSlot(slot.slot).then(() => setLastActiveSlotState(slot.slot)).catch((failure: unknown) => setError(`Unable to remember save slot: ${errorMessage(failure)}`));
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

  const handleImport = async (file: File) => {
    setError(undefined);
    try {
      const parsed = importSave(await file.text());
      if (!manifest?.scenes[parsed.state.sceneId]) throw new Error("This save belongs to an unavailable scene.");
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

  const startGame = useCallback(() => {
    if (!runtime) return;
    runtime.startNewGame();
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
    void runtime.advance();
  }, [runtime]);

  const continueGame = useCallback(() => {
    const slot = saves.find((candidate) => candidate.slot === lastActiveSlot) ?? saves[0];
    if (!runtime || !slot) return startGame();
    loadCurrent(slot);
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

  const errorNotice = error && <div role="alert"><p>{error}</p><button onClick={() => setError(undefined)}>Dismiss error</button></div>;

  if (loadingError) return <main className="loading-screen"><div role="alert"><p>{loadingError}</p><button onClick={() => window.location.reload()}>Retry</button></div></main>;
  if (!manifest || !runtime || !state) return <main className="loading-screen">Loading AIR…</main>;

  if (!started) {
    const backgroundAsset = manifest.assetAliases?.S_TT_BG00 ? manifest.assets[manifest.assetAliases.S_TT_BG00] : undefined;
    const logoAsset = manifest.assetAliases?.AIRLOGO ? manifest.assets[manifest.assetAliases.AIRLOGO] : undefined;
    return (
      <main className="title-screen" style={backgroundAsset ? { backgroundImage: `linear-gradient(rgba(2,8,15,.08), rgba(2,8,15,.28)), url("${backgroundAsset.url}")` } : undefined}>
        <div className="title-card">
          {logoAsset ? <img className="title-logo-image" src={logoAsset.url} alt="AIR" /> : <div className="title-logo">AIR</div>}
          <p>Standard Edition</p>
          {errorNotice}
          <button className="title-button" onClick={startGame}>New Game</button>
          <button className="title-button" disabled={!saves.length} onClick={continueGame}>Continue</button>
          <button className="title-button" onClick={() => setPanel("flowchart")}>Story Flowchart</button>
          <small>Web port running on your local game data.</small>
        </div>
        {panel === "flowchart" && (
          <FlowchartView manifest={manifest} state={state} onJumpToScene={jumpToScene} onClose={() => setPanel("none")} />
        )}
      </main>
    );
  }

  return (
    <main className={`app-shell display-${settings.displayMode}`}>
      {panel === "none" && errorNotice}
      <header className="top-bar">
        <div><span className="brand-mark">AIR</span><span className="private-label">WEB PLAYER</span></div>
        <div className="top-actions">
          <button className={runtime.mode === "skip" ? "active" : ""} aria-pressed={runtime.mode === "skip"} onClick={() => toggleSkip("skip")}>Skip All</button>
          <button className={runtime.mode === "skip-read" ? "active" : ""} aria-pressed={runtime.mode === "skip-read"} onClick={() => toggleSkip("skip-read")}>Skip Read</button>
          <button onClick={() => setPanel("flowchart")}>Flowchart</button>
          <button onClick={() => setPanel("backlog")}>History</button>
          <button onClick={() => setPanel("menu")}>Menu</button>
        </div>
      </header>

      <section className="player" tabIndex={0}>
        <GameStage manifest={manifest} state={state} onClick={advance} />
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
      </section>

      <footer className="status-bar"><span>{manifest.title}</span><span>Scene: {state.sceneId}</span><span>Mode: {settings.autoplay && runtime.mode === "normal" ? "auto" : runtime.mode}</span></footer>

      {panel === "flowchart" && (
        <FlowchartView manifest={manifest} state={state} onJumpToScene={jumpToScene} onClose={() => setPanel("none")} />
      )}

      {panel !== "none" && panel !== "flowchart" && <div className="panel-backdrop" onClick={() => setPanel("none")}>
        <section className="panel" onClick={(event) => event.stopPropagation()}>
          <button className="close-button" onClick={() => setPanel("none")}>×</button>
          {errorNotice}
          {panel === "menu" && <>
            <h2>Menu</h2>
            <PanelButton onClick={() => setPanel("save")}>Save</PanelButton>
            <PanelButton onClick={() => { refreshSaves(); setPanel("load"); }}>Load</PanelButton>
            <PanelButton onClick={() => setPanel("flowchart")}>Story Flowchart</PanelButton>
            <PanelButton onClick={() => setPanel("settings")}>Settings</PanelButton>
            <PanelButton onClick={exportCurrent}>Export current save</PanelButton>
            <PanelButton onClick={() => setPanel("gallery")}>Gallery</PanelButton>
            <PanelButton onClick={() => { void runtime.returnToPreviousChoice().then((restored) => { if (restored) setPanel("none"); }); }}>Return to previous choice</PanelButton>
            <PanelButton onClick={() => void document.documentElement.requestFullscreen?.()}>Fullscreen</PanelButton>
            <PanelButton onClick={() => { runtime.setMode("normal"); setPanel("none"); setStarted(false); }}>Return to title</PanelButton>
          </>}
          {panel === "save" && <SavePanel saves={visibleSaves} onSave={saveCurrent} />}
          {panel === "load" && <LoadPanel saves={visibleSaves} onLoad={loadCurrent} onImport={() => importInput.current?.click()} />}
          {panel === "settings" && <>
            <h2>Settings</h2>
            <label>Text speed <input type="range" min="0" max="100" value={settings.textSpeed} onChange={(event) => setSettings({ ...settings, textSpeed: Number(event.target.value) })} /></label>
            <label>Music volume <input type="range" min="0" max="1" step="0.05" value={settings.musicVolume} onChange={(event) => setSettings({ ...settings, musicVolume: Number(event.target.value) })} /></label>
            <label>Voice volume <input type="range" min="0" max="1" step="0.05" value={settings.voiceVolume} onChange={(event) => setSettings({ ...settings, voiceVolume: Number(event.target.value) })} /></label>
            <label>Sound-effect volume <input type="range" min="0" max="1" step="0.05" value={settings.effectVolume} onChange={(event) => setSettings({ ...settings, effectVolume: Number(event.target.value) })} /></label>
            <label>Display mode <select value={settings.displayMode} onChange={(event) => setSettings({ ...settings, displayMode: event.target.value as UserSettings["displayMode"] })}><option value="fit">Fit to window</option><option value="pixel">Pixel sharp</option></select></label>
            <label className="checkbox-row"><input type="checkbox" checked={settings.autoplay} onChange={(event) => { const autoplay = event.target.checked; setSettings({ ...settings, autoplay }); runtime.setMode("normal"); }} /> Autoplay</label>
            <PanelButton onClick={() => toggleSkip("skip")}>{runtime.mode === "skip" ? "Stop Skip All" : "Skip All Text"}</PanelButton>
            <PanelButton onClick={() => toggleSkip("skip-read")}>{runtime.mode === "skip-read" ? "Stop Skip Read" : "Skip Read Text Only"}</PanelButton>
          </>}
          {panel === "backlog" && <>
            <h2>History</h2><div className="backlog">{state.backlog.length ? state.backlog.map((entry) => <p key={entry.id}><span><strong>{entry.speaker}</strong> {entry.text}</span>{entry.voice && <button aria-label="Replay voice" onClick={() => { const asset = manifest.assets[entry.voice!]; const audio = voiceRef.current; if (!asset || !audio) return; audio.src = asset.url; audio.volume = settings.voiceVolume; void audio.play().catch(() => undefined); }}>▶</button>}</p>) : <p>No history yet.</p>}</div>
          </>}
          {panel === "gallery" && <Gallery manifest={manifest} />}
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
  return <><h2>{title}</h2><div className="slot-pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>←</button><span>Slots {page * pageSize + 1}–{Math.min((page + 1) * pageSize, saves.length)} of {saves.length}</span><button disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>→</button></div><div className="slot-grid">{pageItems.map((slot, index) => <div key={page * pageSize + index}>{render(slot, page * pageSize + index + 1)}</div>)}</div></>;
}

function Gallery({ manifest }: { manifest: GameManifest }) {
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const playerRef = useRef<HTMLAudioElement | undefined>(undefined);
  useEffect(() => () => {
    playerRef.current?.pause();
    playerRef.current?.removeAttribute("src");
  }, []);
  useEffect(() => { void listUnlockedAssets().then(setUnlocked).catch(() => setUnlocked([])); }, []);
  const cgmAssets = new Set(manifest.galleryAssets ?? []);
  const images = Object.values(manifest.assets).filter((asset) => asset.kind === "image" && (!cgmAssets.size || cgmAssets.has(asset.id)));
  const audio = Object.values(manifest.assets).filter((asset) => asset.kind === "audio");
  const visibleImages = images.filter((asset) => unlocked.includes(asset.id));
  const visibleAudio = audio.filter((asset) => unlocked.includes(asset.id));
  const playTrack = (url: string) => {
    playerRef.current?.pause();
    playerRef.current?.removeAttribute("src");
    const player = new Audio(url);
    playerRef.current = player;
    player.volume = 0.8;
    void player.play().catch(() => undefined);
  };
  return <><h2>Gallery</h2><p>{visibleImages.length} visual assets and {visibleAudio.length} music tracks unlocked.</p>{visibleImages.length ? <div className="gallery-grid">{visibleImages.map((asset) => <img key={asset.id} src={asset.url} alt={asset.source ?? asset.id} loading="lazy" />)}</div> : <p>Play through an event to unlock its visual and audio gallery entries.</p>}{visibleAudio.length > 0 && <div className="music-gallery"><h3>Music</h3>{visibleAudio.map((asset) => <button key={asset.id} onClick={() => playTrack(asset.url)}><span>{asset.source ?? asset.id}</span><small>{asset.durationMs ? `${Math.round(asset.durationMs / 1000)}s` : "Audio"}</small></button>)}</div>}</>;
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
