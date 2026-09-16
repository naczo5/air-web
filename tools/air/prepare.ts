import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeG00, decodeNwaToWav, decodePdt, encodePngRgba, fileSummary, parseCgmTable, parseGameIni, readSeenEntry, readSeenIndex } from "./formats";
import { decompressRealLiveScene, extractRealLiveControls, extractRealLiveResources, extractRealLiveSceneJumps, extractRealLiveTexts, extractRealLiveTitle, extractRealLiveVoices } from "./reallive";
import { imageLayerForResource } from "./resourceRoles";
import { parseRealLiveBytecode } from "./bytecode";
import type { AssetManifest, FlowchartManifest, GameManifest, SceneProgram } from "../../src/types";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(projectRoot, "AIR_SE");
const outputRoot = path.join(projectRoot, ".air-web-assets");

function assetId(prefix: string, relative: string): string {
  return `${prefix}:${relative.replaceAll("\\", "/").replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function outputName(relative: string, extension: string): string {
  return `${relative.replaceAll("\\", "__").replaceAll("/", "__").replaceAll(/[^a-zA-Z0-9_.-]/g, "_").replace(/\.[^.]+$/, "")}.${extension}`;
}

function sourceBasename(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return path.basename(source).replace(/\.[^.]+$/, "").toUpperCase();
}

async function writeIfMissing(filename: string, data: Uint8Array | Buffer) {
  if (!fs.existsSync(filename)) await fsp.writeFile(filename, data);
}

async function copyIfMissing(source: string, target: string) {
  if (!fs.existsSync(target)) await fsp.copyFile(source, target);
}

async function main() {
  if (!fs.existsSync(sourceRoot)) throw new Error(`AIR source directory not found: ${sourceRoot}`);
  const seenPath = path.join(sourceRoot, "SEEN.txt");
  const seen = new Uint8Array(await fsp.readFile(seenPath));
  const seenEntries = readSeenIndex(seen);
  const decodedScenes = new Map<number, ReturnType<typeof decompressRealLiveScene>>();
  const sceneReports = seenEntries.map((entry) => {
    const decoded = decompressRealLiveScene(readSeenEntry(seen, entry));
    decodedScenes.set(entry.scene, decoded);
    return { scene: entry.scene, compressedBytes: entry.length, decompressedBytes: decoded.data.length, compilerVersion: decoded.header.compilerVersion, entryPoints: decoded.header.entryPoints.filter((point) => point >= 0) };
  });
  const ini = parseGameIni(await fsp.readFile(path.join(sourceRoot, "GAMEEXE.INI"), "latin1"));
  const files = fileSummary(sourceRoot);
  const assets: AssetManifest = {};

  if (process.env.AIR_PREPARE_CLEAN === "1") throw new Error("Automatic asset deletion is disabled. Use a separate checkout for a clean conversion.");
  await Promise.all([
    fsp.mkdir(path.join(outputRoot, "images"), { recursive: true }),
    fsp.mkdir(path.join(outputRoot, "audio"), { recursive: true }),
    fsp.mkdir(path.join(outputRoot, "voices"), { recursive: true }),
  ]);

  for (const file of files) {
    const relative = file.relative;
    const lower = relative.toLowerCase();
    const sourcePath = path.join(sourceRoot, relative);
    if (lower.endsWith(".g00")) {
      const image = decodeG00(new Uint8Array(await fsp.readFile(sourcePath)));
      const filename = outputName(relative, "png");
      const id = assetId("image", relative);
      await writeIfMissing(path.join(outputRoot, "images", filename), encodePngRgba(image));
      assets[id] = { id, kind: "image", url: `/images/${filename}`, width: image.width, height: image.height, codec: "png", source: relative };
      continue;
    }
    if (lower.endsWith(".pdt")) {
      const image = decodePdt(new Uint8Array(await fsp.readFile(sourcePath)));
      const filename = outputName(relative, "png");
      const id = assetId("image", relative);
      await writeIfMissing(path.join(outputRoot, "images", filename), encodePngRgba(image));
      assets[id] = { id, kind: "image", url: `/images/${filename}`, width: image.width, height: image.height, codec: "png", source: relative };
      continue;
    }
    if (lower.endsWith(".nwa")) {
      const decoded = decodeNwaToWav(new Uint8Array(await fsp.readFile(sourcePath)));
      const filename = outputName(relative, "wav");
      const id = assetId("audio", relative);
      await writeIfMissing(path.join(outputRoot, "audio", filename), decoded.wav);
      const durationMs = Math.round((decoded.info.dataSize / (decoded.info.channels * (decoded.info.bitsPerSample / 8) * decoded.info.sampleRate)) * 1000);
      assets[id] = { id, kind: "audio", url: `/audio/${filename}`, durationMs, loop: true, codec: "wav", source: relative };
      continue;
    }
    if (lower.endsWith(".ogg")) {
      const filename = outputName(relative, "ogg");
      const id = assetId("voice", relative);
      await copyIfMissing(sourcePath, path.join(outputRoot, "voices", filename));
      assets[id] = { id, kind: "voice", url: `/voices/${filename}`, codec: "ogg", source: relative };
      continue;
    }
    if (lower.endsWith(".wav")) {
      const filename = outputName(relative, "wav");
      const id = assetId("effect", relative);
      await copyIfMissing(sourcePath, path.join(outputRoot, "audio", filename));
      assets[id] = { id, kind: "audio", url: `/audio/${filename}`, codec: "wav", source: relative };
      continue;
    }
    // SYS/*.jpg belongs to the patch's HTML/manual UI. It is not a RealLive
    // story layer and must never enter the scene renderer or CG gallery.
  }

  const scenes: Record<string, SceneProgram> = {};
  const flowchart: FlowchartManifest = { nodes: [], edges: [] };
  const startScene = Number.parseInt((ini.SEEN_START ?? "9030").replace(/[^0-9]/g, ""), 10) || 9030;
  const sceneJumpMap = new Map<number, number[]>();
  for (const entry of seenEntries) {
    const decoded = decodedScenes.get(entry.scene);
    if (decoded) sceneJumpMap.set(entry.scene, extractRealLiveSceneJumps(decoded.data, decoded.header).map((jump) => jump.scene));
  }
  const findInitialStoryScene = (): number => {
    const queue = [startScene];
    const visited = new Set<number>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const target of sceneJumpMap.get(current) ?? []) {
        if (target > 0 && target < 9000 && decodedScenes.has(target)) return target;
        if (target >= 9000 && decodedScenes.has(target) && !visited.has(target)) queue.push(target);
      }
    }
    const fallback = seenEntries.find((entry) => entry.scene > 0 && entry.scene < 9000)?.scene;
    if (fallback === undefined) throw new Error("Unable to locate AIR's initial story scene from the title bootstrap");
    return fallback;
  };
  const initialStoryScene = findInitialStoryScene();
  const resourceNames = Object.values(assets).flatMap((asset) => {
    const name = sourceBasename(asset.source);
    return name ? [name] : [];
  });
  const assetsByBasename = new Map<string, AssetManifest[string]>();
  for (const asset of Object.values(assets)) {
    const name = sourceBasename(asset.source);
    if (name && !assetsByBasename.has(name)) assetsByBasename.set(name, asset);
  }
  const assetAliases = Object.fromEntries([...assetsByBasename].map(([name, asset]) => [name, asset.id]));
  const cgmPath = path.join(sourceRoot, "DAT", "mode.cgm");
  const galleryAssets = fs.existsSync(cgmPath)
    ? parseCgmTable(new Uint8Array(await fsp.readFile(cgmPath)))
      .flatMap(({ name }) => {
        const asset = assetsByBasename.get(name.replace(/\.[^.]+$/, "").toUpperCase());
        return asset ? [asset.id] : [];
      })
    : [];
  for (const entry of seenEntries) {
    const decoded = decodedScenes.get(entry.scene);
    if (!decoded) throw new Error(`Scene ${entry.scene} was not decoded`);
    const sceneId = `seen${entry.scene.toString().padStart(4, "0")}`;
    const parsed = parseRealLiveBytecode(decoded.data, decoded.header);
    const instructions: SceneProgram["instructions"] = [...parsed.instructions, { op: "end" as const }];
    scenes[sceneId] = {
      id: sceneId,
      title: extractRealLiveTitle(decoded.data, decoded.header) ?? `SEEN ${entry.scene}`,
      instructions,
      entrypoints: parsed.entrypoints,
    };
    const sceneNodeId = `${sceneId}:scene`;
    flowchart.nodes.push({ id: sceneNodeId, sceneId, instruction: 0, label: scenes[sceneId].title ?? sceneId });
    const localStrings = new Map<string, string>();
    instructions.forEach((instruction, instructionIndex) => {
      if (instruction.op === "command" && instruction.moduleType === 1 && instruction.module === 10 && instruction.opcode === 0) {
        const dest = instruction.args[0];
        if (dest?.kind === "expression" && dest.value?.kind === "memory") {
          const bank = dest.value.bank;
          const idx = dest.value.index?.kind === "int" ? dest.value.index.value : -1;
          const val = instruction.args[1]?.kind === "string" ? instruction.args[1].value : "";
          if (bank >= 0 && idx >= 0 && val) localStrings.set(`${bank}:${idx}`, val);
        }
      }
      if (instruction.op !== "choice" && instruction.op !== "select") return;
      const choiceNodeId = `${sceneId}:choice:${instructionIndex}`;
      flowchart.nodes.push({ id: choiceNodeId, sceneId, instruction: instructionIndex, label: "CHOICE" });
      const optionsText = instruction.op === "choice"
        ? instruction.options.join(" / ")
        : instruction.options.map((option) => {
            if (option.text) return option.text;
            if (option.textExpression?.kind === "memory") {
              const bank = option.textExpression.bank;
              const idx = option.textExpression.index?.kind === "int" ? option.textExpression.index.value : -1;
              const resolved = localStrings.get(`${bank}:${idx}`);
              if (resolved) return resolved;
            }
            return "Option";
          }).join(" / ");
      flowchart.edges.push({ from: sceneNodeId, to: choiceNodeId, label: optionsText });
    });
  }

  if (!Object.keys(scenes).length) {
    scenes.demo = { id: "demo", title: "AIR", instructions: [{ op: "text", text: "AIR asset preparation completed, but no preview scene was generated." }, { op: "end" }] };
    flowchart.nodes.push({ id: "demo:0", sceneId: "demo", instruction: 0, label: "AIR" });
  }

  const manifest: GameManifest = {
    id: "air-se",
    title: "AIR",
    logicalSize: { width: 640, height: 480 },
    startScene: scenes[`seen${initialStoryScene.toString().padStart(4, "0")}`]?.id ?? Object.keys(scenes)[0],
    scenes,
    assets,
    assetAliases,
    galleryAssets,
    flowchart,
    generatedAt: new Date().toISOString(),
    sourceSummary: { fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), seenEntries: seenEntries.length },
  };

  const validationErrors: string[] = [];
  for (const scene of Object.values(manifest.scenes)) {
    scene.instructions.forEach((instruction, index) => {
      const location = `${scene.id}:${index}`;
      if ("asset" in instruction && typeof instruction.asset === "string" && !manifest.assets[instruction.asset]) {
        validationErrors.push(`${location} references missing asset ${instruction.asset}`);
      }
      if (instruction.op === "choice") {
        if (instruction.options.length !== instruction.targets.length) {
          validationErrors.push(`${location} has ${instruction.options.length} options but ${instruction.targets.length} targets`);
        }
        instruction.targets.forEach((target) => {
          if (!Number.isInteger(target) || target < 0 || target >= scene.instructions.length) {
            validationErrors.push(`${location} has invalid choice target ${target}`);
          }
        });
      }
      if (instruction.op === "jump" && (!Number.isInteger(instruction.target) || instruction.target < 0 || instruction.target >= scene.instructions.length)) {
        validationErrors.push(`${location} has invalid jump target ${instruction.target}`);
      }
      if (instruction.op === "scene" && !manifest.scenes[instruction.sceneId]) {
        validationErrors.push(`${location} references missing scene ${instruction.sceneId}`);
      }
      if (instruction.op === "text" && /^(?:Error:|\.?\s*Unable to format text\.)$/i.test(instruction.text)) {
        validationErrors.push(`${location} exposes an internal engine diagnostic as dialogue`);
      }
      if (instruction.op === "image") {
        const name = sourceBasename(manifest.assets[instruction.asset]?.source);
        if (name?.startsWith("CG") && instruction.layer !== 1) {
          validationErrors.push(`${location} places character sprite ${name} on background layer ${instruction.layer}`);
        }
      }
    });
  }
  if (validationErrors.length) {
    throw new Error(`AIR manifest validation failed:\n${validationErrors.slice(0, 50).join("\n")}`);
  }

  await fsp.writeFile(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest));
  await fsp.writeFile(path.join(outputRoot, "asset-report.json"), JSON.stringify({ sourceRoot, ini, initialStoryScene, seenEntries, sceneReports, files, note: "All SEEN entries are validated and decompressed for the local runtime; G00/PDT images and NWA audio are normalized into browser assets. Original source files are not published." }, null, 2));
  console.log(`Prepared AIR assets: ${seenEntries.length} SEEN entries, ${files.length} source files, ${Object.keys(assets).length} browser-addressable assets.`);
  console.log(`Generated ${path.relative(projectRoot, outputRoot)}/manifest.json`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
