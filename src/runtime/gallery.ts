/**
 * CG gallery and music-mode data derived from the real manifest.
 *
 * AIR Standard Edition drives both screens from data, not from hard-coded
 * lists:
 *
 *  - `DAT/mode.cgm` (`#CGTABLE_FILENAME="mode.cgm"`) lists every CG with a
 *    numeric id. The four id ranges (0-40, 100-135, 200-230, 300-330) are the
 *    four gallery pages; `seen9035` walks them through memory `$6[400]`
 *    (category 0-3) and `$6[401]` (page 0-1), and shows a slot only when the
 *    per-CG "seen" query `1:4:1504` returns 1.
 *  - `seen9034` draws the completion percentage from `1:4:1502` and a
 *    numeric counter plate (`S_CGM_CNT00`).
 *  - `seen9036` builds a music screen from `S_MUM_TTAxx` plates and a
 *    `gotoCase` table that plays `BGM00`..`BGM24`/`BGM26` through `1:20:0`,
 *    with `1:20:105` (fade + stop) as the "stop" entry.
 *
 * The prepared manifest keeps the CGM order in `galleryAssets` and the CGM
 * name prefix in each asset's `source`, so this module can rebuild the same
 * grouping without re-reading the original DAT file.
 */

import type { AssetRef, GameManifest } from "../types";

export type GalleryCategory = {
  /** CGM name prefix, e.g. "FGMZ". */
  prefix: string;
  /** Human label. Kept neutral because the original screen shows no heading. */
  label: string;
  /** Gallery asset ids in CGM order. */
  assets: string[];
};

/**
 * Page order and labels. The prefixes come from `mode.cgm`; the CGM flags for
 * each range start together, which is what `seen9035` indexes with `$6[400]`.
 */
const CATEGORY_LAYOUT: Array<{ prefix: string; label: string }> = [
  { prefix: "FGMZ", label: "Series Z" },
  { prefix: "FGMG", label: "Series G" },
  { prefix: "FGKA", label: "Series KA" },
  { prefix: "FGKN", label: "Series KN" },
];

const categoryPrefix = (asset: AssetRef, id: string): string => {
  const source = asset.source ?? asset.id ?? id;
  const stem = (source.split(/[\\/]/).pop() ?? source).replace(/\.[^.]+$/, "").toUpperCase();
  const match = /^(FGM[A-Z]{2})/.exec(stem);
  if (match) return match[1];
  for (const { prefix } of CATEGORY_LAYOUT) if (stem.startsWith(prefix)) return prefix;
  return "CG";
};

/**
 * Group `manifest.galleryAssets` into the original four pages, preserving the
 * CGM table order inside each page.
 */
export function galleryCategories(manifest: GameManifest): GalleryCategory[] {
  const ids = manifest.galleryAssets?.length
    ? manifest.galleryAssets
    : Object.values(manifest.assets).filter((asset) => asset.kind === "image").map((asset) => asset.id);
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const asset = manifest.assets[id];
    if (!asset || asset.kind !== "image") continue;
    const prefix = categoryPrefix(asset, id);
    const list = groups.get(prefix) ?? [];
    list.push(id);
    groups.set(prefix, list);
  }
  const ordered: GalleryCategory[] = [];
  for (const { prefix, label } of CATEGORY_LAYOUT) {
    const assets = groups.get(prefix);
    if (assets?.length) {
      ordered.push({ prefix, label, assets });
      groups.delete(prefix);
    }
  }
  // Any CG that does not match a known prefix still needs to be reachable.
  for (const [prefix, assets] of groups) ordered.push({ prefix, label: prefix, assets });
  return ordered;
}

export type GalleryEntry = {
  id: string;
  asset: AssetRef;
  unlocked: boolean;
};

export function galleryEntries(
  manifest: GameManifest,
  unlocked: readonly string[],
): Array<GalleryCategory & { entries: GalleryEntry[]; unlockedCount: number }> {
  const owned = new Set(unlocked);
  return galleryCategories(manifest).map((category) => {
    const entries = category.assets.flatMap((id) => {
      const asset = manifest.assets[id];
      return asset ? [{ id, asset, unlocked: owned.has(id) }] : [];
    });
    return {
      ...category,
      entries,
      unlockedCount: entries.filter((entry) => entry.unlocked).length,
    };
  });
}

/** Completion percentage, matching `1:4:1502` (integer, rounded down). */
export function galleryPercent(manifest: GameManifest, unlocked: readonly string[]): number {
  const ids = manifest.galleryAssets ?? [];
  if (!ids.length) return 0;
  const owned = new Set(unlocked);
  const seen = ids.filter((id) => owned.has(id)).length;
  return Math.floor((seen / ids.length) * 100);
}

export type MusicTrack = {
  id: string;
  asset: AssetRef;
  /** `BGM00`-style label taken from the source filename. */
  label: string;
  /** Track number used by the original's `gotoCase` table, or undefined. */
  number?: number;
  /** True once the player has heard the track (music-mode unlock). */
  heard: boolean;
};

/**
 * Build the music-mode list from manifest audio.
 *
 * `seen9036` enumerates `BGM00`-`BGM26` only; `GAMEEXE.INI` gives that
 * directory its own `FOLDNAME.BGM` entry, and the ambient WAV effects in
 * `WAV/` are triggered by scenes rather than listed in music mode. When a
 * dataset has no `BGM##` tracks at all (the synthetic demo), every numbered
 * audio asset is used so the screen is still meaningful.
 */
export function musicTracks(manifest: GameManifest, played: readonly string[]): MusicTrack[] {
  const heard = new Set(played);
  const candidates = Object.values(manifest.assets).filter((asset) => asset.kind === "audio");
  const withStem = candidates.map((asset) => {
    const source = asset.source ?? asset.id;
    const stem = (source.split(/[\\/]/).pop() ?? source).replace(/\.[^.]+$/, "").toUpperCase();
    const numbered = /^([A-Z]+)(\d+)$/.exec(stem);
    return { asset, stem, numbered };
  });
  const bgm = withStem.filter((entry) => entry.stem.startsWith("BGM") && entry.numbered);
  const chosen = bgm.length ? bgm : withStem;
  const tracks: MusicTrack[] = chosen.map(({ asset, stem, numbered }) => ({
    id: asset.id,
    asset,
    label: numbered ? `${numbered[1]} ${numbered[2]}` : stem.replace(/[_-]+/g, " "),
    number: numbered ? Number(numbered[2]) : undefined,
    heard: heard.has(asset.id),
  }));
  return tracks.sort((a, b) => {
    if (a.number !== undefined && b.number !== undefined && a.number !== b.number) return a.number - b.number;
    if (a.number !== undefined && b.number === undefined) return -1;
    if (a.number === undefined && b.number !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** `mm:ss`, or a placeholder when the duration is unknown. */
export function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return "--:--";
  const totalSeconds = Math.round(durationMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
