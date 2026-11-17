/**
 * Look ahead in a prepared scene and report the assets it will need soon.
 *
 * Prepared scenes ship as raw RealLive bytecode, so there are no `image` or
 * voiced-`text` ops to inspect. The assets are named inside commands:
 *
 *   - backdrops: `1:40:100 (<name> | $18[1000], ...)`
 *   - plate draws: `1:72:1000 (<slot>, <name>)`
 *   - voices: `1:23:<0|1|7|8|9|10> (<Z-number>)`
 *   - music / effects: `1:20:0|2`, `1:21:*`, `1:22:*`
 *
 * This resolves those against `assetAliases` and returns manifest asset ids.
 * It is intentionally branch-blind: it may warm an asset on a path the player
 * does not take (one small range request wasted) rather than miss one (a visible
 * stall). It is pure, so the behaviour is unit-testable against real data.
 */

import type { SceneProgram } from "../types";

export type Lookahead = { images: string[]; audio: string[] };

export type LookaheadOptions = {
  /** How many instructions to scan. */
  lookahead?: number;
  /** Per-kind caps, so a dense command block cannot flood the network. */
  maxImages?: number;
  maxAudio?: number;
  /** String cells available to resolve `$18[1000]`-style backdrop names. */
  stringMemory?: Record<string, string>;
  /** Resolve a resource name to a manifest asset id. */
  resolve: (name: string) => string | undefined;
};

/**
 * How far to look for the next backdrop.
 *
 * Backdrops are the expensive asset (~170 KB median, up to ~940 KB) and they are
 * spaced 35-280 instructions apart, so a window sized for voices misses most of
 * them. Scanning further ahead only costs string comparisons: the scan is pure
 * and never issues a request on its own.
 */
const BACKDROP_LOOKAHEAD = 400;

/** First backdrop the stream will draw, searching well past the voice window. */
function nextBackdrop(scene: SceneProgram, instructionPointer: number, options: LookaheadOptions): string | undefined {
  const end = Math.min(scene.instructions.length, instructionPointer + BACKDROP_LOOKAHEAD);
  let backdropCell: string | undefined;
  for (let index = instructionPointer; index < end; index += 1) {
    const instruction = scene.instructions[index];
    if (!instruction || instruction.op !== "command" || instruction.moduleType !== 1) continue;
    const { module: commandModule, opcode, args } = instruction;

    // Backdrop set by literal filename on a background slot. This is the most
    // common way a backdrop changes (1,446 sites: `1:33:73` 952, `1:33:1053`
    // 374, `1:33:75` 63, `1:33:74` 57) and the `1:40:100` path below never sees
    // it, so without this branch most backdrop changes are invisible here.
    if (commandModule === 33 && [73, 74, 75, 1053, 1054, 1055, 1057].includes(opcode)) {
      const name = args?.[0];
      const slot = args?.[1]?.kind === "expression" && args[1].value?.kind === "int" ? args[1].value.value : undefined;
      // Slots 0-3 are backgrounds; 4+ are character sprites.
      if (name?.kind === "string" && slot !== undefined && slot <= 3) {
        const asset = options.resolve(name.value);
        if (asset) return asset;
      }
      continue;
    }

    // Track the backdrop cell as the script reassigns it; the draw below reads
    // whatever the most recent assignment left there, exactly like execution.
    if (commandModule === 10 && opcode === 0) {
      const dest = args?.[0];
      if (dest?.kind === "expression" && dest.value?.kind === "memory" && dest.value.bank === 18
        && dest.value.index?.kind === "int" && dest.value.index.value === 1000) {
        const value = args?.[1];
        backdropCell = value?.kind === "string" ? value.value : undefined;
      }
      continue;
    }
    if (commandModule === 40 && opcode === 100) {
      const first = args?.[0];
      const literal = first?.kind === "string" ? first.value : undefined;
      // The live cell holds the backdrop that is ALREADY on screen; the
      // assignment ahead of us in this scan is the one about to be drawn.
      // Preferring the live value warmed the current image 91% of the time
      // (measured 9.3% correct), so the tracked assignment wins.
      const fromMemory = first?.kind === "expression" && first.value?.kind === "memory"
        ? options.stringMemory?.[`${first.value.bank}:${first.value.index?.kind === "int" ? first.value.index.value : -1}`]
        : undefined;
      const name = literal ?? backdropCell ?? fromMemory;
      const asset = name ? options.resolve(name) : undefined;
      if (asset) return asset;
    }
  }
  return undefined;
}

/** Asset ids the instruction stream will draw or play within `lookahead`. */
export function lookaheadAssets(scene: SceneProgram, instructionPointer: number, options: LookaheadOptions): Lookahead {
  // A dialogue block is `1:23` + `1:10:100` + `1:10:0` + gosub + flush, i.e.
  // roughly 5 instructions per line, so 40 instructions look only ~8 lines
  // ahead. Voice requests that arrive 8 lines late are still on-demand by the
  // time the player reaches them, so the window is sized in lines.
  // Scan far enough to actually find dialogue. A dialogue block is ~5
  // instructions, but scenes are dense with branches/assigns, so a
  // 160-instruction window yields only 4-10 voices. Scanning is pure string
  // comparison — no requests — so the limit that matters is the *found* cap.
  const lookahead = options.lookahead ?? 900;
  const maxImages = options.maxImages ?? 5;
  // A hint fires on every text pause, so this cap is the depth of the read
  // buffer. It was 48 (~1 MB, ~5 s of lead time on a slow uplink), but that
  // much queued per hint starves the request the *current* line needs and
  // thrashes the resolver's LRU. 12 is ~270 KB / ~1.5 s: still ahead of a
  // reading player, small enough that the queue drains between lines.
  const maxAudio = options.maxAudio ?? 12;
  const images: string[] = [];
  const audio: string[] = [];
  const end = Math.min(scene.instructions.length, instructionPointer + lookahead);

  const pushImage = (name: string | undefined) => {
    if (!name || images.length >= maxImages) return;
    const asset = options.resolve(name);
    if (asset) images.push(asset);
  };
  const pushAudio = (name: string | undefined) => {
    if (!name || audio.length >= maxAudio) return;
    const asset = options.resolve(name);
    if (asset) audio.push(asset);
  };

  for (let index = instructionPointer; index < end; index += 1) {
    const instruction = scene.instructions[index];
    if (!instruction || instruction.op !== "command" || instruction.moduleType !== 1) continue;
    const { module: commandModule, opcode, args } = instruction;

    if (commandModule === 23 && [0, 1, 7, 8, 9, 10].includes(opcode)) {
      const slot = args?.[0];
      const number = slot?.kind === "expression" && slot.value?.kind === "int" ? slot.value.value : undefined;
      if (typeof number === "number") pushAudio(`Z${number.toString().padStart(9, "0")}`);
      continue;
    }
    if (commandModule === 20 && (opcode === 0 || opcode === 2)) {
      if (args?.[0]?.kind === "string") pushAudio(args[0].value);
      continue;
    }
    if ((commandModule === 21 || commandModule === 22) && args?.[0]?.kind === "string") {
      pushAudio(args[0].value);
      continue;
    }
    if (commandModule === 40 && opcode === 100 && args?.length) {
      const first = args[0];
      if (first.kind === "string") {
        pushImage(first.value);
      } else if (first.kind === "expression" && first.value?.kind === "memory") {
        const cell = first.value;
        const indexValue = cell.index?.kind === "int" ? cell.index.value : undefined;
        if (typeof indexValue === "number") pushImage(options.stringMemory?.[`${cell.bank}:${indexValue}`]);
      }
      continue;
    }
    if (commandModule === 72 && opcode === 1000 && args?.[1]?.kind === "string") {
      pushImage(args[1].value);
    }
  }

  return { images: [...new Set(images)], audio: [...new Set(audio)] };
}

/**
 * The backdrop the stream will draw next, plus the voices in the short window.
 *
 * Used by the prefetch pass: the backdrop is warmed from a wide scan because a
 * scene change needs it before anything can be drawn, while voices are warmed
 * from the near window because they are small and numerous.
 */
export function lookaheadWithBackdrop(scene: SceneProgram, instructionPointer: number, options: LookaheadOptions): Lookahead {
  const near = lookaheadAssets(scene, instructionPointer, options);
  const backdrop = nextBackdrop(scene, instructionPointer, options);
  if (!backdrop || near.images.includes(backdrop)) return near;
  return { images: [backdrop, ...near.images].slice(0, (options.maxImages ?? 5)), audio: near.audio };
}
