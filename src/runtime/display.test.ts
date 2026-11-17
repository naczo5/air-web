import { describe, expect, it } from "vitest";
import {
  CHAR_SLOT_OFFSETS,
  DATE_PLATE_OBJECT,
  blankObject,
  charSlotOffset,
  colourAlpha,
  composeStage,
  datePlateLabel,
  drawnObject,
  objectDrawOrder,
  objectOnStage,
  spriteOffsets,
  stageObjects,
} from "./display";
import type { LayerState, StageObject } from "../types";

const blank = (): LayerState => ({ x: 0, y: 0, alpha: 1 });

describe("character slot offsets", () => {
  it("matches GAMEEXE.INI HAIKEICHR_PARAM for the slots AIR actually uses", () => {
    // Values quoted from AIR_SE/GAMEEXE.INI.
    expect(charSlotOffset(4)).toBe(-150);
    expect(charSlotOffset(5)).toBe(150);
    expect(charSlotOffset(61)).toBe(0);
    expect(charSlotOffset(62)).toBe(-130);
    expect(charSlotOffset(63)).toBe(130);
    expect(charSlotOffset(65)).toBe(140);
    expect(charSlotOffset(66)).toBe(-160);
    expect(charSlotOffset(67)).toBe(170);
    expect(charSlotOffset(68)).toBe(-50);
    expect(charSlotOffset(69)).toBe(50);
    expect(charSlotOffset(70)).toBe(20);
  });

  it("has no negative slots and centres unknown or absent slots", () => {
    for (const key of Object.keys(CHAR_SLOT_OFFSETS)) expect(Number(key)).toBeGreaterThanOrEqual(0);
    expect(charSlotOffset(undefined)).toBe(0);
    expect(charSlotOffset(999)).toBe(0);
  });

  it("keeps a two-character pair apart and prefers named slots", () => {
    expect(spriteOffsets([62, 63])).toEqual([-130, 130]);
    expect(spriteOffsets([61, 70])).toEqual([0, 20]);
    // Unknown slots fall back to the -150/+150 pair from HAIKEICHR_PARAM.004/.005.
    expect(spriteOffsets([undefined, undefined])).toEqual([-150, 150]);
  });
});

describe("stage composition", () => {
  it("puts the backdrop on layer 0 and sprites above it", () => {
    const layers = composeStage([], "image:bg", [{ asset: "image:cg", slot: 61 }]);
    expect(layers[0]).toEqual({ asset: "image:bg", x: 0, y: 0, alpha: 1 });
    expect(layers[1]).toEqual({ asset: "image:cg", x: 0, y: 0, alpha: 1 });
    expect(layers.slice(2).every((layer) => layer.asset === undefined)).toBe(true);
    expect(layers).toHaveLength(8);
  });

  it("keeps the existing backdrop when no new one is supplied", () => {
    const current = [{ asset: "image:bg", x: 0, y: 0, alpha: 1 }, ...Array.from({ length: 7 }, blank)];
    const layers = composeStage(current, undefined, [{ asset: "image:cg", slot: 62 }, { asset: "image:cg2", slot: 63 }]);
    expect(layers[0].asset).toBe("image:bg");
    expect(layers[1]).toMatchObject({ asset: "image:cg", x: -130 });
    expect(layers[2]).toMatchObject({ asset: "image:cg2", x: 130 });
  });

  it("clears stale sprites when a new backdrop is drawn alone", () => {
    const current = [
      { asset: "image:bg", x: 0, y: 0, alpha: 1 },
      { asset: "image:old", x: 0, y: 0, alpha: 1 },
      ...Array.from({ length: 6 }, blank),
    ];
    const layers = composeStage(current, "image:bg2", []);
    expect(layers[0].asset).toBe("image:bg2");
    expect(layers.slice(1).every((layer) => layer.asset === undefined)).toBe(true);
  });

  it("never drops existing layers when more than eight are already present", () => {
    const current = Array.from({ length: 10 }, blank);
    expect(composeStage(current, "image:bg", []).length).toBe(10);
  });
});

/**
 * The object table is AIR's second display stack: `1:60`-`1:62`, `1:71`,
 * `1:72`, `1:81` and `1:82` maintain it, and it composites over the scene.
 * Object 83 is the date plate; 81/82 are the message-window bars.
 */
describe("object layer", () => {
  const plate = (overrides: Partial<StageObject> = {}): StageObject => ({
    asset: "image:G00_SDT0717.g00", x: 16, y: 16, visible: true, alpha: 1, ...overrides,
  });

  it("starts hidden so a stray position/rect call cannot draw an empty slot", () => {
    expect(blankObject()).toEqual({ x: 0, y: 0, visible: false, alpha: 1 });
  });

  it("orders by object id and drops hidden slots", () => {
    const objects = {
      83: plate(),
      20: { ...blankObject(), visible: true, asset: "image:btn" },
      81: { ...blankObject(), visible: true, fill: { r: 0, g: 0, b: 0 } },
      30: plate({ visible: false }),
    };
    expect(objectDrawOrder(objects).map((entry) => entry.id)).toEqual([20, 81, 83]);
  });

  it("puts the date plate on the canvas at its own position and size", () => {
    const drawn = stageObjects({ 83: plate() });
    expect(drawn).toHaveLength(1);
    expect(drawn[0].object).toMatchObject({ asset: "image:G00_SDT0717.g00", x: 16, y: 16 });
    // No width/height recorded: the canvas falls back to the graphic's 150x154.
    expect(drawn[0].object.width).toBeUndefined();
    expect(drawn[0].object.height).toBeUndefined();
  });

  it("honours showDateCaption for the drawn plate", () => {
    expect(stageObjects({ 83: plate() }, { showDateCaption: true })).toHaveLength(1);
    expect(stageObjects({ 83: plate() }, { showDateCaption: false })).toEqual([]);
    expect(objectOnStage({ 83: plate() }, DATE_PLATE_OBJECT)).toBe(true);
    expect(objectOnStage({ 83: plate() }, DATE_PLATE_OBJECT, { showDateCaption: false })).toBe(false);
    expect(objectOnStage(undefined, DATE_PLATE_OBJECT)).toBe(false);
  });

  it("does not paint the 81/82 message-window bars over the DOM window", () => {
    const objects = {
      81: { ...blankObject(), visible: true, x: 0, y: 0, width: 640, height: 50, fill: { r: 0, g: 0, b: 0 }, alpha: 1 },
      82: { ...blankObject(), visible: true, x: 0, y: 430, width: 640, height: 50, fill: { r: 0, g: 0, b: 0 }, alpha: 1 },
      83: plate(),
    };
    expect(stageObjects(objects).map((entry) => entry.id)).toEqual([83]);
  });

  it("skips file-backed animation slots whose motion the port does not reproduce", () => {
    const drawn = stageObjects({ 1: plate({ asset: "image:G00_OP_A01.g00", fromFile: true }) });
    expect(drawn).toEqual([]);
  });

  it("normalises the 0-255 alpha channel of 1:82:1016", () => {
    expect(colourAlpha(255)).toBe(1);
    expect(colourAlpha(0)).toBe(0);
    expect(colourAlpha(128)).toBeCloseTo(128 / 255);
    expect(colourAlpha(1)).toBe(1);
    expect(colourAlpha(Number.NaN)).toBe(1);
    expect(colourAlpha(-5)).toBe(0);
  });
});

describe("date plate label", () => {
  it("reads the month and day the plate depicts from its resource name", () => {
    expect(datePlateLabel("image:G00_SDT0717.g00")).toBe("July 17");
    expect(datePlateLabel("image:G00_SDT0716.g00")).toBe("July 16");
    expect(datePlateLabel("image:G00_SDT0731.g00")).toBe("July 31");
    expect(datePlateLabel("image:G00_SDT0801.g00")).toBe("August 1");
    expect(datePlateLabel("image:G00_SDT0813.g00")).toBe("August 13");
  });

  it("rejects non-plate graphics and impossible dates", () => {
    expect(datePlateLabel(undefined)).toBeUndefined();
    expect(datePlateLabel("image:G00_BG018.g00")).toBeUndefined();
    expect(datePlateLabel("image:G00_OP_A00.g00")).toBeUndefined();
    expect(datePlateLabel("image:G00_SDT1399.g00")).toBeUndefined();
    expect(datePlateLabel("image:G00_SDT0700.g00")).toBeUndefined();
  });
});

describe("drawn object lookup", () => {
  it("returns the drawn plate so the announced date matches the picture", () => {
    const plate: StageObject = { asset: "image:G00_SDT0801.g00", x: 16, y: 66, visible: true, alpha: 1 };
    expect(drawnObject({ 83: plate }, 83)?.asset).toBe("image:G00_SDT0801.g00");
    expect(drawnObject({ 83: plate }, 83, { showDateCaption: false })).toBeUndefined();
    expect(drawnObject(undefined, 83)).toBeUndefined();
    expect(drawnObject({ 83: { ...plate, visible: false } }, 83)).toBeUndefined();
  });
});
