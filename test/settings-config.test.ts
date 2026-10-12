/// <reference types="node" />
// Settings read/write: revision, validation, atomic replace, and first-run seeding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createTask } from "../server/task-create";
import { closeDb } from "../server/db";
import { readExampleConfig } from "../server/config-example";
import { getLanguage, setLanguage, t } from "../shared/i18n";
import { newProjectSettings, type SettingsDocument } from "../shared/settings";
import { readSettings, writeSettings, candidateProjects } from "../server/settings";
import type { ListedWorkspace } from "../server/placement";

const savedDir = process.env.KANBAN_DATA_DIR;
const savedLanguage = process.env.KANBAN_LANGUAGE;
const savedProcessLanguage = getLanguage();
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-settings-"));
  dirs.push(dir);
  closeDb();
  process.env.KANBAN_DATA_DIR = dir;
  return dir;
}

function configFile(dir: string): string {
  return join(dir, "kanban.config.json");
}

function bytes(dir: string): string {
  return readFileSync(configFile(dir), "utf8");
}

function revision(dir: string): string {
  return createHash("sha256").update(readFileSync(configFile(dir))).digest("hex");
}

const none = async () => [];

afterEach(() => {
  closeDb();
  if (savedLanguage === undefined) delete process.env.KANBAN_LANGUAGE;
  else process.env.KANBAN_LANGUAGE = savedLanguage;
  setLanguage(savedProcessLanguage);
});

after(() => {
  closeDb();
  if (savedDir === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = savedDir;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(id: string, root: string, extra: Partial<ListedWorkspace> = {}): ListedWorkspace {
  return {
    id,
    name: id,
    directory: root,
    projectRoot: root,
    projectId: `project-${id}`,
    kind: "local",
    archived: false,
    ...extra,
  };
}

describe("settings config", () => {
  it("seeds an empty directory from the example and nowhere else", async () => {
    const dir = freshDir();
    const example = readExampleConfig();
    assert.ok(example);
    const view = await readSettings(none);
    assert.equal(view.needsSetup, true);
    assert.equal(view.problem, null);
    assert.equal(view.document?.language, "system");
    const written = JSON.parse(bytes(dir)) as Record<string, unknown>;
    assert.equal(written.setupPending, true);
    delete written.setupPending;
    assert.deepEqual(written, example);
    const again = bytes(dir);
    await readSettings(none);
    assert.equal(bytes(dir), again);
  });

  it("does not touch a config that is already there", async () => {
    const dir = freshDir();
    const body = `${JSON.stringify({ language: "en", projects: {}, keep: { answer: 1 } })}\n`;
    writeFileSync(configFile(dir), body);
    const view = await readSettings(none);
    assert.equal(view.needsSetup, false);
    assert.equal(view.document?.language, "en");
    assert.equal(bytes(dir), body);
  });

  it("does not seed when a previous config left a trace or the database has cards", async () => {
    const traced = freshDir();
    writeFileSync(join(traced, "kanban.config.json.prev"), "{}\n");
    const refused = await readSettings(none);
    assert.equal(refused.document, null);
    assert.equal(existsSync(configFile(traced)), false);
    assert.ok(refused.problem);

    const lived = freshDir();
    createTask({ project: "alpha", title: "note", role: "executor" });
    rmSync(configFile(lived));
    const lost = await readSettings(none);
    assert.equal(lost.document, null);
    assert.equal(existsSync(configFile(lived)), false);
  });

  it("lists only unconfigured main workspaces from the supplied list", async () => {
    freshDir();
    const listed = [
      workspace("alpha", "/tmp/demo/alpha"),
      workspace("alpha-copy", "/tmp/demo/alpha"),
      workspace("side", "/tmp/demo/side", { directory: "/tmp/demo/side/checkout" }),
      workspace("tree", "/tmp/demo/tree", { kind: "worktree" }),
      workspace("old", "/tmp/demo/old", { archived: true }),
      workspace("beta", "/tmp/demo/beta"),
    ];
    const view = await readSettings(async () => listed);
    const seeded = view.document!;
    seeded.projects = { ...seeded.projects, beta: newProjectSettings("BET") };
    const saved = await writeSettings({ revision: view.revision, document: seeded }, async () => listed);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.candidates.map((row) => row.name), ["alpha"]);
    assert.equal(saved.candidates[0]!.path, "/tmp/demo/alpha");
    assert.equal(saved.needsSetup, false);
    assert.equal(saved.document?.projects.beta?.code, "BET");
  });

  it("reports a workspace-list failure without dropping the document", async () => {
    freshDir();
    const view = await readSettings(async () => {
      throw new Error("list failed");
    });
    assert.equal(view.candidatesNote, t("settings.candidates.unavailable"));
    assert.deepEqual(view.candidates, []);
    assert.ok(view.document);
  });

  it("rejects a stale revision and a bad document without changing bytes", async () => {
    const dir = freshDir();
    const view = await readSettings(none);
    const document = view.document!;
    const first = await writeSettings({
      revision: view.revision,
      document: { ...document, language: "en" },
    }, none);
    assert.equal(first.ok, true);
    assert.equal(first.conflict, false);
    assert.equal(first.message, t("settings.saved"));
    const settled = bytes(dir);
    const stale = await writeSettings({ revision: view.revision, document }, none);
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(stale.message, t("settings.conflict"));
    assert.equal(bytes(dir), settled);
    const bad = { ...first.document!, concurrency: { ...first.document!.concurrency, global: 0 } };
    const rejected = await writeSettings({ revision: first.revision, document: bad }, none);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.conflict, false);
    assert.equal(rejected.message, t("settings.error.global"));
    assert.equal(bytes(dir), settled);
    assert.equal(rejected.document?.language, "en");
  });

  it("does not let a save of the pre-list document overwrite a write that landed while the workspace list waited", async () => {
    const dir = freshDir();
    let before = "";
    const view = await readSettings(async () => {
      before = revision(dir);
      const raw = JSON.parse(bytes(dir)) as { concurrency: { global: number } };
      raw.concurrency.global = 9;
      writeFileSync(configFile(dir), `${JSON.stringify(raw, null, 2)}\n`);
      return [];
    });
    assert.equal(view.document!.concurrency.global, 5);
    assert.equal(view.revision, before);
    const outcome = await writeSettings({ revision: view.revision, document: view.document! }, none);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.conflict, true);
    assert.equal(outcome.message, t("settings.conflict"));
    assert.equal(JSON.parse(bytes(dir)).concurrency.global, 9);
  });

  it("writes atomically, keeps unknown keys, and will not recreate a deleted file from the client document", async () => {
    const dir = freshDir();
    const view = await readSettings(none);
    const raw = JSON.parse(bytes(dir)) as Record<string, unknown>;
    raw.doctor = { blockedHours: 2 };
    raw.marker = "keep-me";
    raw.supervisors = { alpha: "agent-alpha", gone: "agent-gone" };
    writeFileSync(configFile(dir), `${JSON.stringify(raw, null, 2)}\n`);
    const current = await readSettings(none);
    const document: SettingsDocument = {
      ...current.document!,
      projects: { alpha: { ...newProjectSettings("ALP"), autoStart: false } },
      disabledPools: [" demo ", "demo", ""],
    };
    const saved = await writeSettings({ revision: revision(dir), document }, none);
    assert.equal(saved.ok, true);
    const body = JSON.parse(bytes(dir)) as {
      doctor?: { blockedHours: number };
      marker?: string;
      setupPending?: boolean;
      supervisors?: Record<string, string>;
      disabledPools?: string[];
      projects?: Record<string, { code?: string; autoStart?: boolean }>;
    };
    assert.equal(body.doctor?.blockedHours, 2);
    assert.equal(body.marker, "keep-me");
    assert.equal(body.setupPending, undefined);
    assert.deepEqual(body.supervisors, { alpha: "agent-alpha" });
    assert.deepEqual(body.disabledPools, ["demo"]);
    assert.equal(body.projects?.alpha?.code, "ALP");
    const previous = readFileSync(join(dir, "kanban.config.json.prev"), "utf8");
    assert.match(previous, /keep-me/);
    assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);

    const again = await writeSettings({
      revision: saved.revision,
      document: { ...saved.document!, language: "zh-CN" },
    }, none);
    assert.equal(again.ok, true);
    assert.match(readFileSync(join(dir, "kanban.config.json.prev"), "utf8"), /"code": "ALP"/);
    assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);

    const poisoned = { ...again.document!, projects: { injected: newProjectSettings("INJ") } };
    rmSync(configFile(dir));
    const missing = await writeSettings({ revision: again.revision, document: poisoned }, none);
    assert.equal(missing.ok, false);
    assert.equal(existsSync(configFile(dir)), false);

    writeFileSync(configFile(dir), "{");
    const broken = await writeSettings({ revision: "anything", document: poisoned }, none);
    assert.equal(broken.ok, false);
    assert.equal(broken.conflict, false);
    assert.equal(bytes(dir), "{");
  });

  it("keeps an empty code and an already stored worktree, and refuses a duplicate or a switch to worktree", async () => {
    const dir = freshDir();
    const view = await readSettings(none);
    const saved = await writeSettings({
      revision: view.revision,
      document: {
        ...view.document!,
        projects: {
          alpha: { ...newProjectSettings(""), code: "" },
          beta: newProjectSettings("BET"),
        },
      },
    }, none);
    assert.equal(saved.ok, true);
    const file = JSON.parse(bytes(dir)) as { projects: Record<string, { code?: string; defaultWorkspace?: string }> };
    assert.equal(file.projects.alpha?.code, undefined);
    assert.equal(file.projects.beta?.defaultWorkspace, "dir");
    file.projects.beta!.defaultWorkspace = "worktree";
    writeFileSync(configFile(dir), `${JSON.stringify(file, null, 2)}\n`);
    const kept = await readSettings(none);
    assert.equal(kept.document?.projects.beta?.defaultWorkspace, "worktree");
    const still = await writeSettings({ revision: kept.revision, document: kept.document! }, none);
    assert.equal(still.ok, true);
    assert.equal(JSON.parse(bytes(dir)).projects.beta.defaultWorkspace, "worktree");
    const taken = await writeSettings({
      revision: still.revision,
      document: {
        ...still.document!,
        projects: { ...still.document!.projects, gamma: newProjectSettings("BET") },
      },
    }, none);
    assert.equal(taken.ok, false);
    assert.equal(taken.message, t("settings.error.codeTaken", { code: "BET", project: "beta" }));
    const switched = await writeSettings({
      revision: still.revision,
      document: {
        ...still.document!,
        projects: {
          ...still.document!.projects,
          alpha: { ...still.document!.projects.alpha!, defaultWorkspace: "worktree" },
        },
      },
    }, none);
    assert.equal(switched.ok, false);
    assert.equal(switched.message, t("settings.error.worktree", { project: "alpha" }));
    assert.equal(JSON.parse(bytes(dir)).projects.beta.defaultWorkspace, "worktree");
  });

  it("candidateProjects skips configured names and non-main rows", () => {
    const rows = candidateProjects(
      [workspace("alpha", "/tmp/demo/alpha"), workspace("kept", "/tmp/demo/kept")],
      new Set(["kept"]),
    );
    assert.deepEqual(rows, [{ name: "alpha", path: "/tmp/demo/alpha" }]);
  });
});
