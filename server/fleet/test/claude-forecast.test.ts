import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClaudeSpend } from "../../../shared/fleet/dispatch";
import { claudePaceSentence } from "../../../shared/fleet/quota-plans-view";
import { t } from "../../../shared/fleet/i18n";

const range = { dayStart: 0, weekStart: 0, now: 1000 };
const pace = { usedPct: 40, elapsedPct: 50, dailyPct: 10, resetsAt: "2030-06-08T00:00:00Z" };

test("Claude spending uses the recent pool forecast and preserves insufficient evidence", () => {
  const recent = classifyClaudeSpend([], {}, range, { ...pace, projectedPct: 150 });
  assert.equal(recent.projectedPct, 150);
  const missing = classifyClaudeSpend([], {}, range, { ...pace, projectedPct: null });
  assert.equal(missing.projectedPct, null);
  assert.ok(claudePaceSentence(missing.projectedPct, missing.dailyCapPct).includes(t("quota.plans.notEnoughData")));
});
