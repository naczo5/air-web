import { decodeShiftJis, type RealLiveHeader } from "./reallive";
import type { DataValue, RealLiveExpression, RealLiveInstruction } from "../../src/types";

const need = (buffer: Uint8Array, offset: number, size: number, label: string) => {
  if (offset < 0 || size < 0 || offset + size > buffer.length) {
    throw new Error(`${label} exceeds bytecode bounds at ${offset}+${size}`);
  }
};

const i16 = (buffer: Uint8Array, offset: number): number => {
  need(buffer, offset, 2, "i16");
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt16(offset, true);
};

const i32 = (buffer: Uint8Array, offset: number): number => {
  need(buffer, offset, 4, "i32");
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(offset, true);
};

const isShiftJisLead = (value: number) => (value >= 0x81 && value <= 0x9f) || (value >= 0xe0 && value <= 0xef);
const isStringByte = (value: number) =>
  isShiftJisLead(value)
  || (value >= 0x41 && value <= 0x5a)
  || (value >= 0x30 && value <= 0x39)
  || value === 0x20
  || value === 0x3f
  || value === 0x5f
  || value === 0x22
  || value === 0x5c;
const startsAscii = (cursor: Cursor, value: string) =>
  value.split("").every((character, index) => cursor.bytes[cursor.offset + index] === character.charCodeAt(0));

function parsePrint(cursor: Cursor): RealLiveExpression {
  if (!startsAscii(cursor, "###PRINT(")) throw new Error(`Expected ###PRINT at ${cursor.offset}`);
  cursor.offset += 9;
  const expression = parseExpression(cursor);
  cursor.expect(0x29, "###PRINT");
  return expression;
}

class Cursor {
  constructor(readonly bytes: Uint8Array, public offset = 0) {}

  get value() {
    need(this.bytes, this.offset, 1, "byte");
    return this.bytes[this.offset];
  }

  take() {
    const value = this.value;
    this.offset += 1;
    return value;
  }

  expect(value: number, label: string) {
    if (this.take() !== value) throw new Error(`${label} expected ${String.fromCharCode(value)} at ${this.offset - 1}`);
  }
}

function parseTerm(cursor: Cursor): RealLiveExpression {
  if (cursor.value === 0x24) {
    cursor.offset += 1;
    const token = cursor.take();
    if (token === 0xff) {
      const value = i32(cursor.bytes, cursor.offset);
      cursor.offset += 4;
      return { kind: "int", value };
    }
    if (token === 0xc8) return { kind: "store" };
    if (cursor.bytes[cursor.offset] !== 0x5b) throw new Error(`Invalid memory reference at ${cursor.offset - 1}`);
    cursor.offset += 1;
    const index = parseExpression(cursor);
    cursor.expect(0x5d, "memory reference");
    return { kind: "memory", bank: token, index };
  }
  if (cursor.value === 0x5c && cursor.bytes[cursor.offset + 1] === 0x00) {
    cursor.offset += 2;
    return parseTerm(cursor);
  }
  if (cursor.value === 0x5c && cursor.bytes[cursor.offset + 1] === 0x01) {
    cursor.offset += 2;
    return { kind: "unary", op: 0x01, value: parseTerm(cursor) };
  }
  if (cursor.value === 0x28) {
    cursor.offset += 1;
    const value = parseExpression(cursor);
    cursor.expect(0x29, "expression");
    return value;
  }
  throw new Error(`Unknown expression term 0x${cursor.value.toString(16)} at ${cursor.offset}`);
}

function parseBinary(
  cursor: Cursor,
  lower: () => RealLiveExpression,
  accepts: (op: number) => boolean,
): RealLiveExpression {
  let value = lower();
  while (cursor.value === 0x5c && accepts(cursor.bytes[cursor.offset + 1])) {
    cursor.offset += 1;
    const op = cursor.take();
    value = { kind: "binary", op, left: value, right: lower() };
  }
  return value;
}

function parseArithmetic(cursor: Cursor): RealLiveExpression {
  const high = () => parseBinary(cursor, () => parseTerm(cursor), (op) => op >= 0x02 && op <= 0x09);
  return parseBinary(cursor, high, (op) => op === 0x00 || op === 0x01);
}

function parseExpression(cursor: Cursor): RealLiveExpression {
  const condition = () => parseBinary(cursor, () => parseArithmetic(cursor), (op) => op >= 0x28 && op <= 0x2d);
  const and = () => parseBinary(cursor, condition, (op) => op === 0x3c);
  return parseBinary(cursor, and, (op) => op === 0x3d);
}

function parseAssignment(cursor: Cursor): RealLiveExpression {
  const left = parseTerm(cursor);
  cursor.expect(0x5c, "assignment");
  const op = cursor.take();
  if (op < 0x14 || op > 0x24) throw new Error(`Unknown assignment operator 0x${op.toString(16)}`);
  return { kind: "binary", op, left, right: parseExpression(cursor) };
}

function parseString(cursor: Cursor): string {
  const start = cursor.offset;
  let quoted = false;
  while (cursor.offset < cursor.bytes.length) {
    const value = cursor.value;
    if (quoted) {
      if (value === 0x22 && cursor.bytes[cursor.offset - 1] !== 0x5c) {
        cursor.offset += 1;
        break;
      }
    } else {
      if (value === 0x22) quoted = true;
      else if (!isStringByte(value)) break;
    }
    cursor.offset += isShiftJisLead(value) ? 2 : 1;
  }
  const raw = cursor.bytes.subarray(start, cursor.offset);
  const unquoted = raw[0] === 0x22 && raw.at(-1) === 0x22 ? raw.subarray(1, -1) : raw;
  return decodeShiftJis(unquoted).replaceAll('\\"', '"');
}

function parseData(cursor: Cursor): DataValue {
  if (cursor.value === 0x2c) {
    cursor.offset += 1;
    return parseData(cursor);
  }
  if (cursor.value === 0x0a) {
    cursor.offset += 3;
    return parseData(cursor);
  }
  if (startsAscii(cursor, "###PRINT(")) return { kind: "expression", value: parsePrint(cursor) };
  if (isStringByte(cursor.value)) return { kind: "string", value: parseString(cursor) };
  if (cursor.value === 0x61) {
    cursor.offset += 1;
    let tag = cursor.take();
    if (cursor.value === 0x61) {
      cursor.offset += 1;
      tag |= cursor.take() << 16;
    }
    const values: DataValue[] = [];
    if (cursor.bytes[cursor.offset] === 0x28) {
      cursor.offset += 1;
      while (cursor.bytes[cursor.offset] !== 0x29) values.push(parseData(cursor));
      cursor.offset += 1;
    } else {
      values.push(parseData(cursor));
    }
    return { kind: "special", tag, values };
  }
  if (cursor.value === 0x28) {
    cursor.offset += 1;
    const values: DataValue[] = [];
    while (cursor.bytes[cursor.offset] !== 0x29) values.push(parseData(cursor));
    cursor.offset += 1;
    return { kind: "complex", values };
  }
  return { kind: "expression", value: parseExpression(cursor) };
}

const commandIdentity = (bytes: Uint8Array, offset: number) => ({
  moduleType: bytes[offset + 1],
  module: bytes[offset + 2],
  opcode: bytes[offset + 3] | (bytes[offset + 4] << 8),
  argc: bytes[offset + 5] | (bytes[offset + 6] << 8),
  overload: bytes[offset + 7],
});

const commandKey = (identity: ReturnType<typeof commandIdentity>) =>
  (identity.moduleType << 24) | (identity.module << 16) | identity.opcode;

const unconditionalPointers = new Set([0x00010000, 0x00010005, 0x00050001, 0x00050005, 0x00060001, 0x00060005]);
const conditionalPointers = new Set([0x00010001, 0x00010002, 0x00010006, 0x00010007, 0x00050002, 0x00050006, 0x00050007, 0x00060000, 0x00060002, 0x00060006, 0x00060007]);
const tablePointers = new Set([0x00010003, 0x00010008, 0x00050003, 0x00050008, 0x00060003, 0x00060008]);
const casePointers = new Set([0x00010004, 0x00010009, 0x00050004, 0x00050009, 0x00060004, 0x00060009]);
const selectKeys = new Set([0x00020000, 0x00020001, 0x00020002, 0x00020003, 0x00020010, 0x00020011, 0x00020012, 0x00020013]);

function parseCommand(cursor: Cursor): RealLiveInstruction {
  const offset = cursor.offset;
  need(cursor.bytes, offset, 8, "command");
  const identity = commandIdentity(cursor.bytes, offset);
  const key = commandKey(identity);
  cursor.offset += 8;

  if (unconditionalPointers.has(key)) {
    const targetOffset = i32(cursor.bytes, cursor.offset);
    cursor.offset += 4;
    return { op: "branch", offset, ...identity, kind: identity.opcode === 5 ? "gosub" : "goto", targets: [targetOffset] };
  }
  if (conditionalPointers.has(key)) {
    cursor.expect(0x28, "conditional branch");
    const expression = parseExpression(cursor);
    cursor.expect(0x29, "conditional branch");
    const targetOffset = i32(cursor.bytes, cursor.offset);
    cursor.offset += 4;
    const isGosub = identity.opcode === 6 || identity.opcode === 7;
    const unless = identity.opcode === 2 || identity.opcode === 7 || (identity.module === 6 && identity.opcode === 2);
    return { op: "branch", offset, ...identity, kind: isGosub ? (unless ? "gosubUnless" : "gosubIf") : (unless ? "gotoUnless" : "gotoIf"), expression, targets: [targetOffset] };
  }
  if (tablePointers.has(key)) {
    const expression = parseExpression(cursor);
    cursor.expect(0x7b, "table branch");
    const targets = Array.from({ length: identity.argc }, () => {
      const target = i32(cursor.bytes, cursor.offset);
      cursor.offset += 4;
      return target;
    });
    cursor.expect(0x7d, "table branch");
    return { op: "branch", offset, ...identity, kind: identity.opcode === 8 ? "gosubOn" : "gotoOn", expression, targets };
  }
  if (casePointers.has(key)) {
    const expression = parseExpression(cursor);
    cursor.expect(0x7b, "case branch");
    const cases: Array<RealLiveExpression | undefined> = [];
    const targets: number[] = [];
    for (let index = 0; index < identity.argc; index += 1) {
      cursor.expect(0x28, "case");
      cases.push(cursor.value === 0x29 ? undefined : parseExpression(cursor));
      cursor.expect(0x29, "case");
      targets.push(i32(cursor.bytes, cursor.offset));
      cursor.offset += 4;
    }
    cursor.expect(0x7d, "case branch");
    return { op: "branch", offset, ...identity, kind: identity.opcode === 9 ? "gosubCase" : "gotoCase", expression, targets, cases };
  }
  if (selectKeys.has(key)) {
    let window: RealLiveExpression | undefined;
    if (cursor.value === 0x28) {
      cursor.offset += 1;
      window = parseExpression(cursor);
      cursor.expect(0x29, "selection window");
    }
    cursor.expect(0x7b, "selection");
    if (cursor.value === 0x0a) cursor.offset += 3;
    const options: Array<{ text: string; textExpression?: RealLiveExpression; conditions: Array<{ expression?: RealLiveExpression; effect: number; argument?: RealLiveExpression }> }> = [];
    for (let index = 0; index < identity.argc; index += 1) {
      while (cursor.value === 0x2c) cursor.offset += 1;
      const conditions: Array<{ expression?: RealLiveExpression; effect: number; argument?: RealLiveExpression }> = [];
      if (cursor.value === 0x28) {
        cursor.offset += 1;
        while (cursor.bytes[cursor.offset] !== 0x29) {
          let expression: RealLiveExpression | undefined;
          if (cursor.value === 0x28) expression = parseExpression(cursor);
          const effect = cursor.take();
          let argument: RealLiveExpression | undefined;
          const next = cursor.bytes[cursor.offset];
          if (effect !== 0x32 && effect !== 0x33 && next !== 0x29 && (next < 0x30 || next > 0x39)) {
            argument = parseExpression(cursor);
          }
          conditions.push({ expression, effect, argument });
        }
        cursor.offset += 1;
      }
      const textExpression = startsAscii(cursor, "###PRINT(") ? parsePrint(cursor) : undefined;
      const text = textExpression ? "" : parseString(cursor);
      if (cursor.value !== 0x0a) throw new Error(`Selection option lacks line marker at ${cursor.offset}`);
      cursor.offset += 3;
      options.push({ text, textExpression, conditions });
    }
    while (cursor.value === 0x0a) cursor.offset += 3;
    cursor.expect(0x7d, "selection");
    return { op: "select", offset, ...identity, window, options };
  }

  const args: DataValue[] = [];
  if (cursor.offset < cursor.bytes.length && cursor.value === 0x28) {
    cursor.offset += 1;
    while (cursor.bytes[cursor.offset] !== 0x29) args.push(parseData(cursor));
    cursor.offset += 1;
  }
  return { op: "command", offset, ...identity, args };
}

function parseText(cursor: Cursor): Extract<RealLiveInstruction, { op: "text" }> {
  const offset = cursor.offset;
  const start = cursor.offset;
  let quoted = false;
  while (cursor.offset < cursor.bytes.length) {
    const value = cursor.value;
    if (quoted) {
      if (value === 0x22 && cursor.bytes[cursor.offset - 1] !== 0x5c) quoted = false;
    } else {
      if (value === 0x2c) {
        cursor.offset += 1;
        continue;
      }
      if (value === 0x22) quoted = true;
      if (value === 0 || value === 0x23 || value === 0x24 || value === 0x0a || value === 0x40 || value === 0x21) break;
    }
    cursor.offset += isShiftJisLead(value) ? 2 : 1;
  }
  if (cursor.offset === start) cursor.offset += 1;
  const raw = decodeShiftJis(cursor.bytes.subarray(start, cursor.offset));
  const speakerStart = raw.indexOf("\u0001");
  const speakerEnd = speakerStart >= 0 ? raw.indexOf("\u0002", speakerStart + 1) : -1;
  const clean = (value: string) => value.replaceAll(/^,|,$/g, "").replaceAll(/^"|"$/g, "").replaceAll('\\"', '"').trim();
  if (speakerStart >= 0 && speakerEnd > speakerStart) {
    return { op: "text", offset, text: clean(raw.slice(speakerEnd + 1)), speaker: clean(raw.slice(speakerStart + 1, speakerEnd)) || undefined };
  }
  return { op: "text", offset, text: clean(raw) };
}

export function parseRealLiveBytecode(data: Uint8Array, header: RealLiveHeader): {
  instructions: RealLiveInstruction[];
  entrypoints: Record<string, number>;
} {
  const body = data.subarray(header.dataOffset);
  const cursor = new Cursor(body);
  const instructions: RealLiveInstruction[] = [];
  const offsetToIndex = new Map<number, number>();
  const entrypointOffsets = new Map<number, number>();
  const kidokuOffset = i32(data, 0x08);
  const kidokuLength = i32(data, 0x0c);
  const kidoku = Array.from({ length: Math.max(0, kidokuLength) }, (_, index) => i32(data, kidokuOffset + index * 4));

  while (cursor.offset < body.length) {
    const offset = cursor.offset;
    offsetToIndex.set(offset, instructions.length);
    const value = cursor.value;
    if (value === 0 || value === 0x2c) {
      cursor.offset += 1;
      continue;
    }
    if (value === 0x0a) {
      cursor.offset += 3;
      continue;
    }
    if (value === 0x40 || value === 0x21) {
      const marker = i16(body, cursor.offset + 1);
      const entrypoint = kidoku[marker];
      if (entrypoint !== undefined && entrypoint >= 1_000_000) entrypointOffsets.set(entrypoint - 1_000_000, offset);
      cursor.offset += 3;
      continue;
    }
    try {
      if (value === 0x24) {
        const expression = parseAssignment(cursor);
        instructions.push({ op: "assign", offset, expression });
      } else if (value === 0x23) {
        instructions.push(parseCommand(cursor));
      } else {
        const text = parseText(cursor);
        if (text.text) instructions.push(text);
      }
    } catch (error) {
      throw new Error(`Unable to parse RealLive bytecode at ${offset}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const indexAtOffset = (offset: number) => {
    const exact = offsetToIndex.get(offset);
    if (exact !== undefined) return exact;
    const next = [...offsetToIndex].find(([candidate]) => candidate >= offset);
    return next?.[1] ?? instructions.length;
  };
  for (const instruction of instructions) {
    if (instruction.op === "branch") instruction.targets = instruction.targets.map(indexAtOffset);
  }
  return {
    instructions,
    entrypoints: Object.fromEntries([...entrypointOffsets].map(([entrypoint, offset]) => [String(entrypoint), indexAtOffset(offset)])),
  };
}
