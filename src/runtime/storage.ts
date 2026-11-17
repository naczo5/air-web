import type { RuntimeState } from "../types";

const DB_NAME = "air-se-web";
const DB_VERSION = 5;
const STORE = "saves";
const SETTINGS_STORE = "settings";
const UNLOCK_STORE = "unlocks";
const META_STORE = "meta";
const READ_STORE = "readText";

export type UserSettings = {
  textSpeed: number;
  volume: number;
  musicVolume: number;
  voiceVolume: number;
  effectVolume: number;
  autoplay: boolean;
  /** Delay between a fully revealed line and the next one in auto mode. */
  autoAdvanceDelayMs: number;
  displayMode: "fit" | "pixel";
  /** Opacity of the message window paper (GAMEEXE.INI `WINDOW_ATTR` alpha, 0-255). */
  windowOpacity: number;
  /** GAMEEXE.INI `SYSCOM.018 Date window` — "Display" / "Don't display". */
  showDateCaption: boolean;
  /**
   * Write a rolling snapshot as the player advances, so a closed tab or a
   * refresh resumes at the last line. Separate from the quick slot by design.
   */
  autosave: boolean;
};

export const defaultSettings: UserSettings = {
  textSpeed: 35,
  volume: 0.8,
  musicVolume: 0.8,
  voiceVolume: 0.8,
  effectVolume: 0.8,
  autoplay: false,
  autoAdvanceDelayMs: 950,
  displayMode: "fit",
  windowOpacity: 0.94,
  showDateCaption: true,
  autosave: true,
};

export const autoAdvanceDelayRange = { min: 300, max: 4000 } as const;
export const windowOpacityRange = { min: 0.4, max: 1 } as const;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Clamp stored or imported numbers into their documented ranges. */
export const normalizeSettings = (value: Partial<UserSettings>): UserSettings => {
  const merged = { ...defaultSettings, ...value };
  return {
    ...merged,
    textSpeed: clamp(Math.round(merged.textSpeed), 0, 100),
    musicVolume: clamp(merged.musicVolume, 0, 1),
    voiceVolume: clamp(merged.voiceVolume, 0, 1),
    effectVolume: clamp(merged.effectVolume, 0, 1),
    autoAdvanceDelayMs: clamp(Math.round(merged.autoAdvanceDelayMs), autoAdvanceDelayRange.min, autoAdvanceDelayRange.max),
    windowOpacity: clamp(merged.windowOpacity, windowOpacityRange.min, windowOpacityRange.max),
    showDateCaption: merged.showDateCaption !== false,
    autosave: merged.autosave !== false,
    displayMode: merged.displayMode === "pixel" ? "pixel" : "fit",
  };
};

export type SaveSlot = {
  version: 1;
  slot: number;
  title: string;
  timestamp: string;
  state: RuntimeState;
  thumbnail?: string;
};

const memoryStore = new Map<string, Map<string | number, unknown>>([
  [STORE, new Map()],
  [SETTINGS_STORE, new Map()],
  [UNLOCK_STORE, new Map()],
  [META_STORE, new Map()],
  [READ_STORE, new Map()],
]);

let idbSupported: boolean | undefined = undefined;

const openDb = (): Promise<IDBDatabase | undefined> =>
  new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || idbSupported === false) {
      resolve(undefined);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        idbSupported = false;
        resolve(undefined);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "slot" });
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(UNLOCK_STORE)) db.createObjectStore(UNLOCK_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(READ_STORE)) db.createObjectStore(READ_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        idbSupported = true;
        resolve(request.result);
      };
    } catch {
      idbSupported = false;
      resolve(undefined);
    }
  });

export const saveSlot = async (slot: SaveSlot): Promise<void> => {
  const db = await openDb();
  if (!db) {
    memoryStore.get(STORE)?.set(slot.slot, structuredClone(slot));
    await setLastActiveSlot(slot.slot);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(slot);
    tx.onerror = () => reject(tx.error ?? new Error("Unable to save"));
    tx.oncomplete = () => resolve();
  });
  db.close();
  await setLastActiveSlot(slot.slot);
};

export const listSaveSlots = async (): Promise<SaveSlot[]> => {
  const db = await openDb();
  if (!db) {
    const list = Array.from(memoryStore.get(STORE)?.values() ?? []) as SaveSlot[];
    return list.sort((a, b) => a.slot - b.slot);
  }
  const values = await new Promise<SaveSlot[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onerror = () => reject(request.error ?? new Error("Unable to list saves"));
    request.onsuccess = () => resolve(request.result as SaveSlot[]);
  });
  db.close();
  return values.sort((a, b) => a.slot - b.slot);
};

export const getLastActiveSlot = async (): Promise<number | undefined> => {
  const db = await openDb();
  if (!db) {
    return memoryStore.get(META_STORE)?.get("lastActiveSlot") as number | undefined;
  }
  const value = await new Promise<{ id: string; value: number } | undefined>((resolve, reject) => {
    const request = db.transaction(META_STORE, "readonly").objectStore(META_STORE).get("lastActiveSlot");
    request.onerror = () => reject(request.error ?? new Error("Unable to load last active slot"));
    request.onsuccess = () => resolve(request.result as { id: string; value: number } | undefined);
  });
  db.close();
  return value?.value;
};

export const setLastActiveSlot = async (slot: number): Promise<void> => {
  const db = await openDb();
  if (!db) {
    memoryStore.get(META_STORE)?.set("lastActiveSlot", slot);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ id: "lastActiveSlot", value: slot });
    tx.onerror = () => reject(tx.error ?? new Error("Unable to save last active slot"));
    tx.oncomplete = () => resolve();
  });
  db.close();
};

export const loadSettings = async (): Promise<UserSettings> => {
  const db = await openDb();
  let saved: Partial<UserSettings> | undefined = undefined;
  if (!db) {
    saved = memoryStore.get(SETTINGS_STORE)?.get("global") as Partial<UserSettings> | undefined;
  } else {
    const value = await new Promise<{ id: string; value: UserSettings } | undefined>((resolve, reject) => {
      const request = db.transaction(SETTINGS_STORE, "readonly").objectStore(SETTINGS_STORE).get("global");
      request.onerror = () => reject(request.error ?? new Error("Unable to load settings"));
      request.onsuccess = () => resolve(request.result as { id: string; value: UserSettings } | undefined);
    });
    db.close();
    saved = value?.value;
  }
  const legacyVolume = saved?.volume ?? defaultSettings.volume;
  return normalizeSettings({
    ...defaultSettings,
    ...(saved ?? {}),
    musicVolume: saved?.musicVolume ?? legacyVolume,
    voiceVolume: saved?.voiceVolume ?? legacyVolume,
    effectVolume: saved?.effectVolume ?? legacyVolume,
  });
};

export const saveSettings = async (value: UserSettings): Promise<void> => {
  const db = await openDb();
  if (!db) {
    memoryStore.get(SETTINGS_STORE)?.set("global", structuredClone(value));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    tx.objectStore(SETTINGS_STORE).put({ id: "global", value });
    tx.onerror = () => reject(tx.error ?? new Error("Unable to save settings"));
    tx.oncomplete = () => resolve();
  });
  db.close();
};

export const unlockAsset = async (id: string): Promise<void> => {
  const db = await openDb();
  if (!db) {
    memoryStore.get(UNLOCK_STORE)?.set(id, { id, unlockedAt: new Date().toISOString() });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(UNLOCK_STORE, "readwrite");
    tx.objectStore(UNLOCK_STORE).put({ id, unlockedAt: new Date().toISOString() });
    tx.onerror = () => reject(tx.error ?? new Error("Unable to unlock gallery asset"));
    tx.oncomplete = () => resolve();
  });
  db.close();
};

export const listUnlockedAssets = async (): Promise<string[]> => {
  const db = await openDb();
  if (!db) {
    return Array.from(memoryStore.get(UNLOCK_STORE)?.keys() ?? []).map(String);
  }
  const values = await new Promise<Array<{ id: string }>>((resolve, reject) => {
    const request = db.transaction(UNLOCK_STORE, "readonly").objectStore(UNLOCK_STORE).getAll();
    request.onerror = () => reject(request.error ?? new Error("Unable to list gallery unlocks"));
    request.onsuccess = () => resolve(request.result as Array<{ id: string }>);
  });
  db.close();
  return values.map((value) => value.id);
};

export const markTextRead = async (id: string): Promise<void> => {
  const db = await openDb();
  if (!db) {
    memoryStore.get(READ_STORE)?.set(id, { id });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(READ_STORE, "readwrite");
    tx.objectStore(READ_STORE).put({ id });
    tx.onerror = () => reject(tx.error ?? new Error("Unable to record read text"));
    tx.oncomplete = () => resolve();
  });
  db.close();
};

export const listReadTextIds = async (): Promise<string[]> => {
  const db = await openDb();
  if (!db) {
    return Array.from(memoryStore.get(READ_STORE)?.keys() ?? []).map(String);
  }
  const values = await new Promise<Array<{ id: string }>>((resolve, reject) => {
    const request = db.transaction(READ_STORE, "readonly").objectStore(READ_STORE).getAll();
    request.onerror = () => reject(request.error ?? new Error("Unable to load read text"));
    request.onsuccess = () => resolve(request.result as Array<{ id: string }>);
  });
  db.close();
  return values.map((value) => value.id);
};

export const exportSave = (slot: SaveSlot): string => JSON.stringify(slot, null, 2);

const QUICK_KEY = "quickSave";
const AUTOSAVE_KEY = "autosave";

/** One rolling snapshot store, used by both quick save and autosave. */
async function writeMetaSnapshot(key: string, slot: SaveSlot, label: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memoryStore.get(META_STORE)?.set(key, structuredClone(slot));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ id: key, value: slot });
    tx.onerror = () => reject(tx.error ?? new Error(`Unable to ${label}`));
    tx.oncomplete = () => resolve();
  });
  db.close();
}

async function readMetaSnapshot(key: string, label: string): Promise<SaveSlot | undefined> {
  const db = await openDb();
  if (!db) return memoryStore.get(META_STORE)?.get(key) as SaveSlot | undefined;
  const value = await new Promise<{ id: string; value: SaveSlot } | undefined>((resolve, reject) => {
    const request = db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key);
    request.onerror = () => reject(request.error ?? new Error(`Unable to read ${label}`));
    request.onsuccess = () => resolve(request.result as { id: string; value: SaveSlot } | undefined);
  });
  db.close();
  return value?.value;
}

/**
 * Quick save/load. The original engine's right-click menu offers Save/Load
 * without a slot picker; this stores a single rolling snapshot outside the
 * numbered slot grid so it never overwrites a deliberate save.
 */
export const saveQuickSlot = async (slot: SaveSlot): Promise<void> => {
  await writeMetaSnapshot(QUICK_KEY, slot, "quick save");
};

export const loadQuickSlot = async (): Promise<SaveSlot | undefined> => {
  const stored = await readMetaSnapshot(QUICK_KEY, "quick save");
  if (!stored) return undefined;
  // Re-validate so a stale or hand-edited snapshot cannot crash the UI. Quick
  // slots are numbered 0, which the numbered-slot validator deliberately
  // rejects, so validate a copy and restore the marker afterwards.
  const validated = importSave(JSON.stringify({ ...stored, slot: 1 }));
  return { ...validated, slot: 0 };
};

/**
 * Autosave: a single rolling snapshot written as the player advances.
 *
 * Deliberately a *separate* key from the quick slot. The quick save is a
 * deliberate action the player may rely on; an autosave that overwrote it would
 * silently destroy that. Keeping them apart also means a long session can be
 * resumed from the last line without ever having pressed F5.
 *
 * Autosave is silent by design — it never surfaces an error toast, because a
 * quota failure mid-scene must not interrupt reading.
 */
export const saveAutosave = async (slot: SaveSlot, options: { silent?: boolean } = {}): Promise<boolean> => {
  try {
    await writeMetaSnapshot(AUTOSAVE_KEY, { ...slot, slot: 0 }, "autosave");
    return true;
  } catch {
    if (!options.silent) throw new Error("Unable to autosave");
    return false;
  }
};

export const loadAutosave = async (): Promise<SaveSlot | undefined> => {
  const stored = await readMetaSnapshot(AUTOSAVE_KEY, "autosave");
  if (!stored) return undefined;
  const validated = importSave(JSON.stringify({ ...stored, slot: 1 }));
  return { ...validated, slot: 0 };
};

/** Exported for the settings toggle: is there an autosave to continue from? */
/**
 * Is there an autosave that can actually be resumed?
 *
 * Validates, because a stored-but-unreadable snapshot must not light up
 * "Continue": clicking it would silently start a new game, which looks like the
 * autosave was ignored rather than corrupt.
 */
export const hasAutosave = async (): Promise<boolean> => {
  try {
    const stored = await readMetaSnapshot(AUTOSAVE_KEY, "autosave");
    if (!stored) return false;
    importSave(JSON.stringify({ ...stored, slot: 1 }));
    return true;
  } catch {
    return false;
  }
};

/**
 * Validate a snapshot that has already been read from storage and does not
 * carry a numbered slot (the quick slot is 0). Callers holding a `SaveSlot`
 * use this instead of round-tripping through the numbered-slot validator,
 * which would reject it and undo the check above.
 */
export const validateQuickSlot = (slot: SaveSlot): SaveSlot => {
  const validated = importSave(JSON.stringify({ ...slot, slot: 1 }));
  return { ...validated, slot: 0 };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isIndex = (value: unknown): value is number => isNumber(value) && Number.isInteger(value) && value >= 0;
const isArrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const isMapOf = (value: unknown, check: (item: unknown) => boolean): boolean => isRecord(value) && Object.values(value).every(check);
const optional = (value: unknown, check: (item: unknown) => boolean): boolean => value === undefined || check(value);

/**
 * Scene ids are opaque but always come from the packed manifest, so a narrow
 * charset is enough. Prototype keys are rejected explicitly: they pass a
 * charset test but would also resolve through a naive object lookup.
 */
const SCENE_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);
const isSceneId = (value: unknown): boolean =>
  isString(value) && SCENE_ID_RE.test(value) && !RESERVED_KEYS.has(value);

/**
 * Imported thumbnails are rendered straight into `<img src>`. Accept only a
 * bounded inline image so a save cannot beacon to a third-party origin. A
 * real 640x480 canvas-to-PNG thumbnail measures ~570 KB of base64, so the cap
 * is generous while still bounding what a crafted save can carry.
 */
const THUMBNAIL_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const isThumbnail = (value: unknown): boolean =>
  isString(value) && value.length <= 4_000_000 && THUMBNAIL_RE.test(value);

/**
 * Object graphics and labels come from the bytecode, but a hand-edited save is
 * still a source of both: an `asset` is only ever looked up in the manifest it
 * was packed against, and `text` is never rendered, so the check is about
 * shapes and bounds rather than sanitising markup.
 */
/**
 * Manifest asset ids are short opaque strings. Bounding them keeps a crafted
 * save from carrying megabytes of junk into the runtime, where the value is only
 * ever used as an object key.
 */
const isAssetId = (value: unknown): boolean =>
  isString(value) && value.length > 0 && value.length <= 512;

const isSavedObject = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const fill = value.fill;
  return optional(value.asset, isAssetId)
    && isNumber(value.x) && isNumber(value.y)
    && optional(value.width, isNumber) && optional(value.height, isNumber)
    && typeof value.visible === "boolean"
    && isNumber(value.alpha) && value.alpha >= 0 && value.alpha <= 1
    && optional(value.text, isString)
    && optional(value.animState, isNumber)
    && optional(value.fromFile, (item) => typeof item === "boolean")
    && (fill === undefined || (isRecord(fill) && isNumber(fill.r) && isNumber(fill.g) && isNumber(fill.b)));
};

const isSavedState = (value: unknown, checkpoint = false): boolean => {
  if (!isRecord(value)) return false;
  const audio = value.audio;
  const choice = value.pendingChoice;
  return isSceneId(value.sceneId) && isIndex(value.instructionPointer)
    && isArrayOf(value.layers, (layer) => isRecord(layer) && optional(layer.asset, isString) && isNumber(layer.x) && isNumber(layer.y) && isNumber(layer.alpha))
    && optional(value.objects, (item) => isMapOf(item, isSavedObject))
    && isRecord(audio) && isArrayOf(audio.effects, isString)
    && optional(audio.music, isString) && optional(audio.voice, isString)
    && optional(audio.musicLoop, (item) => typeof item === "boolean")
    && optional(audio.musicPositionMs, isNumber) && optional(audio.musicFadeMs, isNumber)
    && isArrayOf(value.backlog, (entry) => isRecord(entry) && isString(entry.id) && isString(entry.sceneId) && isString(entry.text) && optional(entry.speaker, isString) && optional(entry.voice, isString))
    && isArrayOf(value.callStack, (frame) => isRecord(frame) && isString(frame.sceneId) && isIndex(frame.instructionPointer))
    && isMapOf(value.variables, (item) => isString(item) || isNumber(item))
    && isMapOf(value.flags, (item) => typeof item === "boolean" || isNumber(item))
    && optional(value.integerMemory, (item) => isMapOf(item, isNumber))
    && optional(value.stringMemory, (item) => isMapOf(item, isString))
    && optional(value.graphicsBuffers, (item) => isMapOf(item, isString))
    && optional(value.viewedAssets, (item) => isArrayOf(item, isString))
    && optional(value.textBuffer, isString) && optional(value.storeRegister, isNumber)
    && (checkpoint ? value.selectionHistory === undefined : optional(value.selectionHistory, (item) => isArrayOf(item, (entry) => isSavedState(entry, true))))
    && optional(value.waiting, (item) => ["text", "choice", "timer", "end"].includes(item as string))
    && (choice === undefined ? value.waiting !== "choice" : isRecord(choice)
      && isArrayOf(choice.options, isString)
      && optional(choice.targets, (item) => isArrayOf(item, isIndex))
      && optional(choice.storeValues, (item) => isArrayOf(item, isNumber)));
};

export const importSave = (raw: string): SaveSlot => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)
    || parsed.version !== 1
    || !isIndex(parsed.slot) || parsed.slot < 1 || parsed.slot > 100
    || !isString(parsed.title)
    || !isString(parsed.timestamp) || !Number.isFinite(Date.parse(parsed.timestamp))
    || !optional(parsed.thumbnail, isThumbnail)
    || !isSavedState(parsed.state)
  ) {
    throw new Error("Unsupported or invalid AIR save file");
  }
  return parsed as SaveSlot;
};
