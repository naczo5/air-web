import fs from "node:fs";
import { deflateSync } from "node:zlib";

export type SeenEntry = { scene: number; offset: number; length: number };

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type NwaInfo = {
  channels: number;
  bitsPerSample: number;
  sampleRate: number;
  compression: number;
  dataSize: number;
  sampleCount: number;
};

function need(buffer: Uint8Array, offset: number, size: number, label: string) {
  if (offset < 0 || size < 0 || offset + size > buffer.byteLength) {
    throw new Error(`${label} exceeds resource bounds at ${offset}+${size}`);
  }
}

function viewOf(buffer: Uint8Array): DataView {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function u16(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 2, "u16");
  return viewOf(buffer).getUint16(offset, true);
}

function i16(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 2, "i16");
  return viewOf(buffer).getInt16(offset, true);
}

function u32(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 4, "u32");
  return viewOf(buffer).getUint32(offset, true);
}

function i32(buffer: Uint8Array, offset: number): number {
  need(buffer, offset, 4, "i32");
  return viewOf(buffer).getInt32(offset, true);
}

function imageSize(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    throw new Error(`Invalid image dimensions ${width}x${height}`);
  }
  const size = width * height * 4;
  if (!Number.isSafeInteger(size)) throw new Error(`Image is too large: ${width}x${height}`);
  return size;
}

function decompressLzss(source: Uint8Array, outputSize: number, pixelBytes: number): Uint8Array {
  if (pixelBytes !== 1 && pixelBytes !== 3) throw new Error(`Unsupported LZSS pixel width ${pixelBytes}`);
  const output = new Uint8Array(outputSize);
  let sourceOffset = 0;
  let outputOffset = 0;
  let flags = 0;
  let bit = 0;
  while (outputOffset < output.length) {
    if (bit === 0) {
      need(source, sourceOffset, 1, "LZSS flag");
      flags = source[sourceOffset++];
      bit = 1;
    }
    if ((flags & bit) !== 0) {
      need(source, sourceOffset, pixelBytes, "LZSS literal");
      if (outputOffset + pixelBytes > output.length) throw new Error("LZSS literal overruns output");
      output.set(source.subarray(sourceOffset, sourceOffset + pixelBytes), outputOffset);
      sourceOffset += pixelBytes;
      outputOffset += pixelBytes;
    } else {
      need(source, sourceOffset, 2, "LZSS back-reference");
      const countWord = source[sourceOffset] | (source[sourceOffset + 1] << 8);
      sourceOffset += 2;
      const distance = countWord >> 4;
      const count = (countWord & 0x0f) + (pixelBytes === 3 ? 1 : 2);
      const distanceBytes = distance * pixelBytes;
      const copyBytes = count * pixelBytes;
      const reference = outputOffset - distanceBytes;
      if (distance <= 0 || reference < 0 || reference >= outputOffset) {
        throw new Error(`Invalid LZSS back-reference distance ${distance}`);
      }
      if (outputOffset + copyBytes > output.length) throw new Error("LZSS back-reference overruns output");
      for (let index = 0; index < copyBytes; index += 1) output[outputOffset++] = output[reference + index];
    }
    bit <<= 1;
    if (bit === 0x100) bit = 0;
  }
  return output;
}

const CGM_XOR_KEY = Uint8Array.from(Buffer.from(
  "8be55dc3a1e030440085c074095f5e33c05b8be55dc38b450c85c075148b55ec83c220526a00e8f528010083c40889450c8b45e46a006a005053ff1534b143008b451085c074058b4dec89088a45f084c07578a1e03044008b7de88b750c85c075448b1dd0b0430085ff763781ff000004006a0076438b45f88d55fc5268000004005650ff152cb143006a05ffd3a1e030440081ef0000040081c60000040085c074c58b5df853e8f4fbffff8b450c83c4045f5e5b8be55dc38b55f88d4dfc51575652ff152cb14300ebd88b45e883c020506a00e8472801008b7de88945f48bf0a1e030440083c40885c075568b1dd0b0430085ff764981ff000004006a0076",
  "hex",
));

export function parseCgmTable(input: Uint8Array): Array<{ name: string; flag: number }> {
  need(input, 0, 0x28, "CGM header");
  const signature = Buffer.from(input.subarray(0, 8)).toString("ascii");
  if (!signature.startsWith("CGTABLE")) throw new Error("Invalid CGM signature");
  const count = u32(input, 0x10);
  const recordSize = input[7] === 0x32 ? 60 : 36;
  if (count > 100_000) throw new Error(`Invalid CGM entry count ${count}`);
  const decoded = input.slice();
  for (let index = 0x20; index < decoded.length; index += 1) {
    decoded[index] ^= CGM_XOR_KEY[(index - 0x20) & 0xff];
  }
  const records = decompressLzss(decoded.subarray(0x28), count * recordSize, 1);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * recordSize;
    const end = records.indexOf(0, offset);
    const nameEnd = end < 0 || end > offset + 32 ? offset + 32 : end;
    return {
      name: Buffer.from(records.subarray(offset, nameEnd)).toString("latin1"),
      flag: u32(records, offset + 32),
    };
  });
}

function rgbaFromBgr(bgr: Uint8Array, width: number, height: number): RgbaImage {
  if (bgr.length !== width * height * 3) throw new Error(`BGR payload has ${bgr.length} bytes, expected ${width * height * 3}`);
  const rgba = new Uint8Array(imageSize(width, height));
  for (let source = 0, target = 0; source < bgr.length; source += 3, target += 4) {
    rgba[target] = bgr[source + 2];
    rgba[target + 1] = bgr[source + 1];
    rgba[target + 2] = bgr[source];
    rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}

function decodeG00Format0(buffer: Uint8Array, width: number, height: number): RgbaImage {
  const compressedSize = u32(buffer, 5);
  const uncompressedSize = u32(buffer, 9);
  if (compressedSize !== buffer.length - 5) throw new Error(`G00 format 0 compressed size mismatch: ${compressedSize} != ${buffer.length - 5}`);
  if (uncompressedSize !== width * height * 4) throw new Error(`G00 format 0 uncompressed size mismatch: ${uncompressedSize}`);
  const rgb = decompressLzss(buffer.subarray(0x0d, 0x0d + compressedSize - 8), width * height * 3, 3);
  return rgbaFromBgr(rgb, width, height);
}

function decodeG00Format1(buffer: Uint8Array, width: number, height: number): RgbaImage {
  const compressedSize = u32(buffer, 5);
  const uncompressedSize = u32(buffer, 9);
  if (compressedSize !== buffer.length - 5) throw new Error(`G00 format 1 compressed size mismatch: ${compressedSize} != ${buffer.length - 5}`);
  const data = decompressLzss(buffer.subarray(0x0d, 0x0d + compressedSize - 8), uncompressedSize, 1);
  const paletteLength = u16(data, 0);
  if (paletteLength <= 0 || paletteLength > 256) throw new Error(`Invalid G00 palette length ${paletteLength}`);
  const pixelOffset = 2 + paletteLength * 4;
  need(data, pixelOffset, width * height, "G00 palette pixels");
  const rgba = new Uint8Array(imageSize(width, height));
  for (let index = 0; index < width * height; index += 1) {
    const paletteIndex = data[pixelOffset + index];
    if (paletteIndex >= paletteLength) throw new Error(`G00 palette index ${paletteIndex} exceeds palette length ${paletteLength}`);
    const source = 2 + paletteIndex * 4;
    const target = index * 4;
    rgba[target] = data[source + 2];
    rgba[target + 1] = data[source + 1];
    rgba[target + 2] = data[source];
    rgba[target + 3] = data[source + 3];
  }
  return { width, height, data: rgba };
}

function decodeG00Format2(buffer: Uint8Array, width: number, height: number): RgbaImage {
  const regionCount = u32(buffer, 5);
  if (regionCount <= 0 || regionCount > 4096) throw new Error(`Invalid G00 region count ${regionCount}`);
  const headerOffset = 9 + regionCount * 24;
  need(buffer, headerOffset, 8, "G00 format 2 header");
  const compressedSize = u32(buffer, headerOffset);
  const uncompressedSize = u32(buffer, headerOffset + 4);
  if (compressedSize !== buffer.length - headerOffset) throw new Error(`G00 format 2 compressed size mismatch: ${compressedSize} != ${buffer.length - headerOffset}`);
  const data = decompressLzss(buffer.subarray(headerOffset + 8, headerOffset + compressedSize), uncompressedSize, 1);
  const indexLength = u32(data, 0);
  if (indexLength !== regionCount) throw new Error(`G00 format 2 index length ${indexLength} != region count ${regionCount}`);
  const regions = Array.from({ length: regionCount }, (_, index) => {
    const offset = 9 + index * 24;
    return { x1: i32(buffer, offset), y1: i32(buffer, offset + 4) };
  });
  const rgba = new Uint8Array(imageSize(width, height));
  for (let regionIndex = 0; regionIndex < regionCount; regionIndex += 1) {
    const blockOffset = u32(data, 4 + regionIndex * 8);
    const blockLength = i32(data, 8 + regionIndex * 8);
    if (blockLength <= 0) continue;
    need(data, blockOffset, blockLength, "G00 format 2 block");
    const block = data.subarray(blockOffset, blockOffset + blockLength);
    if (u16(block, 0) !== 1) throw new Error("Unsupported G00 format 2 block type");
    const partCount = u16(block, 2);
    let partOffset = 0x74;
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      const px = i16(block, partOffset) + regions[regionIndex].x1;
      const py = i16(block, partOffset + 2) + regions[regionIndex].y1;
      const partWidth = u16(block, partOffset + 6);
      const partHeight = u16(block, partOffset + 8);
      const rowBytes = partWidth * 4;
      partOffset += 0x5c;
      need(block, partOffset, rowBytes * partHeight, "G00 format 2 part pixels");
      for (let row = 0; row < partHeight; row += 1) {
        const y = py + row;
        if (y >= 0 && y < height) {
          const sourceStart = partOffset + row * rowBytes;
          const left = Math.max(0, px);
          const right = Math.min(width, px + partWidth);
          if (right > left) {
            const sourceStartAdjusted = sourceStart + (left - px) * 4;
            for (let x = left; x < right; x += 1) {
              const source = sourceStartAdjusted + (x - left) * 4;
              const target = (y * width + x) * 4;
              rgba[target] = block[source + 2];
              rgba[target + 1] = block[source + 1];
              rgba[target + 2] = block[source];
              rgba[target + 3] = block[source + 3];
            }
          }
        }
      }
      partOffset += rowBytes * partHeight;
    }
  }
  return { width, height, data: rgba };
}

export function decodeG00(buffer: Uint8Array): RgbaImage {
  need(buffer, 0, 0x0d, "G00 header");
  const format = buffer[0];
  const width = u16(buffer, 1);
  const height = u16(buffer, 3);
  if (format === 0) return decodeG00Format0(buffer, width, height);
  if (format === 1) return decodeG00Format1(buffer, width, height);
  if (format === 2) return decodeG00Format2(buffer, width, height);
  throw new Error(`Unsupported G00 format ${format}`);
}

function decodePdtMask(buffer: Uint8Array, offset: number, output: Uint8Array) {
  let sourceOffset = offset;
  let bit = 0;
  let flags = 0;
  let outputOffset = 0;
  while (outputOffset < output.length) {
    if (bit === 0) {
      need(buffer, sourceOffset, 1, "PDT mask flag");
      flags = buffer[sourceOffset++];
      bit = 8;
    }
    if ((flags & 0x80) !== 0) {
      need(buffer, sourceOffset, 1, "PDT mask literal");
      output[outputOffset++] = buffer[sourceOffset++];
    } else {
      need(buffer, sourceOffset, 2, "PDT mask back-reference");
      const count = buffer[sourceOffset++] + 2;
      const distance = buffer[sourceOffset++] + 1;
      const reference = outputOffset - distance;
      if (reference < 0 || reference >= outputOffset) throw new Error(`Invalid PDT mask back-reference ${distance}`);
      if (outputOffset + count > output.length) throw new Error("PDT mask back-reference overruns output");
      for (let index = 0; index < count; index += 1) output[outputOffset++] = output[reference + index];
    }
    flags = (flags << 1) & 0xff;
    bit -= 1;
  }
}

function decodePdt10Rgb(buffer: Uint8Array, output: Uint8Array, end: number) {
  let sourceOffset = 0x20;
  let bit = 0;
  let flags = 0;
  let outputOffset = 0;
  while (outputOffset < output.length) {
    if (sourceOffset >= end) throw new Error("PDT10 RGB stream ended early");
    if (bit === 0) {
      flags = buffer[sourceOffset++];
      bit = 8;
    }
    if ((flags & 0x80) !== 0) {
      need(buffer, sourceOffset, 3, "PDT10 RGB literal");
      output.set(buffer.subarray(sourceOffset, sourceOffset + 3), outputOffset);
      sourceOffset += 3;
      outputOffset += 3;
    } else {
      need(buffer, sourceOffset, 2, "PDT10 RGB back-reference");
      const countWord = buffer[sourceOffset] | (buffer[sourceOffset + 1] << 8);
      sourceOffset += 2;
      const distance = (countWord >> 4) + 1;
      const count = ((countWord & 0x0f) + 1) * 3;
      const reference = outputOffset - distance * 3;
      if (reference < 0 || reference >= outputOffset) throw new Error(`Invalid PDT10 RGB back-reference ${distance}`);
      if (outputOffset + count > output.length) throw new Error("PDT10 RGB back-reference overruns output");
      for (let index = 0; index < count; index += 1) output[outputOffset++] = output[reference + index];
    }
    flags = (flags << 1) & 0xff;
    bit -= 1;
  }
}

function decodePdt11Rgb(buffer: Uint8Array, output: Uint8Array, end: number) {
  let sourceOffset = 0x460;
  let bit = 0;
  let flags = 0;
  let outputOffset = 0;
  const index = Array.from({ length: 16 }, (_, item) => u32(buffer, 0x420 + item * 4));
  while (outputOffset < output.length) {
    if (sourceOffset >= end) throw new Error("PDT11 RGB stream ended early");
    if (bit === 0) {
      flags = buffer[sourceOffset++];
      bit = 8;
    }
    if ((flags & 0x80) !== 0) {
      need(buffer, sourceOffset, 1, "PDT11 palette index");
      const paletteOffset = buffer[sourceOffset++] * 4 + 0x20;
      need(buffer, paletteOffset, 3, "PDT11 palette entry");
      output.set(buffer.subarray(paletteOffset, paletteOffset + 3), outputOffset);
      outputOffset += 3;
    } else {
      need(buffer, sourceOffset, 1, "PDT11 RGB back-reference");
      const token = buffer[sourceOffset++];
      const count = (((token >> 4) & 0x0f) + 2) * 3;
      const reference = outputOffset - index[token & 0x0f] * 3;
      if (reference < 0 || reference >= outputOffset) throw new Error(`Invalid PDT11 RGB back-reference index ${token & 0x0f}`);
      const actualCount = Math.min(count, output.length - outputOffset);
      for (let item = 0; item < actualCount; item += 1) output[outputOffset++] = output[reference + item];
    }
    flags = (flags << 1) & 0xff;
    bit -= 1;
  }
}

export function decodePdt(buffer: Uint8Array): RgbaImage {
  need(buffer, 0, 0x20, "PDT header");
  const magic = Buffer.from(buffer.subarray(0, 5)).toString("ascii");
  if (magic !== "PDT10" && magic !== "PDT11") throw new Error(`Unsupported PDT format ${magic}`);
  const width = u32(buffer, 0x0c);
  const height = u32(buffer, 0x10);
  const rgb = new Uint8Array(width * height * 3);
  const maskOffset = u32(buffer, 0x1c);
  const rgbEnd = maskOffset || buffer.length;
  if (rgbEnd > buffer.length || rgbEnd < 0x20) throw new Error(`Invalid PDT mask pointer ${maskOffset}`);
  if (magic === "PDT10") decodePdt10Rgb(buffer, rgb, rgbEnd);
  else decodePdt11Rgb(buffer, rgb, rgbEnd);
  const rgba = rgbaFromBgr(rgb, width, height).data;
  if (maskOffset !== 0) {
    const alpha = new Uint8Array(width * height);
    decodePdtMask(buffer, maskOffset, alpha);
    for (let index = 0; index < alpha.length; index += 1) rgba[index * 4 + 3] = alpha[index];
  }
  return { width, height, data: rgba };
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return chunk;
}

export function encodePngRgba(image: RgbaImage): Buffer {
  const rowBytes = image.width * 4;
  const scanlines = Buffer.alloc((rowBytes + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    scanlines[row * (rowBytes + 1)] = 0;
    Buffer.from(image.data.subarray(row * rowBytes, (row + 1) * rowBytes)).copy(scanlines, row * (rowBytes + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", new Uint8Array())]);
}

function wavHeader(dataSize: number, channels: number, bitsPerSample: number, sampleRate: number): Buffer {
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataSize + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

class BitReader {
  private offset = 0;
  private shift = 0;
  constructor(private readonly data: Uint8Array) {}
  read(bits: number): number {
    if (bits <= 0 || bits > 16) throw new Error(`Invalid NWA bit count ${bits}`);
    need(this.data, this.offset, 2, "NWA bitstream");
    const value = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    const result = (value >>> this.shift) & ((1 << bits) - 1);
    this.shift += bits;
    if (this.shift > 8) {
      this.offset += 1;
      this.shift -= 8;
    }
    return result;
  }
}

function decodeNwaBlock(source: Uint8Array, outputSize: number, channels: number, bitsPerSample: number, compression: number, useRunLength: number): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const output = new Uint8Array(outputSize);
  if (source.length < bytesPerSample * channels) throw new Error("NWA block lacks initial samples");
  const view = viewOf(source);
  const samples = [bitsPerSample === 8 ? source[0] : view.getUint16(0, true), bitsPerSample === 8 ? 0 : view.getUint16(2, true)];
  let channel = 0;
  let runLength = 0;
  const reader = new BitReader(source.subarray(bytesPerSample * channels));
  const sampleCount = outputSize / bytesPerSample;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    if (runLength === 0) {
      const exponent = reader.read(3);
      if (exponent === 7) {
        if (reader.read(1) === 1) samples[channel] = 0;
        else {
          const bits = compression >= 3 ? 8 : 8 - compression;
          const shift = compression >= 3 ? 9 : 9 + compression;
          const value = reader.read(bits);
          const mask = 1 << (bits - 1);
          const magnitude = value & (mask - 1);
          samples[channel] += (value & mask) !== 0 ? -(magnitude << shift) : magnitude << shift;
        }
      } else if (exponent !== 0) {
        const bits = compression >= 3 ? compression + 3 : 5 - compression;
        const shift = compression >= 3 ? 1 + exponent : 2 + exponent + compression;
        const value = reader.read(bits);
        const mask = 1 << (bits - 1);
        const magnitude = value & (mask - 1);
        samples[channel] += (value & mask) !== 0 ? -(magnitude << shift) : magnitude << shift;
      } else if (useRunLength === 1) {
        runLength = reader.read(1);
        if (runLength === 1) {
          runLength = reader.read(2);
          if (runLength === 3) runLength = reader.read(8);
        }
      }
    } else runLength -= 1;
    const target = sample * bytesPerSample;
    if (bitsPerSample === 8) output[target] = samples[channel] & 0xff;
    else new DataView(output.buffer).setInt16(target, samples[channel], true);
    if (channels === 2) channel ^= 1;
  }
  return output;
}

export function parseNwaHeader(buffer: Uint8Array): NwaInfo {
  need(buffer, 0, 0x2c, "NWA header");
  const channels = i16(buffer, 0);
  const bitsPerSample = i16(buffer, 2);
  const sampleRate = i32(buffer, 4);
  const compression = i32(buffer, 8);
  const dataSize = i32(buffer, 20);
  const sampleCount = i32(buffer, 28);
  if (![1, 2].includes(channels) || ![8, 16].includes(bitsPerSample) || sampleRate <= 0) throw new Error(`Unsupported NWA audio format ${channels}ch/${bitsPerSample}bit/${sampleRate}Hz`);
  if (compression < -1 || compression > 5) throw new Error(`Unsupported NWA compression ${compression}`);
  if (dataSize < 0 || dataSize > buffer.length - 0x2c) throw new Error(`Invalid NWA data size ${dataSize}`);
  return { channels, bitsPerSample, sampleRate, compression, dataSize, sampleCount };
}

export function decodeNwaToWav(buffer: Uint8Array): { wav: Buffer; info: NwaInfo } {
  const info = parseNwaHeader(buffer);
  const bytesPerSample = info.bitsPerSample / 8;
  if (info.compression === -1) {
    const payload = Buffer.from(buffer.subarray(0x2c, 0x2c + info.dataSize));
    return { wav: Buffer.concat([wavHeader(payload.length, info.channels, info.bitsPerSample, info.sampleRate), payload]), info };
  }
  const blocks = i32(buffer, 16);
  const blockSize = i32(buffer, 32);
  const restSize = i32(buffer, 36);
  const compDataSize = i32(buffer, 24);
  if (blocks <= 0 || blocks > 1_000_000 || blockSize <= 0 || restSize < 0 || compDataSize <= 0) throw new Error("Invalid compressed NWA block metadata");
  need(buffer, 0x2c, blocks * 4 + compDataSize, "NWA compressed data");
  const offsets = Array.from({ length: blocks }, (_, index) => i32(buffer, 0x2c + index * 4));
  const compressed = buffer.subarray(0x2c + blocks * 4, 0x2c + blocks * 4 + compDataSize);
  const decodedBlocks: Uint8Array[] = [];
  for (let block = 0; block < blocks; block += 1) {
    const blockOutputSize = (block === blocks - 1 ? restSize : blockSize) * bytesPerSample;
    const start = offsets[block];
    const end = block === blocks - 1 ? compressed.length : offsets[block + 1];
    if (start < 0 || end < start || end > compressed.length) throw new Error(`Invalid NWA block offsets ${start}..${end}`);
    decodedBlocks.push(decodeNwaBlock(compressed.subarray(start, end), blockOutputSize, info.channels, info.bitsPerSample, info.compression, i32(buffer, 12)));
  }
  const payload = Buffer.concat(decodedBlocks.map((block) => Buffer.from(block)));
  if (payload.length !== info.dataSize) throw new Error(`Decoded NWA data size ${payload.length} != ${info.dataSize}`);
  return { wav: Buffer.concat([wavHeader(payload.length, info.channels, info.bitsPerSample, info.sampleRate), payload]), info };
}

export function readSeenIndex(buffer: Uint8Array): SeenEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const entries: SeenEntry[] = [];
  const count = Math.min(10000, Math.floor(buffer.byteLength / 8));
  for (let scene = 0; scene < count; scene += 1) {
    const offset = view.getUint32(scene * 8, true);
    const length = view.getUint32(scene * 8 + 4, true);
    if (!offset && !length) continue;
    if (offset + length > buffer.byteLength) {
      throw new Error(`SEEN entry ${scene} exceeds archive: offset=${offset} length=${length}`);
    }
    entries.push({ scene, offset, length });
  }
  return entries;
}

export function readSeenEntry(buffer: Uint8Array, entry: SeenEntry): Uint8Array {
  return buffer.slice(entry.offset, entry.offset + entry.length);
}

export function printableText(buffer: Uint8Array): string[] {
  const ascii = Buffer.from(buffer).toString("latin1");
  return [...ascii.matchAll(/[\x20-\x7e]{4,}/g)].map((match) => match[0]);
}

export function parseGameIni(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^#?([A-Z0-9_.]+)\s*=\s*(.*)$/i);
    if (match) values[match[1].toUpperCase()] = match[2].trim();
  }
  return values;
}

export function fileSummary(root: string) {
  const files: Array<{ relative: string; bytes: number; extension: string }> = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(absolute);
      else {
        const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "";
        files.push({ relative: absolute.slice(root.length + 1).replaceAll("\\", "/"), bytes: fs.statSync(absolute).size, extension });
      }
    }
  };
  walk(root);
  return files;
}
