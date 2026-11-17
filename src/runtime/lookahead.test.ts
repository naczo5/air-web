import { describe, expect, it } from "vitest";
import type { SceneProgram } from "../types";
import { lookaheadAssets, lookaheadWithBackdrop } from "./lookahead";

const resolve = (name: string) => `image:${name.toUpperCase()}`;

/** `1:40:100 (<name|mem>, y)` — the composite stage draw. */
const stageDraw = (value: unknown) =>
  ({ op: "command", offset: 0, moduleType: 1, module: 40, opcode: 100, argc: 2, overload: 0, args: [value as never, { kind: "expression", value: { kind: "int", value: 48 } }] }) as SceneProgram["instructions"][number];

const nameLiteral = (value: string) => ({ kind: "string", value });
const memory = (index: number) => ({ kind: "expression", value: { kind: "memory", bank: 18, index: { kind: "int", value: index } } });

/** `1:23:0 (<z>)` — voice selection. */
const voice = (z: number) =>
  ({ op: "command", offset: 0, moduleType: 1, module: 23, opcode: 0, argc: 1, overload: 0, args: [{ kind: "expression", value: { kind: "int", value: z } }] }) as SceneProgram["instructions"][number];

/** `1:10:0 ($18[1000], "<name>")` — backdrop cell assignment. */
const assignBackdrop = (name: string) =>
  ({ op: "command", offset: 0, moduleType: 1, module: 10, opcode: 0, argc: 2, overload: 0, args: [memory(1000), { kind: "string", value: name }] }) as SceneProgram["instructions"][number];

const scene = (instructions: SceneProgram["instructions"]): SceneProgram => ({ id: "t", instructions });

describe("lookaheadAssets", () => {
  it("warms voices named by 1:23 from a Z number", () => {
    const out = lookaheadAssets(scene([voice(30), voice(31)]), 0, { resolve });
    expect(out.audio).toEqual(["image:Z000000030", "image:Z000000031"]);
    expect(out.images).toEqual([]);
  });

  it("resolves a backdrop literal in the near window", () => {
    const out = lookaheadAssets(scene([stageDraw(nameLiteral("BG003"))]), 0, { resolve });
    expect(out.images).toEqual(["image:BG003"]);
  });

  it("resolves a backdrop named through the string cell", () => {
    const out = lookaheadAssets(scene([stageDraw(memory(1000))]), 0, { resolve, stringMemory: { "18:1000": "BG004" } });
    expect(out.images).toEqual(["image:BG004"]);
  });

  it("caps how much it warms so a dense block cannot flood the network", () => {
    const many = Array.from({ length: 40 }, (_, index) => voice(index));
    const out = lookaheadAssets(scene(many), 0, { resolve, maxAudio: 3 });
    expect(out.audio.length).toBe(3);
  });

  it("ignores commands outside the lookahead window", () => {
    const out = lookaheadAssets(scene([voice(1), ...Array.from({ length: 60 }, () => ({ op: "end" as const })), voice(99)]), 0, { resolve, lookahead: 10 });
    expect(out.audio).toEqual(["image:Z000000001"]);
  });
});

describe("lookaheadWithBackdrop", () => {
  it("finds a backdrop that sits far beyond the voice window", () => {
    // Backdrops are 35-280 instructions apart, so a near-window scan misses
    // most of them — which is exactly the bug this function exists to fix.
    const filler = Array.from({ length: 200 }, () => voice(1));
    const instructions = [...filler, assignBackdrop("BG051"), stageDraw(memory(1000))];
    const near = lookaheadAssets(scene(instructions), 0, { resolve, lookahead: 40 });
    expect(near.images).toEqual([]);
    const wide = lookaheadWithBackdrop(scene(instructions), 0, { resolve, lookahead: 40 });
    expect(wide.images).toContain("image:BG051");
  });

  it("uses the most recent cell assignment before the draw", () => {
    // The script rewrites $18[1000]; the draw must use the latest value, not
    // an earlier one, or the wrong backdrop is warmed.
    const instructions = [assignBackdrop("BG001"), assignBackdrop("BG007"), stageDraw(memory(1000))];
    const out = lookaheadWithBackdrop(scene(instructions), 0, { resolve });
    expect(out.images).toEqual(["image:BG007"]);
  });

  it("prefers the tracked assignment over the live cell, so it warms the NEXT backdrop", () => {
    // The live $18[1000] still holds the backdrop already on screen at a text
    // pause. Preferring it warmed the current image 91% of the time.
    const instructions = [assignBackdrop("BG007"), stageDraw(memory(1000))];
    const out = lookaheadWithBackdrop(scene(instructions), 0, {
      resolve,
      stringMemory: { "18:1000": "BG001" }, // the stale, on-screen value
    });
    expect(out.images[0]).toBe("image:BG007");
  });

  it("finds a backdrop set by literal filename on a background slot", () => {
    // 1:33:73/74/75/1053… set a backdrop by name; these are 1,446 paint sites
    // that a scan looking only at 1:40:100 never sees.
    const paint = (name: string, slot: number) =>
      ({ op: "command", offset: 0, moduleType: 1, module: 33, opcode: 73, argc: 2, overload: 0, args: [nameLiteral(name), { kind: "expression", value: { kind: "int", value: slot } }] }) as SceneProgram["instructions"][number];
    const out = lookaheadWithBackdrop(scene([paint("BG050", 0)]), 0, { resolve });
    expect(out.images).toContain("image:BG050");
  });

  it("ignores a 1:33 paint on a character slot, which is not a backdrop", () => {
    const paint = (name: string, slot: number) =>
      ({ op: "command", offset: 0, moduleType: 1, module: 33, opcode: 73, argc: 2, overload: 0, args: [nameLiteral(name), { kind: "expression", value: { kind: "int", value: slot } }] }) as SceneProgram["instructions"][number];
    const out = lookaheadWithBackdrop(scene([paint("CGMZ10", 60)]), 0, { resolve });
    expect(out.images).not.toContain("image:CGMZ10");
  });

  it("returns the near result unchanged when there is no backdrop ahead", () => {
    const out = lookaheadWithBackdrop(scene([voice(5)]), 0, { resolve });
    expect(out.images).toEqual([]);
    expect(out.audio).toEqual(["image:Z000000005"]);
  });
});
