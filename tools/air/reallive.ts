export type RealLiveHeader = {
  compilerVersion: number;
  dataOffset: number;
  uncompressedSize: number;
  compressedSize?: number;
  entryPoints: number[];
};

// RealLive's archive mask is part of the file format, not game content.
const REAL_LIVE_XOR_MASK = Uint8Array.from([
  0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x5f, 0x5e, 0x33,
  0xc0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0x8b, 0x55, 0xec,
  0x83, 0xc2, 0x20, 0x52, 0x6a, 0x00, 0xe8, 0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x08, 0x89, 0x45,
  0x0c, 0x8b, 0x45, 0xe4, 0x6a, 0x00, 0x6a, 0x00, 0x50, 0x53, 0xff, 0x15, 0x34, 0xb1, 0x43, 0x00,
  0x8b, 0x45, 0x10, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4d, 0xec, 0x89, 0x08, 0x8a, 0x45, 0xf0, 0x84,
  0xc0, 0x75, 0x78, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x8b, 0x7d, 0xe8, 0x8b, 0x75, 0x0c, 0x85, 0xc0,
  0x75, 0x44, 0x8b, 0x1d, 0xd0, 0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x37, 0x81, 0xff, 0x00, 0x00,
  0x04, 0x00, 0x6a, 0x00, 0x76, 0x43, 0x8b, 0x45, 0xf8, 0x8d, 0x55, 0xfc, 0x52, 0x68, 0x00, 0x00,
  0x04, 0x00, 0x56, 0x50, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0x6a, 0x05, 0xff, 0xd3, 0xa1, 0xe0,
  0x30, 0x44, 0x00, 0x81, 0xef, 0x00, 0x00, 0x04, 0x00, 0x81, 0xc6, 0x00, 0x00, 0x04, 0x00, 0x85,
  0xc0, 0x74, 0xc5, 0x8b, 0x5d, 0xf8, 0x53, 0xe8, 0xf4, 0xfb, 0xff, 0xff, 0x8b, 0x45, 0x0c, 0x83,
  0xc4, 0x04, 0x5f, 0x5e, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x55, 0xf8, 0x8d, 0x4d, 0xfc, 0x51,
  0x57, 0x56, 0x52, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0xeb, 0xd8, 0x8b, 0x45, 0xe8, 0x83, 0xc0,
  0x20, 0x50, 0x6a, 0x00, 0xe8, 0x47, 0x28, 0x01, 0x00, 0x8b, 0x7d, 0xe8, 0x89, 0x45, 0xf4, 0x8b,
  0xf0, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x56, 0x8b, 0x1d, 0xd0,
  0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x49, 0x81, 0xff, 0x00, 0x00, 0x04, 0x00, 0x6a, 0x00, 0x76,
]);

function need(buffer: Uint8Array, offset: number, size: number, label: string) {
  if (offset < 0 || size < 0 || offset + size > buffer.length) throw new Error(`${label} exceeds scene bounds at ${offset}+${size}`);
}

function u16(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 2, "RealLive u16");
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function i32(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 4, "RealLive i32");
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) | 0;
}

function u32(buffer: Uint8Array, offset: number): number {
  return i32(buffer, offset) >>> 0;
}

export function readRealLiveHeader(buffer: Uint8Array): RealLiveHeader {
  need(buffer, 0, 0x34 + 100 * 4, "RealLive header");
  const magic = Buffer.from(buffer.subarray(0, 4)).toString("latin1");
  if (magic !== "\xd0\x01\x00\x00" && magic !== "KPRL" && magic !== "RDRL" && magic !== "KPRM" && magic !== "RDRM") throw new Error(`Unsupported RealLive scene magic ${JSON.stringify(magic)}`);
  const compilerVersion = u32(buffer, 4);
  if (compilerVersion !== 10002 && compilerVersion !== 110002) throw new Error(`Unsupported RealLive compiler version ${compilerVersion}`);
  const dataOffset = u32(buffer, 0x20);
  const uncompressedSize = u32(buffer, 0x24);
  const compressedSize = u32(buffer, 0x28);
  need(buffer, dataOffset, compressedSize || uncompressedSize, "RealLive data");
  const entryPoints = Array.from({ length: 100 }, (_, index) => i32(buffer, 0x34 + index * 4));
  return { compilerVersion, dataOffset, uncompressedSize, compressedSize: compressedSize || undefined, entryPoints };
}

export function decompressRealLiveScene(scene: Uint8Array): { data: Uint8Array; header: RealLiveHeader } {
  const header = readRealLiveHeader(scene);
  if (!header.compressedSize) {
    const data = scene.slice(0, header.dataOffset + header.uncompressedSize);
    return { data, header };
  }
  const source = scene.slice(header.dataOffset, header.dataOffset + header.compressedSize);
  for (let index = 0; index < source.length; index += 1) source[index] ^= REAL_LIVE_XOR_MASK[index % REAL_LIVE_XOR_MASK.length];
  need(source, 8, 1, "RealLive compressed stream");
  const data = new Uint8Array(header.dataOffset + header.uncompressedSize);
  data.set(scene.subarray(0, header.dataOffset), 0);
  let sourceOffset = 9;
  let outputOffset = header.dataOffset;
  let bit = 1;
  let flags = source[8];
  while (sourceOffset < source.length && outputOffset < data.length) {
    if (bit === 0x100) {
      bit = 1;
      need(source, sourceOffset, 1, "RealLive flag byte");
      flags = source[sourceOffset++];
    }
    if ((flags & bit) !== 0) {
      need(source, sourceOffset, 1, "RealLive literal");
      data[outputOffset++] = source[sourceOffset++];
    } else {
      need(source, sourceOffset, 2, "RealLive back-reference");
      const token = source[sourceOffset] | (source[sourceOffset + 1] << 8);
      sourceOffset += 2;
      const distance = token >> 4;
      const count = (token & 0x0f) + 2;
      const reference = outputOffset - distance;
      if (distance <= 0 || reference < header.dataOffset || reference >= outputOffset) throw new Error(`Invalid RealLive back-reference distance ${distance}`);
      if (outputOffset + count > data.length) throw new Error("RealLive back-reference overruns output");
      for (let index = 0; index < count; index += 1) data[outputOffset++] = data[reference + index];
    }
    bit <<= 1;
  }
  if (outputOffset !== data.length) throw new Error(`RealLive decompression produced ${outputOffset - header.dataOffset} bytes, expected ${header.uncompressedSize}`);
  return { data, header };
}

export function decodeShiftJis(buffer: Uint8Array): string {
  return new TextDecoder("shift_jis").decode(buffer);
}

export type ExtractedSceneText = {
  offset: number;
  text: string;
  speaker?: string;
};

export type ExtractedSceneVoice = {
  offset: number;
  index: number;
};

export type ExtractedSceneResource = {
  offset: number;
  name: string;
};

export type ExtractedSceneControl = {
  offset: number;
  kind: "choice" | "jump" | "end";
  functionId: number;
  optionCount?: number;
  targetOffset?: number;
  targetOffsets?: number[];
};

export type ExtractedSceneJump = {
  offset: number;
  scene: number;
};

function cleanControlText(value: string): string {
  return value.replace(/[\u0000\u0002-\u0008\u000b-\u001f]/g, "").replaceAll("\\n", "\n").trim();
}

function extractDialogue(value: string): ExtractedSceneText | undefined {
  const speakerStart = value.indexOf("\u0001");
  const speakerEnd = speakerStart >= 0 ? value.indexOf("\u0002", speakerStart + 1) : -1;
  if (speakerStart >= 0 && speakerEnd > speakerStart) {
    const speaker = cleanControlText(value.slice(speakerStart + 1, speakerEnd));
    const text = cleanControlText(value.slice(speakerEnd + 1));
    return text ? { offset: 0, text, speaker: speaker || undefined } : undefined;
  }
  const text = cleanControlText(value);
  return text ? { offset: 0, text } : undefined;
}

export function extractRealLiveTexts(data: Uint8Array, header: RealLiveHeader): ExtractedSceneText[] {
  const body = data.subarray(header.dataOffset);
  const texts: ExtractedSceneText[] = [];
  for (let position = 1; position < body.length; position += 1) {
    if (body[position] !== 0x22 || body[position - 1] !== 0x5d) continue;
    let end = position + 1;
    while (end < body.length && body[end] !== 0x22) end += 1;
    if (end >= body.length) continue;
    const extracted = extractDialogue(decodeShiftJis(body.subarray(position + 1, end)));
    const isEngineDiagnostic = extracted && /^(?:Error:|\.?\s*Unable to format text\.)$/i.test(extracted.text);
    if (extracted && !isEngineDiagnostic && extracted.text.length <= 2000 && !/^\.+$/.test(extracted.text)) {
      texts.push({ ...extracted, offset: header.dataOffset + position });
    }
    position = end;
  }
  return texts;
}

/**
 * AIR stores voice references as a normal RealLive Koe call. The argument is
 * an integer archive key and the corresponding resource is named
 * Z#########.ogg. This deliberately exposes format data rather than copying
 * any interpreter implementation.
 */
export function extractRealLiveVoices(data: Uint8Array, header: RealLiveHeader): ExtractedSceneVoice[] {
  const body = data.subarray(header.dataOffset);
  const voices: ExtractedSceneVoice[] = [];
  for (let position = 0; position + 14 < body.length; position += 1) {
    if (body[position] !== 0x23 || body[position + 2] !== 0x17) continue;
    const functionId = u16(body, position + 3);
    const argc = u16(body, position + 5);
    if (![0, 1, 7, 8, 9, 10].includes(functionId) || argc < 1) continue;
    // The AIR voice calls use the common ($ \xff <int32>) expression form.
    if (body[position + 8] !== 0x28 || body[position + 9] !== 0x24 || body[position + 10] !== 0xff) continue;
    const index = u32(body, position + 11);
    voices.push({ offset: header.dataOffset + position, index });
  }
  return voices;
}

/** Extract resource basenames that are present in a scene's binary strings. */
export function extractRealLiveResources(data: Uint8Array, header: RealLiveHeader, names: string[]): ExtractedSceneResource[] {
  const body = data.subarray(header.dataOffset);
  const latin1 = Buffer.from(body).toString("latin1").toUpperCase();
  const resources: ExtractedSceneResource[] = [];
  const knownNames = new Set(names.map((name) => name.toUpperCase()));
  // Resource names are ASCII tokens in RealLive arguments. Scanning tokens
  // once keeps preparation linear in scene size even with AIR's large image
  // manifest.
  const tokenPattern = /[A-Z][A-Z0-9_]*/g;
  for (let match = tokenPattern.exec(latin1); match; match = tokenPattern.exec(latin1)) {
    if (knownNames.has(match[0])) resources.push({ offset: header.dataOffset + match.index, name: match[0] });
  }
  return resources.sort((a, b) => a.offset - b.offset);
}

function skipDelimited(body: Uint8Array, cursor: number, open: number, close: number): number {
  if (body[cursor] !== open) return cursor;
  let depth = 0;
  for (let position = cursor; position < body.length; position += 1) {
    if (body[position] === open && body[position - 1] !== 0x5c) depth += 1;
    else if (body[position] === close && --depth === 0) return position + 1;
  }
  return body.length;
}

/**
 * Locate AIR's control calls without interpreting unrelated engine modules.
 * Jump labels are data-relative, matching the entry-point offsets in the
 * RealLive header. Selection target labels are collected from the nearby
 * conditional branches and resolved to generated instruction indices later.
 */
export function extractRealLiveControls(data: Uint8Array, header: RealLiveHeader): ExtractedSceneControl[] {
  const body = data.subarray(header.dataOffset);
  const controls: ExtractedSceneControl[] = [];
  for (let position = 0; position + 7 < body.length; position += 1) {
    if (body[position] !== 0x23) continue;
    const module = body[position + 2];
    const functionId = u16(body, position + 3);
    const argc = u16(body, position + 5);
    const isSelection = module === 0x02 && [0, 1, 2, 3, 10, 11, 12, 13].includes(functionId);
    if (isSelection && argc > 0 && argc <= 16) {
      controls.push({ offset: header.dataOffset + position, kind: "choice", functionId, optionCount: argc });
      continue;
    }
    if (module === 0x04 && functionId === 1200) {
      controls.push({ offset: header.dataOffset + position, kind: "end", functionId });
      continue;
    }
    if (module !== 0x01 && module !== 0x05) continue;
    let cursor = position + 8;
    if (body[cursor] === 0x28) cursor = skipDelimited(body, cursor, 0x28, 0x29);
    else if (body[cursor] === 0x7b) cursor = skipDelimited(body, cursor, 0x7b, 0x7d);
    // 11+ are cross-scenario jump/call/return operations, not local labels.
    const isJump = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(functionId);
    if (!isJump || cursor + 4 > body.length) continue;
    const rawTarget = u32(body, cursor);
    if (rawTarget >= body.length || rawTarget === 0xffffffff) continue;
    controls.push({ offset: header.dataOffset + position, kind: "jump", functionId, targetOffset: header.dataOffset + rawTarget });
  }
  for (const choice of controls.filter((control) => control.kind === "choice")) {
    const targets: number[] = [];
    let branchCheckOffset = choice.offset;
    for (let option = 0; option < (choice.optionCount ?? 0); option += 1) {
      // RealLive compiles a selection into a ladder of goto_unless checks.
      // Fall-through is the selected branch and the target is the next check.
      const branchCheck = controls.find((control) =>
        control.kind === "jump"
        && control.functionId === 2
        && control.offset >= branchCheckOffset
        && control.offset - branchCheckOffset <= 256
        && control.targetOffset !== undefined
      );
      if (!branchCheck?.targetOffset) break;
      targets.push(branchCheck.offset + 1);
      branchCheckOffset = branchCheck.targetOffset;
    }
    choice.targetOffsets = targets;
  }
  return controls.sort((a, b) => a.offset - b.offset);
}

/** Locate RealLive jump(scenario) calls used by AIR's title/menu bootstrap. */
export function extractRealLiveSceneJumps(data: Uint8Array, header: RealLiveHeader): ExtractedSceneJump[] {
  const body = data.subarray(header.dataOffset);
  const jumps: ExtractedSceneJump[] = [];
  for (let position = 0; position + 16 < body.length; position += 1) {
    if (body[position] !== 0x23 || body[position + 2] !== 0x01 || u16(body, position + 3) !== 11) continue;
    // AIR encodes the scenario argument as ($ \xff <int32>).
    if (body[position + 8] !== 0x28 || body[position + 9] !== 0x24 || body[position + 10] !== 0xff) continue;
    const scene = u32(body, position + 11);
    if (scene <= 9999) jumps.push({ offset: header.dataOffset + position, scene });
  }
  return jumps;
}

export function extractRealLiveTitle(data: Uint8Array, header: RealLiveHeader): string | undefined {
  const body = data.subarray(header.dataOffset);
  for (let position = 1; position < body.length; position += 1) {
    if (body[position] !== 0x22 || body[position - 1] !== 0x28) continue;
    let end = position + 1;
    while (end < body.length && body[end] !== 0x22) end += 1;
    if (end >= body.length) continue;
    const title = cleanControlText(decodeShiftJis(body.subarray(position + 1, end)));
    if (title) return title;
  }
  return undefined;
}
