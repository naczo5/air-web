import { describe, expect, it } from "vitest";
import { formatDuration, galleryCategories, galleryEntries, galleryPercent, musicTracks } from "./gallery";
import type { GameManifest } from "../types";

const asset = (id: string, kind: "image" | "audio", source: string, durationMs?: number) => ({
  id, kind, url: `/${id}`, source, ...(durationMs ? { durationMs } : {}),
});

/**
 * Fixture mirrors the real manifest shape: CGM table order in `galleryAssets`,
 * `source` retaining the original G00 filename, and BGM audio from BGM/.
 */
const manifest = (): GameManifest => ({
  id: "air-se",
  title: "Test",
  generatedAt: "test",
  logicalSize: { width: 640, height: 480 },
  startScene: "seen0163",
  scenes: {},
  flowchart: { nodes: [], edges: [] },
  assetAliases: {},
  galleryAssets: [
    "image:G00_FGMZ01.g00",
    "image:G00_FGMZ02A.g00",
    "image:G00_FGMG03A.g00",
    "image:G00_FGKA01.g00",
    "image:G00_FGKN01C.g00",
  ],
  assets: {
    "image:G00_FGMZ01.g00": asset("image:G00_FGMZ01.g00", "image", "G00/FGMZ01.g00"),
    "image:G00_FGMZ02A.g00": asset("image:G00_FGMZ02A.g00", "image", "G00/FGMZ02A.g00"),
    "image:G00_FGMG03A.g00": asset("image:G00_FGMG03A.g00", "image", "G00/FGMG03A.g00"),
    "image:G00_FGKA01.g00": asset("image:G00_FGKA01.g00", "image", "G00/FGKA01.g00"),
    "image:G00_FGKN01C.g00": asset("image:G00_FGKN01C.g00", "image", "G00/FGKN01C.g00"),
    "image:G00_BG001.g00": asset("image:G00_BG001.g00", "image", "G00/BG001.g00"),
    "audio:BGM_BGM10.nwa": asset("audio:BGM_BGM10.nwa", "audio", "BGM/BGM10.nwa", 90226),
    "audio:BGM_BGM02.nwa": asset("audio:BGM_BGM02.nwa", "audio", "BGM/BGM02.nwa", 62489),
    "audio:BGM_BGM26.nwa": asset("audio:BGM_BGM26.nwa", "audio", "BGM/BGM26.nwa", 320096),
    "voice:KOE_0000_Z000000000.ogg": asset("voice:KOE_0000_Z000000000.ogg", "audio", "KOE/0000/Z000000000.ogg"),
  },
});

describe("gallery pages", () => {
  it("groups CGM entries into the four original pages in table order", () => {
    const categories = galleryCategories(manifest());
    expect(categories.map((category) => category.prefix)).toEqual(["FGMZ", "FGMG", "FGKA", "FGKN"]);
    expect(categories[0].assets).toEqual(["image:G00_FGMZ01.g00", "image:G00_FGMZ02A.g00"]);
    expect(categories.every((category) => category.label.length > 0)).toBe(true);
  });

  it("excludes images that are not in the CGM table", () => {
    const ids = galleryCategories(manifest()).flatMap((category) => category.assets);
    expect(ids).not.toContain("image:G00_BG001.g00");
    expect(ids).toHaveLength(5);
  });

  it("marks seen and unseen entries from the unlock list", () => {
    const categories = galleryEntries(manifest(), ["image:G00_FGMZ02A.g00"]);
    const z = categories.find((category) => category.prefix === "FGMZ")!;
    expect(z.entries.map((entry) => entry.unlocked)).toEqual([false, true]);
    expect(z.unlockedCount).toBe(1);
  });

  it("computes the same floor percentage as the 1:4:1502 query", () => {
    expect(galleryPercent(manifest(), [])).toBe(0);
    expect(galleryPercent(manifest(), ["image:G00_FGMZ01.g00"])).toBe(20);
    const all = galleryCategories(manifest()).flatMap((category) => category.assets);
    expect(galleryPercent(manifest(), all)).toBe(100);
    expect(galleryPercent({ ...manifest(), galleryAssets: [] }, ["image:G00_FGMZ01.g00"])).toBe(0);
  });
});

describe("music mode", () => {
  it("sorts BGM tracks numerically and ignores ambient effects and voices", () => {
    const tracks = musicTracks(manifest(), []);
    expect(tracks.map((track) => track.label)).toEqual(["BGM 02", "BGM 10", "BGM 26"]);
    expect(tracks.every((track) => track.asset.kind === "audio")).toBe(true);
  });

  it("falls back to any numbered audio when a dataset has no BGM files", () => {
    const base = manifest();
    const tracks = musicTracks({
      ...base,
      assets: {
        "audio:audio__wav__kaze.wav": asset("audio:audio__wav__kaze.wav", "audio", "WAV/kaze.wav"),
      },
    }, []);
    expect(tracks.map((track) => track.label)).toEqual(["KAZE"]);
  });

  it("flags only tracks the player has heard", () => {
    const tracks = musicTracks(manifest(), ["audio:BGM_BGM10.nwa"]);
    expect(tracks.filter((track) => track.heard).map((track) => track.number)).toEqual([10]);
  });

  it("formats durations and tolerates missing values", () => {
    expect(formatDuration(90226)).toBe("1:30");
    expect(formatDuration(320096)).toBe("5:20");
    expect(formatDuration(undefined)).toBe("--:--");
    expect(formatDuration(0)).toBe("--:--");
  });
});
