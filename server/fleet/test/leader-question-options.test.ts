import assert from "node:assert/strict";
import test from "node:test";
import { unregisteredQuestion } from "../../../shared/fleet/leader-panel";

const at = "2026-01-01T12:30:00Z";
const english = {
  id: "d0101-120000-1", project: "demo", status: "open", createdAt: "2026-01-01T12:00:00Z",
  title: "Choose billing ledger migration",
  detail: "A: Migrate billing invoices to the new ledger after a dual-write audit\nB: Keep billing invoices on the existing ledger until the audit is complete\nRecommend A: the dual-write audit has passed on staging",
};
const chinese = { ...english, title: "\u9009\u62e9\u8d26\u5355\u53cc\u5199\u8fc1\u79fb\u65b9\u6848", detail:
  "A: \u8d26\u5355\u53d1\u7968\u8fc1\u79fb\u5230\u65b0\u8d26\u672c\u5e76\u6267\u884c\u53cc\u5199\u5ba1\u8ba1\nB: \u8d26\u5355\u53d1\u7968\u4fdd\u7559\u5728\u65e7\u8d26\u672c\u76f4\u5230\u5ba1\u8ba1\u5b8c\u6210\n\u63a8\u8350 A: \u9884\u53d1\u73af\u5883\u5df2\u901a\u8fc7\u53cc\u5199\u5ba1\u8ba1" };

for (const [locale, decision] of [["en", english], ["zh", chinese]] as const) {
  const ask = (text: string, registered = decision) => unregisteredQuestion("DEMO", { text, at }, [registered]);
  test(`${locale}: the second review's two distinctive options retold after 30 minutes need no title or id`, () => {
    assert.equal(ask(decision.detail), null);
  });
  test(`${locale}: done decisions never confirm an options-only retelling`, () => {
    assert.ok(ask(decision.detail, { ...decision, status: "done" }));
  });
  test(`${locale}: matching options with a different recommendation still need registration`, () => {
    assert.ok(ask(decision.detail.replace(/ A:/g, " B:")));
  });
  test(`${locale}: one matching option and a matching recommendation are insufficient`, () => {
    const a = decision.detail.split("\n")[0];
    assert.ok(ask(`${a}\nB: Archive encrypted customer snapshots\nRecommend A`));
  });
  test(`${locale}: no recommendation on the stored decision cannot confirm the options`, () => {
    assert.ok(ask(decision.detail, { ...decision, detail: decision.detail.split("\n").slice(0, 2).join("\n") }));
  });
  test(`${locale}: another project's distinctive options are not registered here`, () => {
    assert.ok(ask(decision.detail, { ...decision, project: "other" }));
  });
}

test("three English content words per option suffice, but function words and two content words do not", () => {
  const three = "A: Encrypt billing snapshots\nB: Archive audit receipts\nRecommend A";
  assert.equal(unregisteredQuestion("demo", { text: three, at }, [{ ...english, detail: three }]), null);
  const two = "A: We will encrypt snapshots now\nB: We will archive receipts later\nRecommend A";
  assert.ok(unregisteredQuestion("demo", { text: two, at }, [{ ...english, detail: two }]));
});

test("six meaningful Han characters per option suffice, but five do not", () => {
  const six = "A: \u52a0\u5bc6\u8d26\u5355\u5feb\u7167\nB: \u5f52\u6863\u5ba1\u8ba1\u51ed\u636e\n\u63a8\u8350 A";
  assert.equal(unregisteredQuestion("demo", { text: six, at }, [{ ...chinese, detail: six }]), null);
  const five = "A: \u52a0\u5bc6\u8d26\u5355\u5e93\nB: \u5f52\u6863\u51ed\u636e\u5e93\n\u63a8\u8350 A";
  assert.ok(unregisteredQuestion("demo", { text: five, at }, [{ ...chinese, detail: five }]));
});

test("contractions, pronouns and quantifiers do not manufacture a third English content word", () => {
  for (const prefix of ["Don't", "We're", "She will", "All", "Some", "They've"]) {
    const text = `A: ${prefix} encrypt snapshots\nB: ${prefix} archive receipts\nRecommend A`;
    assert.ok(unregisteredQuestion("demo", { text, at }, [{ ...english, detail: text }]), prefix);
  }
  const text = "A: Don't encrypt billing snapshots\nB: Don't archive audit receipts\nRecommend A";
  assert.equal(unregisteredQuestion("demo", { text, at }, [{ ...english, detail: text }]), null);
});

test("the first review's billing/authentication example keeps reminding despite identical generic rollout text", () => {
  const detail = "A: Deploy the staging build\nB: Keep the current release\nRecommend A: validate the rollout gradually";
  const decision = { ...english, title: "Should we roll out the billing redesign?", detail };
  assert.ok(unregisteredQuestion("demo", { text: `Should we roll out the authentication redesign?\n${detail}`, at }, [decision]));
  assert.ok(unregisteredQuestion("demo", { text: detail, at }, [decision]));
});

test("built-in generic answer phrases never count as distinctive options, even when padded", () => {
  const pairs = [
    ["yes now later", "no skip later"], ["Proceed with the current plan", "Wait until a later date"],
    ["\u73b0\u5728\u505a", "\u6682\u7f13"], ["\u5148\u4e0d\u505a", "\u7167\u505a"], ["\u540c\u610f", "\u4e0d\u540c\u610f"],
    ["\u73b0\u5728\u505a\u7136\u540e\u7ee7\u7eed\u6267\u884c", "\u5148\u4e0d\u505a\u7136\u540e\u6682\u7f13\u6267\u884c"],
  ];
  for (const [a, b] of pairs) {
    const text = `A: ${a}\nB: ${b}\nRecommend A`;
    assert.ok(unregisteredQuestion("demo", { text, at }, [{ ...english, detail: text }]), text);
  }
});

test("the same distinctive body duplicated as A and B is only one matched option", () => {
  const text = "A: Encrypt billing snapshots\nB: Encrypt billing snapshots\nRecommend A";
  assert.ok(unregisteredQuestion("demo", { text, at }, [{ ...english, detail: text }]));
});

test("formatting changes preserve matching bodies while negation and altered subjects do not", () => {
  const text = "**A**\uff1a MIGRATE billing invoices to the new ledger after a dual-write audit\n**B**\uff1a Keep billing invoices on the existing ledger until the audit is complete\nRecommend A";
  assert.equal(unregisteredQuestion("demo", { text, at }, [english]), null);
  assert.ok(unregisteredQuestion("demo", { text: english.detail.replace("Migrate", "Do not migrate"), at }, [english]));
});
