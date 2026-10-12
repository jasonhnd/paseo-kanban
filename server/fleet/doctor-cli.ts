// Read-only one-click health check, started by bin/afc.mjs doctor.
// Default: a red / yellow / green table. --json: the same report as JSON. Exit code: red 2, yellow 1, all green 0.
// Nothing is written, started, stopped or logged in. The daily run and its history belong to the plugin, not to this command.
import { doctorExitCode, formatDoctorTable } from "../../shared/fleet/doctor";
import { runDoctor } from "./doctor";
import { initLanguage } from "./language";
import { t } from "../../shared/fleet/i18n";

initLanguage();

async function main(): Promise<void> {
  const report = await runDoctor();
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorTable(report));
  process.exitCode = doctorExitCode(report);
}

main().catch((error: unknown) => {
  console.error(t("doctor.cli.crashed"), String(error).slice(0, 300));
  process.exitCode = 2;
});
