#!/usr/bin/env tsx
/**
 * Pack the decoded AIR assets into a deployment tree with a small manifest.
 *
 * The player never needs the 128 MB monolithic manifest on first load:
 *
 *   dist-pack/
 *     manifest.json                     tiny bootstrap (short cache)
 *     manifest.index-<hash>.json.gz     assets + aliases + flowchart + scene index
 *     manifest.index-<hash>.json        raw fallback for hosts/browsers without gzip
 *     scenes/<scene>-<hash>.json.gz     one gzipped scene program per scene
 *     pack/<group>-<seq>-<hash>.pack     byte-range archives (voices, images)
 *     audio/<name>.wav                  large BGM/SE WAVs, one object each
 *     checksums.sha256                  deterministic inventory
 *     report.json                       build statistics (not uploaded)
 *
 * Pack archives are plain concatenations. An asset URL becomes
 * `/pack/<archive>#<start>-<end>:<ext>` where `end` is exclusive. No media is
 * re-encoded, downscaled or otherwise modified: every byte is copied verbatim.
 *
 * Usage:
 *   npx tsx tools/air/pack.ts
 *   npx tsx tools/air/pack.ts --check
 *   npx tsx tools/air/pack.ts --with-player dist-game
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import type { AssetRef, GameManifest, SceneProgram } from "../../src/types";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ASSETS = path.join(PROJECT_ROOT, ".air-web-assets");
const DEFAULT_OUT = path.join(PROJECT_ROOT, "dist-pack");
const MARKER = ".air-pack-output";

type Options = {
  assets: string;
  out: string;
  voiceChunkBytes: number;
  imageChunkBytes: number;
  playerDir?: string;
  check: boolean;
};

type PackedSceneEntry = { u: string; e?: Record<string, number>; n?: number };

type Stats = {
  sourceFiles: number;
  sourceBytes: number;
  imageFiles: number;
  imageBytes: number;
  voiceFiles: number;
  voiceBytes: number;
  audioFiles: number;
  audioBytes: number;
  duplicates: number;
  duplicateBytes: number;
  voicePacks: number;
  imagePacks: number;
  voicePackBytes: number;
  imagePackBytes: number;
  sceneFiles: number;
  sceneBytes: number;
  scenePackedBytes: number;
  indexBytes: number;
  indexGzipBytes: number;
  objectFiles: number;
  objectBytes: number;
};

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const shortHash = (data: Uint8Array | string): string => sha256(data).slice(0, 12);
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid size: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "mb").toLowerCase();
  if (unit === "b") return Math.round(amount);
  if (unit === "kb" || unit === "kib") return Math.round(amount * 1024);
  if (unit === "mb" || unit === "mib") return Math.round(amount * 1024 * 1024);
  throw new Error(`Invalid size unit: ${value}`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    assets: DEFAULT_ASSETS,
    out: DEFAULT_OUT,
    voiceChunkBytes: 2 * 1024 * 1024,
    imageChunkBytes: 4 * 1024 * 1024,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--assets": options.assets = path.resolve(value()); break;
      case "--out": options.out = path.resolve(value()); break;
      case "--voice-chunk": options.voiceChunkBytes = parseSize(value()); break;
      case "--image-chunk": options.imageChunkBytes = parseSize(value()); break;
      case "--with-player": options.playerDir = path.resolve(value()); break;
      case "--check": options.check = true; break;
      case "--help":
      case "-h":
        console.log("Usage: tsx tools/air/pack.ts [--assets DIR] [--out DIR] [--voice-chunk 2MB] [--image-chunk 4MB] [--with-player DIR] [--check]");
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function human(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string): Promise<Array<{ relative: string; absolute: string; size: number }>> {
  const result: Array<{ relative: string; absolute: string; size: number }> = [];
  async function walk(relative: string) {
    const absolute = path.join(root, relative);
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.push({ relative: next, absolute: path.join(root, path.sep === "/" ? next : next.split("/").join(path.sep)), size: (await fsp.stat(path.join(root, next))).size });
    }
  }
  await walk("");
  return result;
}

async function prepareOutput(out: string, assets: string): Promise<void> {
  for (const protectedRoot of [assets, path.join(PROJECT_ROOT, "AIR_SE"), path.join(PROJECT_ROOT, ".air-web-assets")]) {
    const resolved = path.resolve(protectedRoot);
    if (out === resolved || out.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`Refusing to write inside protected directory: ${out}`);
    }
  }
  const allowed = path.basename(out) === "dist-pack" || path.basename(out).startsWith("dist-pack-");
  if (await exists(out)) {
    const marker = path.join(out, MARKER);
    if (!(await exists(marker)) && !allowed) {
      throw new Error(`Refusing to replace ${out}: it is not a previous dist-pack output (missing ${MARKER}).`);
    }
    await fsp.rm(out, { recursive: true, force: true });
  }
  await fsp.mkdir(path.join(out, "pack"), { recursive: true });
  await fsp.mkdir(path.join(out, "scenes"), { recursive: true });
  await fsp.mkdir(path.join(out, "audio"), { recursive: true });
  await fsp.writeFile(path.join(out, MARKER), "generated by tools/air/pack.ts\n");
}

/** Group images by their role so consecutive backgrounds/CGs share a chunk. */
function imageGroup(source: string): string {
  const name = path.basename(source).replace(/\.[^.]+$/, "").toUpperCase();
  if (name.startsWith("BG")) return "bg";
  if (name.startsWith("FG")) return "chara";
  if (name.startsWith("CG")) return "cg";
  if (name.startsWith("OP")) return "opening";
  if (name.startsWith("S_") || name.startsWith("SDT") || name.startsWith("SMW") || name.startsWith("MSG") || name.startsWith("DAY") || name.startsWith("KDAY") || name.startsWith("RMB") || /^R\d/.test(name)) return "system";
  return "misc";
}

function voiceGroup(source: string): string {
  const parts = source.split("/");
  const directory = parts.length > 1 ? parts[parts.length - 2] : "misc";
  return `voices_${directory.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

type ChunkEntry = { assets: AssetRef[]; start: number; end: number; hash: string };
type DedupeEntry = { url?: string; pending?: ChunkEntry };

type Packer = {
  assetsDir: string;
  outDir: string;
  stats: Stats;
  dedupe: Map<string, DedupeEntry>;
};

async function packGroup(
  packer: Packer,
  options: { group: string; extension: string; chunkBytes: number; assets: AssetRef[] },
): Promise<void> {
  const { assetsDir, outDir, stats, dedupe } = packer;
  const sorted = [...options.assets].sort((left, right) => compareText(left.source ?? left.url, right.source ?? right.url));
  let buffers: Buffer[] = [];
  let length = 0;
  let sequence = 0;
  let entries: ChunkEntry[] = [];

  const flush = async () => {
    if (!length) return;
    const data = Buffer.concat(buffers, length);
    const hash = shortHash(data);
    const filename = `${options.group}-${String(sequence).padStart(3, "0")}-${hash}.pack`;
    await fsp.writeFile(path.join(outDir, "pack", filename), data);
    const ref = `/pack/${filename}`;
    for (const entry of entries) {
      for (const asset of entry.assets) asset.url = `${ref}#${entry.start}-${entry.end}:${options.extension}`;
      dedupe.set(entry.hash, { url: `${ref}#${entry.start}-${entry.end}:${options.extension}` });
    }
    if (options.group.startsWith("voices")) {
      stats.voicePacks += 1;
      stats.voicePackBytes += data.length;
    } else {
      stats.imagePacks += 1;
      stats.imagePackBytes += data.length;
    }
    sequence += 1;
    buffers = [];
    length = 0;
    entries = [];
  };

  for (const asset of sorted) {
    const relative = decodeURIComponent(asset.url.replace(/^\//, ""));
    const file = path.join(assetsDir, relative);
    const data = await fsp.readFile(file);
    const hash = sha256(data);
    const existing = dedupe.get(hash);
    if (existing?.url) {
      asset.url = existing.url;
      stats.duplicates += 1;
      stats.duplicateBytes += data.length;
      continue;
    }
    if (existing?.pending) {
      existing.pending.assets.push(asset);
      stats.duplicates += 1;
      stats.duplicateBytes += data.length;
      continue;
    }
    if (length && length + data.length > options.chunkBytes) await flush();
    const start = length;
    buffers.push(data);
    length += data.length;
    const entry: ChunkEntry = { assets: [asset], start, end: length, hash };
    entries.push(entry);
    dedupe.set(hash, { pending: entry });
  }
  await flush();
}

async function stageAudio(packer: Packer, assets: AssetRef[]): Promise<void> {
  const { assetsDir, outDir, stats, dedupe } = packer;
  const byHash = new Map<string, string>();
  for (const asset of [...assets].sort((left, right) => compareText(left.url, right.url))) {
    const relative = decodeURIComponent(asset.url.replace(/^\//, ""));
    const source = path.join(assetsDir, relative);
    const data = await fsp.readFile(source);
    const hash = sha256(data);
    const existing = byHash.get(hash) ?? dedupe.get(hash)?.url;
    if (existing) {
      asset.url = existing;
      stats.duplicates += 1;
      stats.duplicateBytes += data.length;
      continue;
    }
    const originalName = path.basename(relative);
    const extension = path.extname(originalName);
    const filename = `${originalName.slice(0, -extension.length)}-${hash.slice(0, 12)}${extension}`;
    const target = path.join(outDir, "audio", filename);
    try {
      await fsp.link(source, target);
    } catch {
      await fsp.copyFile(source, target);
    }
    asset.url = `/audio/${filename}`;
    byHash.set(hash, asset.url);
  }
  // Keep the dedupe map honest for a potential future cross-kind duplicate.
  for (const [hash, url] of byHash) if (!dedupe.has(hash)) dedupe.set(hash, { url });
}

async function writeScenes(outDir: string, manifest: GameManifest): Promise<{ index: Record<string, PackedSceneEntry>; stats: Pick<Stats, "sceneFiles" | "sceneBytes" | "scenePackedBytes"> }> {
  const index: Record<string, PackedSceneEntry> = {};
  let files = 0;
  let bytes = 0;
  let packedBytes = 0;
  for (const sceneId of Object.keys(manifest.scenes).sort()) {
    const scene = manifest.scenes[sceneId] as SceneProgram;
    const raw = Buffer.from(JSON.stringify(scene), "utf8");
    const gzip = zlib.gzipSync(raw, { level: 9 });
    const hash = shortHash(gzip);
    const filename = `${sceneId}-${hash}.json.gz`;
    await fsp.writeFile(path.join(outDir, "scenes", filename), gzip);
    index[sceneId] = {
      u: `/scenes/${filename}`,
      ...(scene.entrypoints && Object.keys(scene.entrypoints).length ? { e: scene.entrypoints } : {}),
      ...(scene.title ? { t: scene.title } : {}),
      n: raw.length,
    };
    files += 1;
    bytes += raw.length;
    packedBytes += gzip.length;
  }
  return { index, stats: { sceneFiles: files, sceneBytes: bytes, scenePackedBytes: packedBytes } };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) result[key] = record[key];
  return result;
}

async function build(options: Options): Promise<void> {
  const manifestPath = path.join(options.assets, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as GameManifest;
  if (!manifest.assets || !manifest.scenes || !manifest.flowchart) throw new Error(`Invalid manifest: ${manifestPath}`);

  const assets = Object.values(manifest.assets);
  const images = assets.filter((asset) => asset.kind === "image");
  const voices = assets.filter((asset) => asset.kind === "voice");
  const audio = assets.filter((asset) => asset.kind === "audio");

  let sourceBytes = 0;
  for (const asset of assets) {
    const relative = decodeURIComponent(asset.url.replace(/^\//, ""));
    sourceBytes += (await fsp.stat(path.join(options.assets, relative))).size;
  }

  const stats: Stats = {
    sourceFiles: assets.length,
    sourceBytes,
    imageFiles: images.length,
    imageBytes: images.reduce((sum, asset) => sum + fs.statSync(path.join(options.assets, decodeURIComponent(asset.url.replace(/^\//, "")))).size, 0),
    voiceFiles: voices.length,
    voiceBytes: voices.reduce((sum, asset) => sum + fs.statSync(path.join(options.assets, decodeURIComponent(asset.url.replace(/^\//, "")))).size, 0),
    audioFiles: audio.length,
    audioBytes: audio.reduce((sum, asset) => sum + fs.statSync(path.join(options.assets, decodeURIComponent(asset.url.replace(/^\//, "")))).size, 0),
    duplicates: 0,
    duplicateBytes: 0,
    voicePacks: 0,
    imagePacks: 0,
    voicePackBytes: 0,
    imagePackBytes: 0,
    sceneFiles: 0,
    sceneBytes: 0,
    scenePackedBytes: 0,
    indexBytes: 0,
    indexGzipBytes: 0,
    objectFiles: 0,
    objectBytes: 0,
  };

  await prepareOutput(options.out, options.assets);
  const packer: Packer = { assetsDir: options.assets, outDir: options.out, stats, dedupe: new Map() };

  const imageGroups = new Map<string, AssetRef[]>();
  for (const asset of images) {
    const group = imageGroup(asset.source ?? asset.url);
    const list = imageGroups.get(group) ?? [];
    list.push(asset);
    imageGroups.set(group, list);
  }
  for (const group of [...imageGroups.keys()].sort()) {
    await packGroup(packer, {
      group: `images_${group}`,
      extension: "png",
      chunkBytes: options.imageChunkBytes,
      assets: imageGroups.get(group)!,
    });
  }

  const voiceGroups = new Map<string, AssetRef[]>();
  for (const asset of voices) {
    const group = voiceGroup(asset.source ?? asset.url);
    const list = voiceGroups.get(group) ?? [];
    list.push(asset);
    voiceGroups.set(group, list);
  }
  for (const group of [...voiceGroups.keys()].sort()) {
    await packGroup(packer, {
      group,
      extension: "ogg",
      chunkBytes: options.voiceChunkBytes,
      assets: voiceGroups.get(group)!,
    });
  }

  await stageAudio(packer, audio);

  const sceneResult = await writeScenes(options.out, manifest);
  Object.assign(stats, sceneResult.stats);

  const index: Record<string, unknown> = {
    id: manifest.id,
    title: manifest.title,
    logicalSize: manifest.logicalSize,
    ...(manifest.startScene ? { startScene: manifest.startScene } : {}),
    scenes: {},
    sceneIndex: sceneResult.index,
    assets: sortedRecord(manifest.assets),
    ...(manifest.assetAliases ? { assetAliases: sortedRecord(manifest.assetAliases) } : {}),
    // `galleryAssets` is an ORDERED table: the original CG screen shows the
    // `mode.cgm` order inside each page. Never sort it -- sorting `assets` is
    // fine because that is a keyed record.
    ...(manifest.galleryAssets ? { galleryAssets: [...manifest.galleryAssets] } : {}),
    flowchart: manifest.flowchart,
    generatedAt: manifest.generatedAt,
    ...(manifest.sourceSummary ? { sourceSummary: manifest.sourceSummary } : {}),
  };
  const indexRaw = Buffer.from(JSON.stringify(index), "utf8");
  const indexGzip = zlib.gzipSync(indexRaw, { level: 9 });
  const indexHash = shortHash(indexGzip);
  const indexName = `manifest.index-${indexHash}.json.gz`;
  const fallbackName = `manifest.index-${indexHash}.json`;
  await fsp.writeFile(path.join(options.out, indexName), indexGzip);
  await fsp.writeFile(path.join(options.out, fallbackName), indexRaw);
  stats.indexBytes = indexRaw.length;
  stats.indexGzipBytes = indexGzip.length;

  if (options.playerDir) {
    const player = options.playerDir;
    if (!(await exists(player))) throw new Error(`Player build not found: ${player}`);
    for (const name of ["index.html", "assets", "manifest.webmanifest", "sw.js", "vite.svg", "favicon.ico"]) {
      const source = path.join(player, name);
      if (!(await exists(source))) continue;
      const target = path.join(options.out, name);
      // Replace rather than merge. A merge leaves every previous build's
      // hashed bundle behind, which bloats the deployment and uploads dead
      // objects (a repeat rebuild had accumulated 14 stale bundles).
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(source, target, { recursive: true });
    }
  }

  const bootstrap = {
    format: "air-pack-v1",
    version: 1,
    generatedAt: manifest.generatedAt,
    index: indexName,
    fallback: fallbackName,
  };
  await fsp.writeFile(path.join(options.out, "manifest.json"), `${JSON.stringify(bootstrap)}\n`);

  // Checksums are deterministic and cover everything except themselves and
  // the local-only report. This is the upload verification manifest.
  const checksumFiles = (await walkFiles(options.out)).filter((file) => file.relative !== MARKER && file.relative !== "report.json" && file.relative !== "checksums.sha256");
  const checksums: string[] = [];
  for (const file of checksumFiles) {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(file.absolute);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    checksums.push(`${hash.digest("hex")}  ${file.relative}`);
  }
  await fsp.writeFile(path.join(options.out, "checksums.sha256"), `${checksums.join("\n")}\n`);

  // Count the complete deployment, including the bootstrap and checksums.
  const deploymentFiles = (await walkFiles(options.out)).filter((file) => file.relative !== MARKER && file.relative !== "report.json");
  stats.objectFiles = deploymentFiles.length;
  stats.objectBytes = deploymentFiles.reduce((sum, file) => sum + file.size, 0);

  const report = {
    format: "air-pack-report-v1",
    generatedAt: manifest.generatedAt,
    ...stats,
    voiceChunkBytes: options.voiceChunkBytes,
    imageChunkBytes: options.imageChunkBytes,
    index: indexName,
    fallback: fallbackName,
  };
  await fsp.writeFile(path.join(options.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log("AIR pack complete");
  console.log(`  source:  ${stats.sourceFiles} objects, ${human(stats.sourceBytes)}`);
  console.log(`    images ${stats.imageFiles} / ${human(stats.imageBytes)} -> ${stats.imagePacks} packs / ${human(stats.imagePackBytes)}`);
  console.log(`    voices ${stats.voiceFiles} / ${human(stats.voiceBytes)} -> ${stats.voicePacks} packs / ${human(stats.voicePackBytes)}`);
  console.log(`    audio  ${stats.audioFiles} / ${human(stats.audioBytes)} -> ${stats.audioFiles} individual WAVs (stream/seek)`);
  console.log(`  scenes:  ${stats.sceneFiles} gzip files, ${human(stats.sceneBytes)} -> ${human(stats.scenePackedBytes)}`);
  console.log(`  index:   ${human(stats.indexBytes)} raw -> ${human(stats.indexGzipBytes)} gzip`);
  console.log(`  deploy:  ${stats.objectFiles} objects, ${human(stats.objectBytes)} (everything except local report/marker)`);
  console.log(`  dedupe:  ${stats.duplicates} files, ${human(stats.duplicateBytes)} not stored twice`);
  console.log(`  output:  ${options.out}`);
}

type CheckIndex = GameManifest & { sceneIndex?: Record<string, PackedSceneEntry> };

async function check(options: Options): Promise<void> {
  const out = options.out;
  const errors: string[] = [];
  const bootstrapPath = path.join(out, "manifest.json");
  const bootstrap = JSON.parse(await fsp.readFile(bootstrapPath, "utf8")) as { format?: string; index?: string; fallback?: string };
  if (bootstrap.format !== "air-pack-v1" || !bootstrap.index) throw new Error("manifest.json is not an air-pack-v1 bootstrap");
  const indexFiles = [bootstrap.index, bootstrap.fallback].filter((value): value is string => Boolean(value));
  let index: CheckIndex | undefined;
  for (const name of indexFiles) {
    const file = path.join(out, name);
    if (!(await exists(file))) {
      errors.push(`missing index: ${name}`);
      continue;
    }
    let raw = await fsp.readFile(file);
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    try {
      index = JSON.parse(raw.toString("utf8")) as CheckIndex;
      break;
    } catch (error) {
      errors.push(`invalid index ${name}: ${(error as Error).message}`);
    }
  }
  if (!index) throw new Error(`No readable manifest index.\n${errors.join("\n")}`);

  let packedRanges = 0;
  let plainAssets = 0;
  const packHashes = new Set<string>();
  for (const [id, asset] of Object.entries(index.assets ?? {})) {
    if (asset.url.startsWith("/pack/")) {
      const match = /^\/pack\/([^#]+)#(\d+)-(\d+)(?::([a-z0-9]+))?$/i.exec(asset.url);
      if (!match) {
        errors.push(`invalid packed ref for ${id}: ${asset.url}`);
        continue;
      }
      const [, filename, startText, endText] = match;
      const start = Number(startText);
      const end = Number(endText);
      const file = path.join(out, "pack", filename);
      if (!(await exists(file))) {
        errors.push(`missing pack for ${id}: ${filename}`);
        continue;
      }
      const size = (await fsp.stat(file)).size;
      if (!(start < end && end <= size)) errors.push(`range outside pack for ${id}: ${asset.url} (size ${size})`);
      packedRanges += 1;
      if (!packHashes.has(filename)) {
        packHashes.add(filename);
        const hash = shortHash(await fsp.readFile(file));
        if (!filename.includes(`-${hash}.pack`)) errors.push(`pack hash mismatch: ${filename}`);
      }
    } else {
      const relative = decodeURIComponent(asset.url.replace(/^\//, ""));
      if (!(await exists(path.join(out, relative)))) errors.push(`missing plain asset for ${id}: ${asset.url}`);
      plainAssets += 1;
    }
  }

  let scenes = 0;
  for (const [sceneId, entry] of Object.entries(index.sceneIndex ?? {})) {
    const relative = decodeURIComponent(entry.u.replace(/^\//, ""));
    const file = path.join(out, relative);
    if (!(await exists(file))) {
      errors.push(`missing scene ${sceneId}: ${entry.u}`);
      continue;
    }
    let raw = await fsp.readFile(file);
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    try {
      const scene = JSON.parse(raw.toString("utf8")) as SceneProgram;
      if (!Array.isArray(scene.instructions)) errors.push(`scene ${sceneId} has no instructions array`);
      else scenes += 1;
    } catch (error) {
      errors.push(`invalid scene ${sceneId}: ${(error as Error).message}`);
    }
  }
  for (const [sceneId, entry] of Object.entries(index.sceneIndex ?? {})) {
    if (!entry.e) continue;
    for (const value of Object.values(entry.e)) if (!Number.isInteger(value) || value < 0) errors.push(`invalid entrypoint in ${sceneId}`);
  }

  const files = await walkFiles(out);
  const deployment = files.filter((file) => file.relative !== MARKER && file.relative !== "report.json");
  const bytes = deployment.reduce((sum, file) => sum + file.size, 0);
  console.log(`Checked ${indexFiles.length} index file(s), ${Object.keys(index.assets ?? {}).length} assets, ${scenes} scenes`);
  console.log(`  packed refs ${packedRanges} in ${packHashes.size} archives; plain assets ${plainAssets}`);
  console.log(`  deployment ${deployment.length} objects, ${human(bytes)}`);
  if (errors.length) {
    console.error(`FAIL: ${errors.length} problem(s)`);
    for (const error of errors.slice(0, 50)) console.error(`  - ${error}`);
    if (errors.length > 50) console.error(`  ... ${errors.length - 50} more`);
    process.exitCode = 1;
  } else {
    console.log("PASS: all packed ranges, scene files, and plain assets resolve.");
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.check) await check(options);
else await build(options);
