import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { unregisteredQuestion } from "../../../shared/fleet/leader-panel";

const at = "2026-01-01T12:30:00Z";
const detail = "A: Deploy the staging build\nB: Keep the current release\nRecommend A: validate the rollout gradually";
const decision = {
  id: "d0101-120000-1", project: "demo", status: "open", title: "Choose the rollout strategy",
  detail, createdAt: "2026-01-01T12:00:00Z",
};
const reply = (text = `${decision.title}\n${detail}`) => ({ text, at });

test("an open decision retold without an id after 30 minutes is registered", () => {
  assert.equal(unregisteredQuestion("DEMO", reply(), [decision]), null);
});

test("option overlap recognises a paraphrased heading and markdown/full-width punctuation", () => {
  assert.equal(unregisteredQuestion("demo", reply(
    "Which release approach suits us?\n**A**\uff1a Deploy the staging build\n**B**\uff1a Keep the current release\nRecommend A",
  ), [decision]), null);
});

test("minor wording changes keep matching substantive options", () => {
  assert.equal(unregisteredQuestion("demo", reply(
    "What shall we do?\nA: Deploy the new staging build\nB: Keep the current release for now\nRecommend A",
  ), [decision]), null);
});

test("done, shelved, supervisor and another project's decisions never suppress a question", () => {
  for (const status of ["done", "shelved", "supervisor"]) {
    assert.ok(unregisteredQuestion("demo", reply(), [{ ...decision, status, createdAt: at }]));
  }
  assert.ok(unregisteredQuestion("demo", reply(), [{ ...decision, project: "other" }]));
});

test("an unrelated newly registered decision does not hide a genuinely new question", () => {
  assert.ok(unregisteredQuestion("demo", reply(
    "Choose the backup location\nA: Store encrypted backups locally\nB: Upload backups to remote storage\nRecommend B",
  ), [{ ...decision, createdAt: at }]));
});

test("generic option/recommendation wording alone is insufficient", () => {
  const generic = { ...decision, detail: "A: Continue\nB: Wait\nRecommend A" };
  assert.ok(unregisteredQuestion("demo", reply(
    "Choose the backup location\nA: Continue\nB: Wait\nRecommend A",
  ), [generic]));
  assert.equal(unregisteredQuestion("demo", reply(`${decision.title}\n${generic.detail}`), [generic]), null);
});

test("a registered question does not hide a second unregistered question", () => {
  const text = `${reply().text}\n\nChoose the backup location\nA: Keep backups locally\nB: Store backups remotely\nRecommend B`;
  assert.match(unregisteredQuestion("demo", reply(text), [decision])?.text ?? "", /backup location/);
});

test("an unregistered question remains visible when an unrelated decision id is mentioned", () => {
  assert.ok(unregisteredQuestion("demo", reply(`${reply().text}\nSee d0101-110000-2.`), []));
});

test("quoted, fenced and agent-input questions remain ignored", () => {
  assert.equal(unregisteredQuestion("demo", reply(`\`\`\`\n${reply().text}\n\`\`\``), []), null);
  assert.equal(unregisteredQuestion("demo", reply(reply().text.split("\n").map(line => `> ${line}`).join("\n")), []), null);
  assert.equal(unregisteredQuestion("demo", { ...reply(), prompt: "DEMO_0001 wake" }, []), null);
});

test("English and Chinese reminder text identifies the board as the automatic source", () => {
  for (const locale of ["en", "zh-CN"]) {
    const messages = JSON.parse(readFileSync(new URL(`../../../shared/locales/${locale}/fleet.json`, import.meta.url), "utf8"));
    assert.doesNotMatch(messages["leader.week.nudge"], /AFC/i);
    assert.match(messages["leader.week.nudge"], locale === "en" ? /Kanban reminder.*automatically/i : /\u770b\u677f\u63d0\u9192.*\u81ea\u52a8/);
  }
});
