/// <reference types="node" />
import { pathToFileURL } from "node:url";
import { t } from "../shared/i18n";
import { applyServerLanguage } from "./language";
import { buildMissingCwdReport } from "./missing-cwd";

function main(): void {
  applyServerLanguage();
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    console.error(t("checkMissingCwd.unknownArg", { arg: unknown[0] }));
    process.exitCode = 2;
    return;
  }
  const json = args.includes("--json");
  const result = buildMissingCwdReport();
  if (json) console.log(JSON.stringify(result.report));
  else console.log(result.human);
  process.exitCode = result.code;
}

// Runs only as the command (bin/check-missing-cwd), not when another module or a test imports this file.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
