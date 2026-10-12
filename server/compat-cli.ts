/// <reference types="node" />
import { pathToFileURL } from "node:url";
import { t } from "../shared/i18n";
import { runCompatChecked } from "./compat";
import { applyServerLanguage } from "./language";

async function main(): Promise<void> {
  try {
    applyServerLanguage(process.env);
  } catch {
    // The config could not be read (the checks below report that); KANBAN_LANGUAGE still applies.
    applyServerLanguage(process.env, {});
  }
  const result = await runCompatChecked(process.env);
  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.log(t("compatCli.failed", { message }));
    process.exit(1);
  });
}
