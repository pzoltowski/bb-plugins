import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSessionStats,
  estimateCostUsd,
  type EventRow,
  type TokenTotals,
} from "./stats.ts";

let seq = 0;
function ev(
  type: string,
  createdAt: number,
  opts: { turnId?: string; data?: Record<string, unknown> } = {},
): EventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    createdAt,
    type,
    scope: opts.turnId === undefined ? { kind: "thread" } : { kind: "turn", turnId: opts.turnId },
    data: opts.data ?? {},
  };
}

function totals(over: Partial<TokenTotals> = {}): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...over,
  };
}

function usage(last: Partial<TokenTotals>, total: Partial<TokenTotals>) {
  return { tokenUsage: { last: totals(last), total: totals(total), modelContextWindow: null } };
}

test("reduces a two-turn thread into per-turn stats", () => {
  seq = 0;
  const rows = [
    ev("thread/started", 1_000),
    ev("client/turn/requested", 1_100, {
      data: { execution: { model: "claude-sonnet-4-5", permissionMode: "full", reasoningLevel: "medium" } },
    }),
    ev("turn/started", 1_200, { turnId: "t1" }),
    ev("thread/tokenUsage/updated", 5_000, {
      turnId: "t1",
      data: usage(
        { inputTokens: 3_000, cachedInputTokens: 2_000, outputTokens: 200, reasoningOutputTokens: 40 },
        { inputTokens: 3_000, cachedInputTokens: 2_000, outputTokens: 200, reasoningOutputTokens: 40 },
      ),
    }),
    ev("turn/completed", 10_000, { turnId: "t1", data: { status: "completed" } }),
    ev("client/turn/requested", 10_100, {
      data: { execution: { model: "claude-sonnet-4-5" } },
    }),
    ev("turn/started", 10_500, { turnId: "t2" }),
    // two model calls inside turn 2: input comes from the LAST call,
    // output sums across calls
    ev("thread/tokenUsage/updated", 12_000, {
      turnId: "t2",
      data: usage(
        { inputTokens: 3_200, cachedInputTokens: 3_000, outputTokens: 100 },
        { inputTokens: 6_200, cachedInputTokens: 5_000, outputTokens: 300, reasoningOutputTokens: 40 },
      ),
    }),
    ev("thread/tokenUsage/updated", 18_000, {
      turnId: "t2",
      data: usage(
        { inputTokens: 3_400, cachedInputTokens: 3_300, outputTokens: 150, reasoningOutputTokens: 20 },
        { inputTokens: 9_600, cachedInputTokens: 8_300, outputTokens: 450, reasoningOutputTokens: 60 },
      ),
    }),
    ev("turn/completed", 20_000, { turnId: "t2", data: { status: "completed" } }),
  ];
  const stats = computeSessionStats(rows);

  assert.equal(stats.startedAt, 1_000);
  assert.equal(stats.lastActivityAt, 20_000);
  assert.equal(stats.model, "claude-sonnet-4-5");
  assert.equal(stats.turns.length, 2);

  const t1 = stats.turns[0];
  assert.equal(t1.status, "completed");
  assert.equal(t1.endedAt! - t1.startedAt, 8_800);
  assert.equal(t1.inputTokens, 3_000);
  assert.equal(t1.cachedInputTokens, 2_000);
  assert.equal(t1.outputTokens, 200);
  assert.equal(t1.reasoningOutputTokens, 40);
  assert.equal(t1.model, "claude-sonnet-4-5");

  const t2 = stats.turns[1];
  assert.equal(t2.inputTokens, 3_400, "input from last in-turn call");
  assert.equal(t2.outputTokens, 250, "output summed over calls");
  assert.equal(t2.reasoningOutputTokens, 20);

  assert.equal(stats.totals?.outputTokens, 450, "session totals from newest total bucket");
  assert.ok(stats.estimatedCostUsd !== null && stats.estimatedCostUsd > 0);
});

test("usage arriving after turn/completed attributes by time window", () => {
  seq = 0;
  const rows = [
    ev("turn/started", 1_000, { turnId: "t1" }),
    ev("turn/completed", 9_000, { turnId: "t1", data: { status: "completed" } }),
    // thread-scoped flush arriving after completion
    ev("thread/tokenUsage/updated", 9_200, {
      data: usage(
        { inputTokens: 1_000, outputTokens: 80 },
        { inputTokens: 1_000, outputTokens: 80 },
      ),
    }),
  ];
  const stats = computeSessionStats(rows);
  assert.equal(stats.turns[0].outputTokens, 80);
});

test("failed and interrupted turns keep status; running turns stay open", () => {
  seq = 0;
  const rows = [
    ev("turn/started", 1_000, { turnId: "t1" }),
    ev("turn/completed", 2_000, { turnId: "t1", data: { status: "failed" } }),
    ev("turn/started", 3_000, { turnId: "t2" }),
    ev("system/thread/interrupted", 4_000),
    ev("turn/started", 5_000, { turnId: "t3" }),
  ];
  const stats = computeSessionStats(rows);
  assert.deepEqual(stats.turns.map((t) => t.status), ["failed", "interrupted", "running"]);
  assert.equal(stats.turns[2].endedAt, null);
});

test("no usage rows → null tokens, null cost", () => {
  seq = 0;
  const stats = computeSessionStats([
    ev("turn/started", 1_000, { turnId: "t1" }),
    ev("turn/completed", 2_000, { turnId: "t1", data: { status: "completed" } }),
  ]);
  const t = stats.turns[0];
  assert.equal(t.inputTokens, null);
  assert.equal(t.outputTokens, null);
  assert.equal(t.estimatedCostUsd, null);
  assert.equal(stats.totals, null);
  assert.equal(stats.estimatedCostUsd, null);
});

test("cost estimation: known model prices, unknown model → null", () => {
  const cost = estimateCostUsd("anthropic/claude-sonnet-4-5", {
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningOutputTokens: 0,
  });
  // 1M in @ $3 + 1M cached @ $0.30 + 1M out @ $15
  assert.equal(cost, 18.3);
  assert.equal(
    estimateCostUsd("local/some-obscure-model", {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    }),
    null,
  );
  assert.equal(
    estimateCostUsd(null, {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    }),
    null,
  );
});
