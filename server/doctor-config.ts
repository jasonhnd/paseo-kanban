/// <reference types="node" />
import { t, type MessageKey } from "../shared/i18n";
import { ConfigFileError, configFileProblem, loadConfig, type ConfigProblem, type KanbanConfig } from "./config";
import { CONFIG_PREV_FILE } from "./config-file";
import type { DoctorFinding } from "./doctor";
import { dataDirChoice, describeDataDir, type DataDirChoice } from "./paths";
import { projectsWithoutCode } from "./project-codes";

/**
 * Doctor's checks on kanban.config.json (DEMO_0001). Ids start with "config:", so a red is dropped from
 * alertedIds as soon as a later run no longer reports it, whatever happened to the other checks.
 */
export const CONFIG_FINDING_ID = "config:file";

const SYMPTOM_KEYS: Record<ConfigProblem["state"], MessageKey> = {
  missing: "doctorConfig.symptom.missing",
  broken: "doctorConfig.symptom.broken",
};

/** Red when the file is missing on a board that has had one, or cannot be parsed. Reads the file itself. */
export function checkConfigFile(add: (finding: DoctorFinding) => void): ConfigProblem | null {
  const problem = configFileProblem();
  if (!problem) return null;
  add({
    id: CONFIG_FINDING_ID,
    severity: "red",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: "kanban.config.json",
    symptom: t(SYMPTOM_KEYS[problem.state]),
    evidence: problem.message,
    suggestion: t("doctorConfig.file.suggestion", { prevFile: CONFIG_PREV_FILE }),
  });
  return problem;
}

export const DATA_DIR_FINDING_ID = "config:data-dir";

/** Info while the board still runs from the legacy data/ beside the plugin instead of plugin-data. */
export function checkDataDir(add: (finding: DoctorFinding) => void, choice: DataDirChoice = dataDirChoice()): void {
  if (choice.source !== "legacy") return;
  add({
    id: DATA_DIR_FINDING_ID,
    severity: "info",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: choice.dir,
    symptom: "Data directory not migrated yet",
    evidence: describeDataDir(choice),
    suggestion: `Nothing to do now. The board keeps using this directory until its data is migrated to ${choice.pluginDataDir}.`,
  });
}

/** Yellow per project that has cards but no stored code: its cards show a derived code, or `#id`, until a code is set. */
export function checkProjectCodes(projects: Iterable<string>, add: (finding: DoctorFinding) => void): void {
  let config: KanbanConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigFileError) return; // Already the red above.
    throw err;
  }
  for (const { project, shown } of projectsWithoutCode(projects, config)) {
    const display = shown ? t("doctorConfig.code.derived", { shown }) : t("doctorConfig.code.global");
    add({
      id: `config:code:${project}`,
      severity: "yellow",
      check: "board",
      project,
      card: null,
      taskId: null,
      object: `projects.${project}.code`,
      symptom: t("doctorConfig.code.symptom", { project }),
      evidence: t("doctorConfig.code.evidence", { display }),
      suggestion: t("doctorConfig.code.suggestion", { project, prevFile: CONFIG_PREV_FILE }),
    });
  }
}
