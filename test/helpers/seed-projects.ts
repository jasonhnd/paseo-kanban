/// <reference types="node" />
// Older suites were written when a fresh board seeded a fixed table of project codes. The board no
// longer ships that table; these suites seed the same projects into their own test data directory.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Test data only: project name → code, as those suites expect a fresh board to know them. */
export const FIXTURE_PROJECT_CODES: Readonly<Record<string, string>> = {
  demo_library: "DEMO",
  demo_board: "TEST",
  demo_fleet: "EX",
  "demo.example.com": "TEST9",
  demo_tasks: "XYZ",
  demo_web: "DEMO2",
  demo_portal: "TEST2",
  demo_test3: "EX2",
  demo_sandbox: "ABC2",
  "demo_quota": "XYZ2",
};

/** Write a first kanban.config.json with the fixture projects into `dir`, unless one is already there. */
export function seedFixtureProjects(dir: string, codes: Readonly<Record<string, string>> = FIXTURE_PROJECT_CODES): void {
  const path = join(dir, "kanban.config.json");
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true });
  const projects = Object.fromEntries(Object.entries(codes).map(([name, code]) => [
    name,
    { defaultWorkspace: "dir", baseBranch: "main", worktreeLanes: 1, lanesEnabled: false, code },
  ]));
  writeFileSync(path, `${JSON.stringify({ projects }, null, 2)}\n`);
}
