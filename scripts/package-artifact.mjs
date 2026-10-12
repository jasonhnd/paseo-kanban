import { gunzipSync } from "node:zlib";

const string = field => field.toString("utf8").replace(/\0.*$/s, "");
const number = field => {
  const value = string(field).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("unsupported tar numeric field");
  return value ? Number.parseInt(value, 8) : 0;
};

function paxFields(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    const size = Number(buffer.subarray(offset, space).toString());
    if (space < offset || !Number.isSafeInteger(size) || size <= space - offset + 1 || offset + size > buffer.length) throw new Error("invalid tar PAX record");
    const record = buffer.subarray(space + 1, offset + size - 1).toString("utf8");
    const equal = record.indexOf("=");
    if (equal < 1 || buffer[offset + size - 1] !== 10) throw new Error("invalid tar PAX field");
    fields[record.slice(0, equal)] = record.slice(equal + 1);
    offset += size;
  }
  return fields;
}

/** Read actual npm tarball bytes, including generated files and UTF-8/PAX paths. No external tar/Python. */
export function packageEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let extended = {};
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const checksum = header.reduce((sum, byte, at) => sum + (at >= 148 && at < 156 ? 32 : byte), 0);
    if (checksum !== number(header.subarray(148, 156))) throw new Error("invalid tar header checksum");
    const size = number(header.subarray(124, 136));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (data.length !== size) throw new Error("truncated tar entry");
    const type = String.fromCharCode(header[156]);
    const prefix = string(header.subarray(345, 500));
    const name = string(header.subarray(0, 100));
    const path = extended.path ?? (prefix ? prefix + "/" + name : name);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { extended = paxFields(data); continue; }
    if (!["0", "\0"].includes(type)) throw new Error(`unsupported package tar entry type: ${type}`);
    if (!path.startsWith("package/") || path.split("/").some(part => ["..", ".", ""].includes(part))) throw new Error("unsafe package tar path");
    if (extended.size !== undefined && Number(extended.size) !== size) throw new Error("inconsistent package PAX size");
    entries.push({ path: path.slice("package/".length), data });
    extended = {};
  }
  if (!ended || tar.subarray(offset).some(byte => byte !== 0) || Object.keys(extended).length) throw new Error("invalid tar termination");
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error("duplicate package entries");
  return entries;
}
