import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeDevinTap, type DevinTapRecord } from "./devin.ts";
import { applyDevinUsage, computeSessionStats, type EventRow } from "./stats.ts";

const T0 = 1_700_000_000_000;

function rec(at: number, kind: string, data: Record<string, unknown>): DevinTapRecord {
  return { at, kind, data };
}

function agentStopped(at: number, stats: Record<string, unknown>): DevinTapRecord {
  return rec(at, "agent_stopped", { cause: "complete", stats });
}

void test("attributeDevinTap assigns records to the turn whose window contains them", () => {
  const turns = [{ startedAt: T0 }, { startedAt: T0 + 60_000 }];
  const records = [
    agentStopped(T0 + 5_000, {
      inputTokens: 14_688, outputTokens: 37, ttftMs: 7_084,
      tokensPerSec: 411.5, totalTimeMs: 7_093, modelLabel: "SWE-2 Max",
      toolCalls: 0, committed_acu_cost: 0.004,
    }),
    rec(T0 + 5_100, "prompt_usage", {
      usage: { totalTokens: 14_725, inputTokens: 14_688, outputTokens: 37 },
      stopReason: "end_turn",
    }),
    agentStopped(T0 + 62_000, {
      inputTokens: 30_000, outputTokens: 500, tokensPerSec: 250,
      ttftMs: 1_200, totalTimeMs: 5_000, modelLabel: "SWE-2 Max", toolCalls: 2,
    }),
  ];
  const perTurn = attributeDevinTap(records, turns);
  assert.equal(perTurn.size, 2);
  const t0 = perTurn.get(0)!;
  assert.equal(t0.inputTokens, 14_688);
  assert.equal(t0.outputTokens, 37);
  assert.equal(t0.tokensPerSec, 411.5);
  assert.equal(t0.ttftMs, 7_084);
  assert.equal(t0.model, "SWE-2 Max");
  assert.equal(t0.acuCost, 0.004);
  const t1 = perTurn.get(1)!;
  assert.equal(t1.inputTokens, 30_000);
  assert.equal(t1.outputTokens, 500);
  assert.equal(t1.toolCalls, 2);
});

void test("prompt_usage fills gaps but never double-counts agent_stopped", () => {
  const turns = [{ startedAt: T0 }];
  // prompt_usage arrives AFTER agent_stopped — same turn totals, must not add.
  const records = [
    agentStopped(T0 + 1_000, { inputTokens: 100, outputTokens: 50 }),
    rec(T0 + 1_100, "prompt_usage", {
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    rec(T0 + 1_200, "billingInformation", { committed_acu_cost: 0.02 }),
  ];
  const perTurn = attributeDevinTap(records, turns);
  const u = perTurn.get(0)!;
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.acuCost, 0.02);
});

void test("prompt_usage alone still yields tokens when agent_stopped is absent", () => {
  const turns = [{ startedAt: T0 }];
  const records = [
    rec(T0 + 2_000, "prompt_usage", {
      usage: { inputTokens: 5_000, outputTokens: 200 },
    }),
  ];
  const perTurn = attributeDevinTap(records, turns);
  const u = perTurn.get(0)!;
  assert.equal(u.inputTokens, 5_000);
  assert.equal(u.outputTokens, 200);
  assert.equal(u.tokensPerSec, null);
});

void test("usage_update _meta tokens feed prompt-less turns", () => {
  const turns = [{ startedAt: T0 }];
  const records = [
    rec(T0 + 3_000, "usage_update", {
      used: 14_725, size: 262_000,
      meta: { "cognition.ai/inputTokens": 14_688, "cognition.ai/outputTokens": 37 },
    }),
  ];
  // usage_update kind alone doesn't fill tokens (handled by prompt_usage meta)
  const perTurn = attributeDevinTap(records, turns);
  assert.equal(perTurn.get(0)?.inputTokens ?? 0, 0);
});

void test("turn_stats dims fill cached input and token gaps", () => {
  const turns = [{ startedAt: T0 }];
  const dim = (uid: string, value: unknown) => ({
    uid, groupTitle: "Token Usage", label: uid,
    kind: { type: "cumulativeMetric", value, tail: " token", pluralTail: " tokens" },
  });
  const records = [
    rec(T0 + 4_000, "turn_stats", { responseDimensions: [
      dim("input_tokens", 9_000), dim("output_tokens", 300),
      dim("cached_input_tokens", 7_500), dim("model", "SWE-2 Max"),
    ] }),
  ];
  const u = attributeDevinTap(records, turns).get(0)!;
  assert.equal(u.inputTokens, 9_000);
  assert.equal(u.outputTokens, 300);
  assert.equal(u.cachedInputTokens, 7_500);
});

void test("records predating the first turn are ignored", () => {
  const turns = [{ startedAt: T0 + 60_000 }];
  const records = [agentStopped(T0, { inputTokens: 1, outputTokens: 1 })];
  assert.equal(attributeDevinTap(records, turns).size, 0);
});

void test("applyDevinUsage fills only usage-less turns and keeps bb data", () => {
  const rows: EventRow[] = [
    { id: "1", seq: 1, createdAt: T0, type: "turn/started",
      scope: { kind: "turn", turnId: "t1" }, data: {} },
    { id: "2", seq: 2, createdAt: T0 + 10_000, type: "turn/completed",
      scope: { kind: "turn", turnId: "t1" }, data: { status: "completed" } },
    { id: "3", seq: 3, createdAt: T0 + 20_000, type: "turn/started",
      scope: { kind: "turn", turnId: "t2" }, data: {} },
    { id: "4", seq: 4, createdAt: T0 + 21_000, type: "thread/tokenUsage/updated",
      scope: { kind: "turn", turnId: "t2" },
      data: { tokenUsage: { last: { inputTokens: 99, outputTokens: 9 },
        total: { inputTokens: 99, outputTokens: 9 }, modelContextWindow: null } } },
    { id: "5", seq: 5, createdAt: T0 + 30_000, type: "turn/completed",
      scope: { kind: "turn", turnId: "t2" }, data: { status: "completed" } },
  ];
  const session = computeSessionStats(rows);
  const perTurn = new Map([
    [0, { inputTokens: 14_688, outputTokens: 37, cachedInputTokens: 3_000,
          tokensPerSec: 411.5,
          ttftMs: 7_084, totalTimeMs: 7_093, model: "SWE-2 Max",
          toolCalls: 0, acuCost: 0.004 }],
    [1, { inputTokens: 30_000, outputTokens: 500, cachedInputTokens: 0,
          tokensPerSec: null,
          ttftMs: null, totalTimeMs: null, model: null,
          toolCalls: null, acuCost: null }],
  ]);
  assert.ok(applyDevinUsage(session, perTurn));
  const [t1, t2] = session.turns;
  assert.equal(t1.inputTokens, 14_688);
  assert.equal(t1.outputTokens, 37);
  assert.equal(t1.decodeTokPerSec, 411.5);
  assert.equal(t1.ttftMs, 7_084);
  assert.equal(t1.acuCost, 0.004);
  assert.equal(t1.model, "SWE-2 Max");
  assert.equal(t1.usageSource, "devin-acp-tap");
  // t2 has BB-native usage — tap must not overwrite it.
  assert.equal(t2.inputTokens, 99);
  assert.equal(t2.usageSource, "bb-events");
  assert.equal(session.usageSource, "devin-acp-tap");
  assert.equal(session.totals?.inputTokens, 14_688 + 99);
  assert.equal(session.totals?.cachedInputTokens, 3_000);
  assert.equal(t1.cachedInputTokens, 3_000);
});
