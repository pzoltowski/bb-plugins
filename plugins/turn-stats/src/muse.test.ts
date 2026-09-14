import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeMuseTap, attributeMuseTimings, museSnapshots } from "./muse.ts";
import { applyMuseTiming, applyMuseUsage, computeSessionStats, type EventRow } from "./stats.ts";
import type { DevinTapRecord } from "./devin.ts";

const T0 = 1_700_000_000_000;

function snap(at: number, prompt: number, output: number, cost?: number): DevinTapRecord {
  return {
    at, kind: "usage_update",
    data: {
      used: prompt + output, size: 262_000,
      ...(cost === undefined ? {} : { cost: { amount: cost, currency: "USD", source: "adapter-estimate", basis: "catalog-list-price", billing: false } }),
      meta: { museCumulative: { promptTokens: prompt, outputTokens: output, totalTokens: prompt + output } },
    },
  };
}

void test("museSnapshots extracts cumulative usage_update records in order", () => {
  const records = [
    snap(T0 + 2_000, 5_000, 100),
    { at: T0, kind: "session_open", data: {} },       // filtered: not usage_update
    snap(T0 + 1_000, 2_000, 50),  // out of order — sorted by at
    { at: T0 + 3_000, kind: "usage_update", data: { used: 1, size: 262_000 } }, // no museCumulative — filtered
  ];
  const snaps = museSnapshots(records);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].prompt, 2_000);
  assert.equal(snaps[1].prompt, 5_000);
});

void test("attributeMuseTap diffs cumulative snapshots across turn windows", () => {
  const turns = [
    { startedAt: T0, endedAt: T0 + 10_000 },
    { startedAt: T0 + 20_000, endedAt: T0 + 30_000 },
  ];
  const records = [
    snap(T0 + 9_000, 10_000, 200, 0.05),   // end of turn 1
    snap(T0 + 29_000, 18_000, 450, 0.09),  // end of turn 2
  ];
  const perTurn = attributeMuseTap(records, turns);
  const t1 = perTurn.get(0)!;
  assert.equal(t1.inputTokens, 10_000);
  assert.equal(t1.outputTokens, 200);
  assert.equal(t1.estimatedCostUsd, 0.05);
  const t2 = perTurn.get(1)!;
  assert.equal(t2.inputTokens, 8_000);   // 18k - 10k delta
  assert.equal(t2.outputTokens, 250);    // 450 - 200
  assert.ok(Math.abs((t2.estimatedCostUsd ?? 0) - 0.04) < 1e-9);
});

void test("a restore snapshot before turn 1 becomes the baseline, not usage", () => {
  const turns = [{ startedAt: T0 + 60_000, endedAt: T0 + 70_000 }];
  const records = [
    snap(T0 + 1_000, 50_000, 2_000),       // session/load restore — pre-turn
    snap(T0 + 65_000, 53_000, 2_100),      // turn 1's actual usage: +3k/+100
  ];
  const perTurn = attributeMuseTap(records, turns);
  const t1 = perTurn.get(0)!;
  assert.equal(t1.inputTokens, 3_000);
  assert.equal(t1.outputTokens, 100);
});

void test("turns with no new snapshot contribute nothing", () => {
  const turns = [
    { startedAt: T0, endedAt: T0 + 10_000 },
    { startedAt: T0 + 20_000, endedAt: T0 + 30_000 },   // no snap in window
    { startedAt: T0 + 40_000, endedAt: T0 + 50_000 },
  ];
  const records = [snap(T0 + 9_000, 10_000, 200), snap(T0 + 49_000, 12_000, 260)];
  const perTurn = attributeMuseTap(records, turns);
  assert.equal(perTurn.get(0)?.inputTokens, 10_000);
  assert.equal(perTurn.has(1), false);
  assert.equal(perTurn.get(2)?.inputTokens, 2_000);
});

void test("applyMuseUsage fills usage-less turns and totals, keeps estimate label", () => {
  const rows: EventRow[] = [
    { id: "1", seq: 1, createdAt: T0, type: "turn/started",
      scope: { kind: "turn", turnId: "t1" }, data: {} },
    { id: "2", seq: 2, createdAt: T0 + 10_000, type: "turn/completed",
      scope: { kind: "turn", turnId: "t1" }, data: { status: "completed" } },
  ];
  const session = computeSessionStats(rows);
  const perTurn = new Map([[0, {
    inputTokens: 18_100, outputTokens: 25, estimatedCostUsd: 0.012,
  }]]);
  assert.ok(applyMuseUsage(session, perTurn));
  const t = session.turns[0];
  assert.equal(t.inputTokens, 18_100);
  assert.equal(t.outputTokens, 25);
  assert.equal(t.estimatedCostUsd, 0.012);
  assert.equal(t.costUsd, null);           // muse cost is an estimate, not billing
  assert.equal(t.usageSource, "muse-acp-tap");
  assert.equal(session.usageSource, "muse-acp-tap");
  assert.equal(session.totals?.totalTokens, 18_125);
});

function timing(at: number, promptAt: number, firstChunkAt: number | null, lastChunkAt: number | null, chunks = 12): DevinTapRecord {
  return { at, kind: "turn_timing", data: { promptAt, firstChunkAt, lastChunkAt, chunks } };
}

void test("attributeMuseTimings decomposes turns into ttft/stream/tail", () => {
  const turns = [
    { startedAt: T0, endedAt: T0 + 30_000 },
    { startedAt: T0 + 60_000, endedAt: T0 + 80_000 },
  ];
  const records = [
    // turn 1: prompt at +100ms, first chunk +5.6s, last +14s, result +29.9s
    timing(T0 + 29_900, T0 + 100, T0 + 5_700, T0 + 14_100),
    // turn 2: prompt +60.1s, first chunk +65.7s, last +75s, result +80s
    timing(T0 + 80_000, T0 + 60_100, T0 + 65_700, T0 + 75_000),
  ];
  const perTurn = attributeMuseTimings(records, turns);
  const t1 = perTurn.get(0)!;
  assert.equal(t1.ttftMs, 5_600);
  assert.equal(t1.streamMs, 8_400);
  assert.equal(t1.tailMs, 15_800);
  const t2 = perTurn.get(1)!;
  assert.equal(t2.ttftMs, 5_600);
  assert.equal(t2.tailMs, 5_000);
});

void test("a turn with no result record is skipped without skewing others", () => {
  const turns = [
    { startedAt: T0, endedAt: T0 + 5_000 },              // cancelled — no timing
    { startedAt: T0 + 60_000, endedAt: T0 + 90_000 },
  ];
  const records = [timing(T0 + 89_000, T0 + 60_200, T0 + 66_000, T0 + 80_000)];
  const perTurn = attributeMuseTimings(records, turns);
  assert.equal(perTurn.has(0), false);
  assert.equal(perTurn.get(1)?.ttftMs, 5_800);
});

void test("zero-chunk turns report null timing fields", () => {
  const turns = [{ startedAt: T0, endedAt: T0 + 3_000 }];
  const records = [timing(T0 + 3_000, T0 + 50, null, null, 0)];
  const t = attributeMuseTimings(records, turns).get(0)!;
  assert.equal(t.ttftMs, null);
  assert.equal(t.streamMs, null);
  assert.equal(t.tailMs, null);
});

void test("applyMuseTiming sets fields even on a turn that already has usage", () => {
  const rows: EventRow[] = [
    { id: "1", seq: 1, createdAt: T0, type: "turn/started",
      scope: { kind: "turn", turnId: "t1" }, data: {} },
    { id: "2", seq: 2, createdAt: T0 + 5_000, type: "thread/tokenUsage/updated",
      scope: { kind: "turn", turnId: "t1" },
      data: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 }, total: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 }, modelContextWindow: null } } },
    { id: "3", seq: 3, createdAt: T0 + 30_000, type: "turn/completed",
      scope: { kind: "turn", turnId: "t1" }, data: { status: "completed" } },
  ];
  const session = computeSessionStats(rows);
  assert.equal(session.turns[0].usageCalls, 1);        // native bb usage present
  const timings = new Map([[0, { ttftMs: 4_200, streamMs: 8_000, tailMs: 19_000 }]]);
  assert.ok(applyMuseTiming(session, timings));
  const t = session.turns[0];
  assert.equal(t.ttftMs, 4_200);
  assert.equal(t.streamMs, 8_000);
  assert.equal(t.tailMs, 19_000);
  assert.equal(t.usageSource, "bb-events");            // source untouched
});
