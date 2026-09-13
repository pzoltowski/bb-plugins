import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeToTurns, isOpenCodeSessionId, type OpenCodeMessage } from "./opencode.ts";
import { applyOpenCodeUsage, computeSessionStats, type EventRow } from "./stats.ts";

let t = 1_700_000_000_000;
function msg(
  role: string,
  createdAt: number,
  tokens: OpenCodeMessage["tokens"],
  opts: { completedAt?: number; cost?: number } = {},
): OpenCodeMessage {
  return {
    role,
    createdAt,
    completedAt: opts.completedAt ?? null,
    tokens,
    cost: opts.cost ?? null,
    model: null,
  };
}

const tok = (input: number, output: number, over: Partial<NonNullable<OpenCodeMessage["tokens"]>> = {}) => ({
  input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...over,
});

test("attributeToTurns assigns calls to the turn whose window contains them", () => {
  const turns = [{ startedAt: t }, { startedAt: t + 60_000 }];
  const messages = [
    msg("user", t + 100, null),
    msg("assistant", t + 200, tok(1000, 100), { completedAt: t + 2200, cost: 0.01 }),
    msg("assistant", t + 3000, tok(1200, 50), { completedAt: t + 4000, cost: 0.02 }),
    msg("user", t + 60_000, null),
    msg("assistant", t + 60_500, tok(2000, 200), { completedAt: t + 62_000, cost: 0.03 }),
  ];
  const per = attributeToTurns(messages, turns);
  const t0 = per.get(0);
  const t1 = per.get(1);
  assert.ok(t0 && t1);
  assert.equal(t0.calls, 2);
  assert.equal(t0.outputTokens, 150);
  assert.equal(t0.inputTokens, 1200); // last call's input
  assert.equal(t0.costUsd, 0.03);
  assert.equal(t1.calls, 1);
  assert.equal(t1.outputTokens, 200);
  // decode: t0 = 150 out / (2000+1000)ms = 50 tok/s; t1 = 200/1500ms
  assert.ok(Math.abs((t0.decodeTokPerSec ?? 0) - 50) < 0.001);
  assert.ok(Math.abs((t1.decodeTokPerSec ?? 0) - 133.333) < 0.01);
});

test("attributeToTurns ignores pre-first-turn history and non-assistant roles", () => {
  const turns = [{ startedAt: t + 10_000 }];
  const messages = [
    msg("assistant", t, tok(500, 500), { completedAt: t + 1000 }), // before turn start beyond slack? 10s<15s slack → included
    msg("assistant", t - 60_000, tok(9, 9), { completedAt: t - 59_000 }), // way before → dropped
    msg("user", t + 10_100, null),
  ];
  const per = attributeToTurns(messages, turns);
  const agg = per.get(0);
  assert.ok(agg);
  assert.equal(agg.calls, 1); // only the in-slack call
  assert.equal(agg.outputTokens, 500);
});

test("isOpenCodeSessionId validates strictly", () => {
  assert.ok(isOpenCodeSessionId("ses_f9238301affefLhYp92qgzcNca"));
  assert.ok(!isOpenCodeSessionId("rebel-anchovy"));
  assert.ok(!isOpenCodeSessionId("ses_x'; DROP TABLE message;--"));
  assert.ok(!isOpenCodeSessionId(""));
});

test("applyOpenCodeUsage fills only usage-less turns and keeps bb data", () => {
  const rows: EventRow[] = [
    {
      id: "e1", seq: 1, createdAt: t, type: "turn/started",
      scope: { kind: "turn", turnId: "t1" }, data: {},
    },
    {
      id: "e2", seq: 2, createdAt: t + 5000, type: "turn/completed",
      scope: { kind: "turn", turnId: "t1" }, data: { status: "completed" },
    },
  ];
  const session = computeSessionStats(rows);
  assert.equal(session.usageSource, "none");
  const per = new Map([[0, {
    calls: 3, inputTokens: 22000, cachedInputTokens: 1500, cacheWriteTokens: 0,
    outputTokens: 400, reasoningOutputTokens: 100, costUsd: 0.05, decodeTokPerSec: 42.5,
  }]]);
  const applied = applyOpenCodeUsage(session, per, {
    input: 50000, output: 900, reasoning: 200, cacheRead: 3000, cacheWrite: 0,
    cost: 0.11, model: "muse-spark-1.3",
  });
  assert.ok(applied);
  const turn = session.turns[0];
  assert.equal(turn.usageSource, "opencode-local");
  assert.equal(turn.inputTokens, 22000);
  assert.equal(turn.decodeTokPerSec, 42.5);
  assert.equal(turn.costUsd, 0.05);
  assert.equal(turn.estimatedCostUsd, null); // real cost replaces estimate
  assert.equal(session.usageSource, "opencode-local");
  assert.equal(session.costUsd, 0.11);
  assert.equal(session.totals?.outputTokens, 900);
  assert.equal(session.model, "muse-spark-1.3");
});
