import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateDshCostUsd, isDeepSeekPeak, isDshSessionId, parseDshLog, totalsOf } from "./dsh.ts";
import { attributeToTurns } from "./opencode.ts";
import { applyDshUsage, computeSessionStats, type EventRow } from "./stats.ts";

// Sunday 2026-10-18 and Monday 2026-10-19 (UTC).
const SUNDAY_NOON = Date.UTC(2026, 9, 18, 12);
const MONDAY_0200 = Date.UTC(2026, 9, 19, 2);
const MONDAY_0500 = Date.UTC(2026, 9, 19, 5);
const MONDAY_0700 = Date.UTC(2026, 9, 19, 7);
const FRIDAY_0959 = Date.UTC(2026, 9, 23, 9, 59);
const FRIDAY_1000 = Date.UTC(2026, 9, 23, 10);

test("peak hours are Mon-Fri 01-04 and 06-10 UTC only", () => {
  assert.equal(isDeepSeekPeak(SUNDAY_NOON), false);
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 17, 2)), false); // Saturday 02:00
  assert.equal(isDeepSeekPeak(MONDAY_0200), true);
  assert.equal(isDeepSeekPeak(MONDAY_0500), false);
  assert.equal(isDeepSeekPeak(MONDAY_0700), true);
  assert.equal(isDeepSeekPeak(FRIDAY_0959), true);
  assert.equal(isDeepSeekPeak(FRIDAY_1000), false);
});

test("flash cost: off-peak vs peak doubles, cache hits are cheap", () => {
  const usage = { input: 5988, output: 533, cacheRead: 24576, cacheWrite: 0 };
  const off = estimateDshCostUsd("deepseek-flash", usage, SUNDAY_NOON);
  const peak = estimateDshCostUsd("deepseek-flash", usage, MONDAY_0200);
  // (5988*0.15 + 24576*0.003 + 533*0.6) / 1e6
  assert.ok(off !== null && Math.abs(off - 0.001291728) < 1e-9);
  assert.ok(peak !== null && Math.abs(peak - 2 * off) < 1e-12);
});

test("legacy flash alias is priced as flash; pro is dearer; unknown is null", () => {
  const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(estimateDshCostUsd("deepseek-v4-flash", usage, SUNDAY_NOON), 0.15);
  assert.equal(estimateDshCostUsd("deepseek-v4-pro", usage, SUNDAY_NOON), 0.66);
  assert.equal(estimateDshCostUsd("gpt-5", usage, SUNDAY_NOON), null);
  assert.equal(estimateDshCostUsd(null, usage, SUNDAY_NOON), null);
});

test("cache-write tokens are billed as plain misses", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
  assert.equal(estimateDshCostUsd("deepseek-flash", usage, SUNDAY_NOON), 0.15);
});

test("isDshSessionId accepts uuids only", () => {
  assert.equal(isDshSessionId("39693653-532e-44ea-98fa-d0b49afe87d2"), true);
  assert.equal(isDshSessionId("ses_abc123"), false);
  assert.equal(isDshSessionId("../../etc/passwd"), false);
});

const T0 = SUNDAY_NOON;
const rec = (type: string, time: number, data: Record<string, unknown>) =>
  JSON.stringify({ type, time, data });
const assistant = (time: number, turn: number, step: number, usage: Record<string, number>) =>
  rec("assistant/message", time, {
    turn,
    step,
    usage,
    message: { source: { model: "deepseek-flash" } },
  });

const LOG = [
  rec("turn/start", T0, { turn: 1 }),
  rec("step/start", T0 + 50, { turn: 1, step: 1 }),
  assistant(T0 + 2_050, 1, 1, {
    inputTokens: 24593, outputTokens: 106, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 24699,
  }),
  rec("step/start", T0 + 2_100, { turn: 1, step: 2 }),
  assistant(T0 + 6_100, 1, 2, {
    inputTokens: 5988, outputTokens: 533, cacheReadTokens: 24576, cacheWriteTokens: 0, totalTokens: 31097,
  }),
  rec("turn/end", T0 + 6_110, { turn: 1 }),
  rec("turn/start", T0 + 60_000, { turn: 2 }),
  rec("step/start", T0 + 60_040, { turn: 2, step: 1 }),
  assistant(T0 + 61_040, 2, 1, {
    inputTokens: 700, outputTokens: 20, cacheReadTokens: 30_000, cacheWriteTokens: 0, totalTokens: 30_720,
  }),
  '{"type":"assistant/message","time":', // partial trailing line while dsh is still writing
].join("\n");

test("parseDshLog yields one message per call and ignores a partial last line", () => {
  const messages = parseDshLog(LOG);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].createdAt, T0 + 50);
  assert.equal(messages[0].completedAt, T0 + 2_050);
  assert.equal(messages[1].tokens?.cacheRead, 24_576);
  assert.equal(messages[0].model, "deepseek-flash");
});

test("totalsOf sums every call", () => {
  const totals = totalsOf(parseDshLog(LOG));
  assert.ok(totals);
  assert.equal(totals.input, 24593 + 5988 + 700);
  assert.equal(totals.output, 106 + 533 + 20);
  assert.equal(totals.cacheRead, 24576 + 30000);
  assert.equal(totals.model, "deepseek-flash");
});

test("end to end: calls attribute to bb turns and the cost is an estimate", () => {
  const rows: EventRow[] = [
    { id: "1", seq: 1, createdAt: T0 + 5, type: "turn/started", scope: { kind: "thread" }, data: { turn: { id: "a" } } },
    { id: "2", seq: 2, createdAt: T0 + 6_120, type: "turn/completed", scope: { kind: "thread" }, data: { turn: { id: "a", status: "completed" } } },
    { id: "3", seq: 3, createdAt: T0 + 60_005, type: "turn/started", scope: { kind: "thread" }, data: { turn: { id: "b" } } },
    { id: "4", seq: 4, createdAt: T0 + 61_100, type: "turn/completed", scope: { kind: "thread" }, data: { turn: { id: "b", status: "completed" } } },
  ];
  const session = computeSessionStats(rows);
  const messages = parseDshLog(LOG);
  const per = attributeToTurns(messages, session.turns);
  assert.equal(per.get(0)?.calls, 2);
  assert.equal(per.get(1)?.calls, 1);
  assert.equal(applyDshUsage(session, per, totalsOf(messages)), true);
  assert.equal(session.usageSource, "dsh-local");
  assert.equal(session.turns[0].usageSource, "dsh-local");
  assert.equal(session.turns[0].outputTokens, 106 + 533);
  assert.ok((session.turns[0].estimatedCostUsd ?? 0) > 0);
  assert.equal(session.turns[0].costUsd, null);
  assert.ok((session.estimatedCostUsd ?? 0) > 0);
  assert.equal(session.costUsd, null);
});
