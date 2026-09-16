import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { decodeG00, decodeNwaToWav, decodePdt, encodePngRgba, parseCgmTable, parseGameIni, printableText, readSeenIndex, readSeenEntry } from "./formats";

describe("AIR format helpers", () => {
  it("reads the eight-byte SEEN archive index", () => {
    const buffer = new Uint8Array(80048);
    const view = new DataView(buffer.buffer);
    view.setUint32(8 * 3, 80040, true);
    view.setUint32(8 * 3 + 4, 4, true);
    buffer.set([65, 73, 82, 33], 80040);
    const entries = readSeenIndex(buffer);
    expect(entries).toEqual([{ scene: 3, offset: 80040, length: 4 }]);
    expect([...readSeenEntry(buffer, entries[0])]).toEqual([65, 73, 82, 33]);
  });

  it("rejects entries that run outside the archive", () => {
    const buffer = new Uint8Array(16);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, 12, true);
    view.setUint32(4, 8, true);
    expect(() => readSeenIndex(buffer)).toThrow(/exceeds archive/);
  });

  it("parses game configuration and extracts printable diagnostics", () => {
    expect(parseGameIni("#SEEN_START=9030\n#CAPTION=\"Air\"\n")).toEqual({ SEEN_START: "9030", CAPTION: '"Air"' });
    expect(printableText(new TextEncoder().encode("xxAIR scene text!!\x00\x01more"))).toContain("xxAIR scene text!!");
  });

  it("decodes synthetic G00 RGB and paletted images", () => {
    const rgb = new Uint8Array(0x0d + 7);
    rgb[0] = 0;
    new DataView(rgb.buffer).setUint16(1, 2, true);
    new DataView(rgb.buffer).setUint16(3, 1, true);
    new DataView(rgb.buffer).setUint32(5, 15, true);
    new DataView(rgb.buffer).setUint32(9, 8, true);
    rgb.set([0x03, 1, 2, 3, 4, 5, 6], 0x0d);
    expect(decodeG00(rgb)).toEqual({ width: 2, height: 1, data: new Uint8Array([3, 2, 1, 255, 6, 5, 4, 255]) });

    const palettedData = new Uint8Array([1, 0, 10, 20, 30, 40, 0, 0]);
    const paletted = new Uint8Array(0x0d + 9);
    paletted[0] = 1;
    new DataView(paletted.buffer).setUint16(1, 2, true);
    new DataView(paletted.buffer).setUint16(3, 1, true);
    new DataView(paletted.buffer).setUint32(5, 17, true);
    new DataView(paletted.buffer).setUint32(9, palettedData.length, true);
    paletted.set([0xff, ...palettedData], 0x0d);
    expect(decodeG00(paletted).data).toEqual(new Uint8Array([30, 20, 10, 40, 30, 20, 10, 40]));
  });

  it("decodes synthetic PDT10 alpha and emits PNG", () => {
    const pdt = new Uint8Array(0x20 + 4 + 3);
    new TextEncoder().encode("PDT10").forEach((byte, index) => { pdt[index] = byte; });
    new DataView(pdt.buffer).setUint32(0x08, pdt.length, true);
    new DataView(pdt.buffer).setUint32(0x0c, 1, true);
    new DataView(pdt.buffer).setUint32(0x10, 1, true);
    new DataView(pdt.buffer).setUint32(0x1c, 0x20 + 4, true);
    pdt.set([0x80, 11, 22, 33], 0x20);
    pdt.set([0x80, 127], 0x24);
    const image = decodePdt(pdt);
    expect([...image.data]).toEqual([33, 22, 11, 127]);
    expect([...encodePngRgba(image).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("wraps uncompressed NWA PCM in a WAV container", () => {
    const nwa = new Uint8Array(0x2c + 4);
    const view = new DataView(nwa.buffer);
    view.setInt16(0, 2, true);
    view.setInt16(2, 16, true);
    view.setInt32(4, 44100, true);
    view.setInt32(8, -1, true);
    view.setInt32(20, 4, true);
    view.setInt32(28, 2, true);
    nwa.set([1, 2, 3, 4], 0x2c);
    const decoded = decodeNwaToWav(nwa);
    expect(decoded.info.compression).toBe(-1);
    expect(decoded.wav.subarray(0, 4).toString()).toBe("RIFF");
    expect([...decoded.wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it.skipIf(!fs.existsSync("AIR_SE/DAT/mode.cgm"))("decodes AIR's CG unlock table", () => {
    const table = parseCgmTable(new Uint8Array(fs.readFileSync("AIR_SE/DAT/mode.cgm")));
    expect(table).toHaveLength(134);
    expect(table[0]).toEqual({ name: "FGMZ01", flag: 0 });
    expect(new Set(table.map((entry) => entry.flag)).size).toBe(134);
  });
});
