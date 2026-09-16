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
  displayMode: "fit" | "pixel";
};

export const defaultSettings: UserSettings = {
  textSpeed: 35,
  volume: 0.8,
  musicVolume: 0.8,
  voiceVolume: 0.8,
  effectVolume: 0.8,
  autoplay: false,
  displayMode: "fit",
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
  return {
    ...defaultSettings,
    ...(saved ?? {}),
    musicVolume: saved?.musicVolume ?? legacyVolume,
    voiceVolume: saved?.voiceVolume ?? legacyVolume,
    effectVolume: saved?.effectVolume ?? legacyVolume,
  };
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isIndex = (value: unknown): value is number => isNumber(value) && Number.isInteger(value) && value >= 0;
const isArrayOf = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const isMapOf = (value: unknown, check: (item: unknown) => boolean): boolean => isRecord(value) && Object.values(value).every(check);
const optional = (value: unknown, check: (item: unknown) => boolean): boolean => value === undefined || check(value);

const isSavedState = (value: unknown, checkpoint = false): boolean => {
  if (!isRecord(value)) return false;
  const audio = value.audio;
  const choice = value.pendingChoice;
  return isString(value.sceneId) && value.sceneId.length > 0 && isIndex(value.instructionPointer)
    && isArrayOf(value.layers, (layer) => isRecord(layer) && optional(layer.asset, isString) && isNumber(layer.x) && isNumber(layer.y) && isNumber(layer.alpha))
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
    || !optional(parsed.thumbnail, isString)
    || !isSavedState(parsed.state)
  ) {
    throw new Error("Unsupported or invalid AIR save file");
  }
  return parsed as SaveSlot;
};
