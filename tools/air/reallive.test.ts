import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { readSeenEntry, readSeenIndex } from "./formats";
import { decompressRealLiveScene, extractRealLiveControls, extractRealLiveSceneJumps, extractRealLiveTexts } from "./reallive";

describe("RealLive SEEN bytecode container", () => {
  it("decompresses a literal-only archived scene", () => {
    const dataOffset = 0x1c4;
    const compressed = new Uint8Array([0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x07, 0x8e, 0xd6, 0x55]);
    const scene = new Uint8Array(dataOffset + compressed.length);
    scene.set([0xd0, 0x01, 0x00, 0x00], 0);
    new DataView(scene.buffer).setUint32(4, 10002, true);
    new DataView(scene.buffer).setUint32(0x20, dataOffset, true);
    new DataView(scene.buffer).setUint32(0x24, 3, true);
    new DataView(scene.buffer).setUint32(0x28, compressed.length, true);
    scene.set(compressed, dataOffset);
    const decoded = decompressRealLiveScene(scene);
    expect([...decoded.data.subarray(dataOffset)]).toEqual([11, 22, 33]);
    expect(decoded.header.compilerVersion).toBe(10002);
  });

  it.skipIf(!fs.existsSync("AIR_SE/SEEN.txt"))("extracts patched English dialogue from a real AIR scene", () => {
    const archive = fs.readFileSync("AIR_SE/SEEN.txt");
    const entry = readSeenIndex(archive).find((item) => item.scene === 163);
    expect(entry).toBeDefined();
    const decoded = decompressRealLiveScene(readSeenEntry(archive, entry!));
    const texts = extractRealLiveTexts(decoded.data, decoded.header);
    expect(texts.some((item) => item.text.includes("When I woke up"))).toBe(true);
  });

  it.skipIf(!fs.existsSync("AIR_SE/SEEN.txt"))("follows AIR's title bootstrap to the fresh-install story scene", () => {
    const archive = fs.readFileSync("AIR_SE/SEEN.txt");
    const entries = readSeenIndex(archive);
    const targets = new Map<number, number[]>();
    for (const scene of [9030, 9031, 9032, 9038]) {
      const entry = entries.find((item) => item.scene === scene);
      expect(entry).toBeDefined();
      const decoded = decompressRealLiveScene(readSeenEntry(archive, entry!));
      targets.set(scene, extractRealLiveSceneJumps(decoded.data, decoded.header).map((jump) => jump.scene));
    }
    expect(targets.get(9030)).toContain(9031);
    expect(targets.get(9031)).toContain(9032);
    expect(targets.get(9032)?.[0]).toBe(9038);
    expect(targets.get(9038)?.[0]).toBe(170);
  });

  it.skipIf(!fs.existsSync("AIR_SE/SEEN.txt"))("extracts selection branch ladders and rejects engine diagnostics", () => {
    const archive = fs.readFileSync("AIR_SE/SEEN.txt");
    const entry = readSeenIndex(archive).find((item) => item.scene === 180);
    expect(entry).toBeDefined();
    const decoded = decompressRealLiveScene(readSeenEntry(archive, entry!));
    const choice = extractRealLiveControls(decoded.data, decoded.header)
      .find((control) => control.kind === "choice" && control.offset === 168592);
    expect(choice?.targetOffsets).toEqual([168703, 184047, 197689]);
    const texts = extractRealLiveTexts(decoded.data, decoded.header);
    expect(texts.some((item) => /Unable to format text|^Error:$/.test(item.text))).toBe(false);
  });
});
