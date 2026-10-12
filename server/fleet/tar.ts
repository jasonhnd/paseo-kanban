/// <reference types="node" />
// Minimal ustar writer and reader, gzip-compressed with node:zlib, so `afc migrate --finish` can archive the
// legacy directory without a tar or zstd binary. Regular files only; that is all the migration archives.
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const MAX_SIZE = 8 ** 11 - 1;

export interface TarInput {
  /** Path inside the archive, "/"-separated. */
  name: string;
  /** File to read the content from. */
  source: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface TarEntry {
  name: string;
  mode: number;
  data: Buffer;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** Split a long path into ustar's prefix and name fields. */
function splitName(name: string): { prefix: string; name: string } {
  if (Buffer.byteLength(name) <= NAME_MAX) return { prefix: "", name };
  for (let cut = name.indexOf("/"); cut !== -1; cut = name.indexOf("/", cut + 1)) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= PREFIX_MAX && Buffer.byteLength(rest) <= NAME_MAX) return { prefix, name: rest };
  }
  throw new Error(`path too long for a tar archive: ${name}`);
}

export function tarHeader(entry: Omit<TarInput, "source">): Buffer {
  if (entry.size > MAX_SIZE) throw new Error(`file too large for a tar archive: ${entry.name}`);
  const header = Buffer.alloc(BLOCK, 0);
  const { prefix, name } = splitName(entry.name);
  const put = (text: string, offset: number) => header.write(text, offset, "utf8");
  put(name, 0);
  put(octal(entry.mode & 0o7777, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(entry.size, 12), 124);
  put(octal(Math.floor(entry.mtimeMs / 1000), 12), 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

async function* tarStream(entries: readonly TarInput[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    yield tarHeader(entry);
    let written = 0;
    for await (const chunk of createReadStream(entry.source)) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      if (written > entry.size) throw new Error(`${entry.source} grew while it was being archived`);
      yield buffer;
    }
    if (written !== entry.size) throw new Error(`${entry.source} changed size while it was being archived`);
    yield padding(entry.size);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

/** Write a .tar.gz of `entries` to `file`. */
export async function writeTarGz(file: string, entries: readonly TarInput[]): Promise<void> {
  await pipeline(Readable.from(tarStream(entries), { objectMode: false }), createGzip(), createWriteStream(file, { flags: "wx", mode: 0o600 }));
}

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function parseOctal(text: string): number {
  const value = Number.parseInt(text.trim() || "0", 8);
  if (!Number.isFinite(value)) throw new Error(`bad number in tar header: ${JSON.stringify(text)}`);
  return value;
}

/** Read every regular file in a tar buffer. Checks each header's checksum. */
export function parseTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const expected = parseOctal(field(header, 148, 8));
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== expected) throw new Error(`tar header checksum mismatch at byte ${offset}`);
    const size = parseOctal(field(header, 124, 12));
    const prefix = field(header, 345, PREFIX_MAX);
    const name = field(header, 0, NAME_MAX);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error(`tar entry ${name} is truncated`);
    if (field(header, 156, 1) === "0" || field(header, 156, 1) === "") {
      out.push({ name: prefix ? `${prefix}/${name}` : name, mode: parseOctal(field(header, 100, 8)), data: Buffer.from(tar.subarray(start, start + size)) });
    }
    offset = start + size + padding(size).length;
  }
  return out;
}

/** Read a .tar.gz written by `writeTarGz`. */
export async function readTarGz(file: string): Promise<TarEntry[]> {
  return parseTar(gunzipSync(await readFile(file)));
}
