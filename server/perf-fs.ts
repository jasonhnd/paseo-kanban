/// <reference types="node" />
import * as fs from "node:fs";
import { countIo } from "./perf-count";

/**
 * Drop-in for the few node:fs calls that dominate a scheduler round, so the per-round
 * summary can say how many of each ran. Everything else is re-exported unchanged.
 */
export * from "node:fs";

export const existsSync: typeof fs.existsSync = (path) => {
  countIo("exists");
  return fs.existsSync(path);
};

export const readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
  countIo("readdir");
  return fs.readdirSync(...args);
}) as typeof fs.readdirSync;

export const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  countIo("readFile");
  return fs.readFileSync(...args);
}) as typeof fs.readFileSync;

export const statSync = ((...args: Parameters<typeof fs.statSync>) => {
  countIo("stat");
  return fs.statSync(...args);
}) as typeof fs.statSync;
