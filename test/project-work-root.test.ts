import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { cardTmpRoot } from "../server/card-tmp";
import { runKanban } from "../server/cli";
import { loadConfig, setProjectCode, setProjectWorkspace } from "../server/config";
import { closeDb } from "../server/db";

const saved = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "project-work-root-"));
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_PASEO_CONFIG = join(dir, "no-host-config.json");
after(() => { closeDb(); process.env = saved; rmSync(dir, { recursive: true, force: true }); });

for (const field of ["workspacePath", "workspace"] as const) {
  for (const mode of ["api", "cli"] as const) {
    it(mode + " project writes retain the configured work root from " + field, async () => {
      const repo = join(dir, field + "-" + mode);
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      const project = field + "-" + mode;
      const config = loadConfig();
      const path = join(dir, "kanban.config.json");
      writeFileSync(path, JSON.stringify({
        ...config, projects: { ...config.projects, [project]: {
          defaultWorkspace: "dir", baseBranch: "main", [field]: repo,
        } },
      }));
      const prior = process.env.KANBAN_TMP_ROOT;
      delete process.env.KANBAN_TMP_ROOT;
      const check = () => {
        assert.equal(loadConfig().projects?.[project]?.workspacePath, repo);
        assert.equal(cardTmpRoot({ project }), join(realpathSync(repo), ".kanban-work"));
        assert.equal(JSON.parse(readFileSync(path, "utf8")).projects[project].workspacePath, repo);
      };
      const code = (field === "workspacePath" ? "WSP" : "WSL") + (mode === "api" ? "A" : "C");
      try {
        if (mode === "api") {
          setProjectWorkspace(project, { baseBranch: "develop", parallel: false, worktreeLanes: 2 });
          check();
          setProjectCode(project, code);
          check();
        } else {
          await runKanban(["project", "--project", project, "--base", "develop", "--parallel", "off", "--lanes", "2", "--code", code], { PASEO_AGENT_ID: "" });
          check();
        }
        assert.equal(loadConfig().projects?.[project]?.baseBranch, "develop");
        assert.equal(loadConfig().projects?.[project]?.code, code);
      } finally {
        if (prior === undefined) delete process.env.KANBAN_TMP_ROOT;
        else process.env.KANBAN_TMP_ROOT = prior;
      }
    });
  }
}
