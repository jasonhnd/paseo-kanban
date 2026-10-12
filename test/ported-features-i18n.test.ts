import assert from "node:assert/strict";
import { it } from "node:test";
import { catalogKeys, getLanguage, setLanguage, t } from "../shared/i18n";
import { kanbanHelp } from "../server/cli";
import { toolDefs } from "../server/tools";

it("read grants and audit retention render through both public languages", () => {
  const previous = getLanguage();
  try {
    assert.deepEqual(catalogKeys("en").sort(), catalogKeys("zh-CN").sort());
    const rendered: string[] = [];
    for (const language of ["en", "zh-CN"] as const) {
      setLanguage(language);
      const help = kanbanHelp();
      assert.match(help, /grant-read.*revoke-read/);
      assert.match(help, /write_audits.*30/);
      const tools = toolDefs();
      for (const name of ["kanban_grant_read", "kanban_revoke_read"]) {
        const tool = tools.find(tool => tool.name === name)!;
        assert.ok(tool.description.length > 20);
        rendered.push(tool.description);
      }
      const message = t("readGrants.otherProject", { project: "demo-project" });
      assert.ok(message.includes("demo-project"));
      assert.ok(!message.includes("{project}"));
      const retention = t("writeSource.retention", { verb: "delete", rows: 3, days: 30 });
      assert.ok(retention.includes("3"));
      assert.ok(retention.includes("30"));
      assert.ok(!retention.includes("{rows}"));
    }
    assert.notEqual(rendered[0], rendered[2]);
    assert.notEqual(rendered[1], rendered[3]);
  } finally { setLanguage(previous); }
});
