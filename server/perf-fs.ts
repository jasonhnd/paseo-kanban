/// <reference types="node" />
import {
  chmodSync as fsChmodSync,
  closeSync as fsCloseSync,
  existsSync as fsExistsSync,
  fstatSync as fsFstatSync,
  fsyncSync as fsFsyncSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  openSync as fsOpenSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  readlinkSync as fsReadlinkSync,
  readSync as fsReadSync,
  realpathSync as fsRealpathSync,
  renameSync as fsRenameSync,
  rmdirSync as fsRmdirSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import { countIo } from "./perf-count";

/**
 * Drop-in for the few node:fs calls that dominate a scheduler round, so the per-round
 * summary can say how many of each ran. Callers also use the other names below.
 * A namespace import of node:fs is not used: the host's CommonJS bundle copies every
 * enumerable export, and reading fs.F_OK emits DEP0176.
 */

export const existsSync: typeof fsExistsSync = (path) => {
  countIo("exists");
  return fsExistsSync(path);
};

export const readdirSync = ((...args: Parameters<typeof fsReaddirSync>) => {
  countIo("readdir");
  return fsReaddirSync(...args);
}) as typeof fsReaddirSync;

export const readFileSync = ((...args: Parameters<typeof fsReadFileSync>) => {
  countIo("readFile");
  return fsReadFileSync(...args);
}) as typeof fsReadFileSync;

export const statSync = ((...args: Parameters<typeof fsStatSync>) => {
  countIo("stat");
  return fsStatSync(...args);
}) as typeof fsStatSync;

export {
  fsChmodSync as chmodSync,
  fsCloseSync as closeSync,
  fsFstatSync as fstatSync,
  fsFsyncSync as fsyncSync,
  fsLstatSync as lstatSync,
  fsMkdirSync as mkdirSync,
  fsOpenSync as openSync,
  fsReadSync as readSync,
  fsReadlinkSync as readlinkSync,
  fsRealpathSync as realpathSync,
  fsRenameSync as renameSync,
  fsRmdirSync as rmdirSync,
  fsRmSync as rmSync,
  fsUnlinkSync as unlinkSync,
  fsWriteFileSync as writeFileSync,
};
