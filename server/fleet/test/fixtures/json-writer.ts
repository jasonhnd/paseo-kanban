// Separate process using the real helper, paused after writing and before rename.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const [target, label] = process.argv.slice(2);
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (String(to) === target) {
    const released = new Promise<void>((resolve) => process.once("message", () => resolve()));
    process.send?.({ phase: "ready", temp: String(from) });
    await released;
  }
  await rename(from, to);
};
syncBuiltinESMExports();

try {
  const { writeJson } = await import("../../util");
  await writeJson(target, { label, payload: label.repeat(32_768) });
  process.send?.({ phase: "done", ok: true });
} catch (error) {
  process.exitCode = 1;
  process.send?.({ phase: "done", ok: false, code: (error as NodeJS.ErrnoException).code });
} finally {
  process.disconnect();
}
