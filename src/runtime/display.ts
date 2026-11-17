/**
 * Stage composition rules for AIR's graphics commands.
 *
 * Air's `GrpOpen` family (`1:33:*`, and the composite `1:40:100`) takes
 * character slot numbers, not pixel coordinates. The offsets live in
 * `GAMEEXE.INI` as `HAIKEICHR_PARAM.NNN` (x offset, y offset in thousandths of
 * a pixel):
 *
 *   HAIKEICHR_PARAM.004=-150    HAIKEICHR_PARAM.005=150
 *   HAIKEICHR_PARAM.061=000     HAIKEICHR_PARAM.062=-130
 *   HAIKEICHR_PARAM.063=130     HAIKEICHR_PARAM.065=140
 *   HAIKEICHR_PARAM.066=-160    HAIKEICHR_PARAM.067=170
 *   HAIKEICHR_PARAM.068=-50     HAIKEICHR_PARAM.069=50
 *   HAIKEICHR_PARAM.070=020
 *
 * The numbers are stored here rather than parsed at runtime because a built
 * deployment ships a manifest, not the original INI. Keep this table in sync
 * with `tools/air/formats.ts` `parseGameIni` consumers.
 */

import type { LayerState, StageObject } from "../types";

/** Slot number -> horizontal offset in logical pixels. */
export const CHAR_SLOT_OFFSETS: Readonly<Record<number, number>> = {
  4: -150,
  5: 150,
  61: 0,
  62: -130,
  63: 130,
  64: 0,
  65: 140,
  66: -160,
  67: 170,
  68: -50,
  69: 50,
  70: 20,
};

export const blankLayer = (): LayerState => ({ x: 0, y: 0, alpha: 1 });

/**
 * Horizontal offset for a character slot. Unknown slots fall back to 0, which
 * centres the sprite exactly as the engine does for slot 61 and 0-3.
 */
export function charSlotOffset(slot: number | undefined): number {
  if (slot === undefined) return 0;
  return CHAR_SLOT_OFFSETS[slot] ?? 0;
}

/**
 * Offsets for a list of sprites. When the scene does not name a slot the
 * engine falls back to the `HAIKEICHR_PARAM.004/.005` pair for two characters
 * and a -160/0/160 fan for three, which is preserved here.
 */
export function spriteOffsets(slots: Array<number | undefined>): number[] {
  if (!slots.length) return [];
  if (slots.every((slot) => slot !== undefined)) return slots.map((slot) => charSlotOffset(slot));
  if (slots.length === 2) {
    return slots.map((slot, index) => (slot === undefined ? (index === 0 ? -150 : 150) : charSlotOffset(slot)));
  }
  if (slots.length === 3) {
    const fan = [-160, 0, 160];
    return slots.map((slot, index) => (slot === undefined ? fan[index] : charSlotOffset(slot)));
  }
  return slots.map((slot) => charSlotOffset(slot));
}

export type StageSprite = { asset: string; slot?: number };

/**
 * Compose the layer stack the way the engine's renderer does: layer 0 is the
 * background, layers 1..n hold character sprites, and any remaining layers are
 * cleared. Passing `background: undefined` keeps the existing background.
 */
export function composeStage(
  current: readonly LayerState[],
  background: string | undefined,
  sprites: readonly StageSprite[],
  minimumLayers = 8,
): LayerState[] {
  const size = Math.max(minimumLayers, current.length, sprites.length + 1);
  const base = current[0] ?? blankLayer();
  const next: LayerState[] = Array.from({ length: size }, blankLayer);
  next[0] = background ? { asset: background, x: 0, y: 0, alpha: 1 } : { ...base };
  const offsets = spriteOffsets(sprites.map((sprite) => sprite.slot));
  sprites.slice(0, size - 1).forEach((sprite, index) => {
    next[index + 1] = { asset: sprite.asset, x: offsets[index] ?? 0, y: 0, alpha: 1 };
  });
  return next;
}

/**
 * Buffers 0-3 hold the background stack in AIR's scenes; the composite
 * `1:33:70 (name, slot)` only affects the canvas for those slots. Higher slots
 * (30+, 50+) are UI plates and CGs that are opened explicitly by `1:33:72`.
 */
export function bufferIsBackground(slot: number): boolean {
  return slot <= 3;
}
/**
 * True when a graphics buffer name looks like a full-screen backdrop, used to
 * decide whether opening a buffer should replace layer 0.
 */
export function looksLikeBackdrop(name: string): boolean {
  return /^(?:BG|DAY_|KURO|SIRO|FGM|OP_|MSG_|CG)/i.test(name);
}

/* ------------------------------------------------------------------ *
 * RealLive object layer
 *
 * Objects are a separate, ordered table in front of the graphics-buffer
 * stack. `1:60:1` enables a slot, `1:72:1000` gives it a graphic and
 * `1:82:1000` places it; the engine draws every enabled slot after the
 * scene has been composited. See `StageObject` for the field meanings.
 * ------------------------------------------------------------------ */

/** Object id of the date plate: `1:72:1000(83, $18[1003], 1)`. */
export const DATE_PLATE_OBJECT = 83;

/** The two message-window bars, `1:72:1101(81|82, 0, 0|430, 640, 50, 1)`. */
export const WINDOW_BAR_OBJECTS: readonly number[] = [81, 82];

/** A freshly enabled object: hidden until `1:82:1004`/`1:81:1004` says otherwise. */
export const blankObject = (): StageObject => ({ x: 0, y: 0, visible: false, alpha: 1 });

/**
 * Draw order. Object ids are not z-ordered in the engine — the table is a
 * flat layer with last-writer-wins per id — so the port renders by id, which
 * keeps the date plate above the window bars and both above the menu slots.
 * The bars are 81/82 and the plate 83, so ascending ids give exactly that.
 */
export function objectDrawOrder(objects: Readonly<Record<string, StageObject>>): Array<{ id: number; object: StageObject }> {
  return Object.entries(objects)
    .map(([key, object]) => ({ id: Number(key), object }))
    .filter((entry) => Number.isInteger(entry.id) && entry.object.visible)
    .sort((left, right) => left.id - right.id);
}

/**
 * Alpha of a `1:82:1016 (id, r, g, b, a)` call. AIR passes 0-255 in the real
 * data; a value of 1 or less is treated as already-normalised so a save
 * written by an older build still renders.
 */
export function colourAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const alpha = value > 1 ? value / 255 : value;
  return Math.min(1, Math.max(0, alpha));
}

export type ObjectDrawOptions = {
  /** `settings.showDateCaption` — GAMEEXE.INI `SYSCOM.018 Date window`. */
  showDateCaption?: boolean;
};

/**
 * The objects the canvas should paint, in draw order.
 *
 * Three deliberate exclusions:
 *
 * - `fromFile` slots (`1:71:1000`/`1:71:1300`, the 1280x164 OP strips and the
 *   `S_LEAF` overlays) are skipped because their motion comes from `1:81:1006`
 *   tweens and `1:4:600/610` timers, which this port does not implement. A
 *   frozen frame at (0,0) would be worse than nothing.
 * - The 81/82 message-window bars are skipped: they are opaque black 640x50
 *   bands, and the port already renders the message window as a DOM sheet
 *   (`.dialogue`). Drawing both would stack a black bar behind the paper box.
 * - Object 83, the date plate, is skipped when the user turned the date
 *   caption off, so the setting governs the drawn badge.
 */
export function stageObjects(
  objects: Readonly<Record<string, StageObject>>,
  options: ObjectDrawOptions = {},
): Array<{ id: number; object: StageObject }> {
  return objectDrawOrder(objects).filter(({ id, object }) => {
    if (object.fromFile) return false;
    if (WINDOW_BAR_OBJECTS.includes(id)) return false;
    if (id === DATE_PLATE_OBJECT && options.showDateCaption === false) return false;
    return Boolean(object.asset) || Boolean(object.fill);
  });
}

/**
 * Whether a given object will reach the canvas, and its graphic if so. `App`
 * uses this for object 83 so the date can be announced from the plate the
 * engine actually drew rather than from scene metadata.
 */
export function drawnObject(
  objects: Readonly<Record<string, StageObject>> | undefined,
  id: number,
  options: ObjectDrawOptions = {},
): StageObject | undefined {
  if (!objects) return undefined;
  return stageObjects(objects, options).find((entry) => entry.id === id)?.object;
}

/** True when the object is on the canvas. See `drawnObject`. */
export function objectOnStage(
  objects: Readonly<Record<string, StageObject>> | undefined,
  id: number,
  options: ObjectDrawOptions = {},
): boolean {
  return drawnObject(objects, id, options) !== undefined;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * Month and day a date plate actually depicts, read from its resource name
 * (`SDT0717` -> July 17, `SDT0801` -> August 1). The plate is the ground truth:
 * the script builds this name from `$5[3]`/`$5[4]` and draws it, so a label
 * derived from the asset can never disagree with the picture on screen.
 * Returns undefined for anything that is not a date plate.
 */
export function datePlateLabel(asset: string | undefined): string | undefined {
  const match = asset && /SDT(\d{2})(\d{2})/.exec(asset);
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const name = MONTHS[month - 1];
  if (!name || day < 1 || day > 31) return undefined;
  return `${name} ${day}`;
}

