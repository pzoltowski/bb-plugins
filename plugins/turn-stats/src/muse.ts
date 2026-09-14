// Muse (muse-acp) tap reader.
//
// muse-acp reports usage as cumulative session totals on every usage_update:
//   update._meta.museCumulative.{promptTokens, outputTokens, totalTokens}
// plus an optional adapter-estimated list-price cost:
//   update.cost.{amount, currency, source:"adapter-estimate", billing:false}
//
// Per-turn usage is the DELTA between consecutive cumulative snapshots —
// the adapter dedupes replayed completions (`usage_seen`), so each snapshot
// counts every model call exactly once and diffing across a turn boundary
// yields that turn's real input/output and estimated cost.
//
// Detection: a tap file exists at <acpTapDir>/<providerThreadId>.jsonl AND
// its usage_update records carry meta.museCumulative. Records are written by
// whatever tapped provider spawned the session (muse-code's launch spec).

import type { DevinTapRecord } from "./devin.ts";

export interface MuseTurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Adapter catalog-list-price estimate — still an estimate, not billing. */
  estimatedCostUsd: number | null;
}

interface Snap {
  at: number;
  prompt: number;
  output: number;
  cost: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Extract the cumulative snapshots from usage_update records, in time order. */
export function museSnapshots(records: readonly DevinTapRecord[]): Snap[] {
  const snaps: Snap[] = [];
  for (const r of records) {
    if (r.kind !== "usage_update") continue;
    const meta = r.data.meta as Record<string, unknown> | undefined;
    const cum = meta?.museCumulative as Record<string, unknown> | undefined;
    if (cum === undefined) continue;
    const prompt = num(cum.promptTokens);
    const output = num(cum.outputTokens);
    if (prompt === null || output === null) continue;
    const cost = r.data.cost as Record<string, unknown> | undefined;
    snaps.push({
      at: r.at,
      prompt,
      output,
      cost: cost ? num(cost.amount) : null,
    });
  }
  return snaps.sort((a, b) => a.at - b.at);
}

/**
 * Per-turn delta: the cumulative snapshot at the end of the turn window minus
 * the last snapshot before the window. Turns with no snapshot after their
 * start contribute nothing (their usage folds into the next snapshot).
 */
export function attributeMuseTap(
  records: readonly DevinTapRecord[],
  turns: readonly { startedAt: number; endedAt: number | null }[],
): Map<number, MuseTurnUsage> {
  const SLACK_MS = 15_000;
  const result = new Map<number, MuseTurnUsage>();
  const snaps = museSnapshots(records);
  const sorted = turns
    .map((t, index) => ({ startedAt: t.startedAt, endedAt: t.endedAt, index }))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (snaps.length === 0 || sorted.length === 0) return result;

  const lastBefore = (at: number, strict: boolean): Snap | null => {
    let hit: Snap | null = null;
    for (const s of snaps) {
      if (strict ? s.at < at : s.at <= at) hit = s;
      else break;
    }
    return hit;
  };

  for (const turn of sorted) {
    const end = turn.endedAt ?? Date.now();
    const endSnap = lastBefore(end + SLACK_MS, false);
    if (endSnap === null || endSnap.at < turn.startedAt - SLACK_MS) continue;
    // Baseline = previous turn's end snapshot — strictly before this turn's
    // start, no slack: slack here would eat a legit baseline in the window.
    const startSnap = lastBefore(turn.startedAt, true);
    const dIn = endSnap.prompt - (startSnap?.prompt ?? 0);
    const dOut = endSnap.output - (startSnap?.output ?? 0);
    const dCost =
      endSnap.cost !== null
        ? endSnap.cost - (startSnap?.cost ?? 0)
        : null;
    if (dIn <= 0 && dOut <= 0) continue;
    result.set(turn.index, {
      inputTokens: dIn,
      outputTokens: dOut,
      estimatedCostUsd: dCost !== null && dCost >= 0 ? dCost : null,
    });
  }
  return result;
}

export interface MuseTurnTiming {
  /** Wire-measured: prompt dispatch → first content chunk. */
  ttftMs: number | null;
  /** Wire-measured: first → last chunk — the generation window. */
  streamMs: number | null;
  /** Wire-measured: last chunk → prompt result (adapter settle/wind-down). */
  tailMs: number | null;
  /** Content chunks observed on the wire. */
  chunks: number;
}

interface TimingRec {
  /** Prompt result arrival — ≈ bb's turn completion instant. */
  at: number;
  promptAt: number;
  firstChunkAt: number | null;
  lastChunkAt: number | null;
  chunks: number;
}

/** Extract turn_timing records (emitted by the shim per prompt result). */
export function museTurnTimings(
  records: readonly DevinTapRecord[],
): TimingRec[] {
  const out: TimingRec[] = [];
  for (const r of records) {
    if (r.kind !== "turn_timing") continue;
    const promptAt = num(r.data.promptAt);
    if (promptAt === null) continue;
    out.push({
      at: r.at,
      promptAt,
      firstChunkAt: num(r.data.firstChunkAt),
      lastChunkAt: num(r.data.lastChunkAt),
      chunks: num(r.data.chunks) ?? 0,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Match each turn_timing to the bb turn it belongs to. A timing's promptAt is
 * the instant bb's bridge dispatched session/prompt (≈ turn start) and its at
 * is the instant the result arrived (≈ turn end) — anchor on whichever is
 * closer, consume-once so a cancelled turn with no result can't skew the rest.
 */
export function attributeMuseTimings(
  records: readonly DevinTapRecord[],
  turns: readonly { startedAt: number; endedAt: number | null }[],
): Map<number, MuseTurnTiming> {
  const SLACK_MS = 30_000;
  const result = new Map<number, MuseTurnTiming>();
  const timings = museTurnTimings(records);
  const sorted = turns
    .map((t, index) => ({ startedAt: t.startedAt, endedAt: t.endedAt, index }))
    .sort((a, b) => a.startedAt - b.startedAt);
  const used = new Set<number>();

  for (const turn of sorted) {
    let best = -1;
    let bestScore = SLACK_MS;
    for (let i = 0; i < timings.length; i++) {
      if (used.has(i)) continue;
      const t = timings[i];
      const dStart = Math.abs(t.promptAt - turn.startedAt);
      const dEnd =
        turn.endedAt !== null ? Math.abs(t.at - turn.endedAt) : Infinity;
      const score = Math.min(dStart, dEnd);
      if (score <= bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) continue;
    used.add(best);
    const t = timings[best];
    result.set(turn.index, {
      ttftMs:
        t.firstChunkAt !== null ? Math.max(0, t.firstChunkAt - t.promptAt) : null,
      streamMs:
        t.firstChunkAt !== null && t.lastChunkAt !== null
          ? Math.max(0, t.lastChunkAt - t.firstChunkAt)
          : null,
      tailMs:
        t.lastChunkAt !== null ? Math.max(0, t.at - t.lastChunkAt) : null,
      chunks: t.chunks,
    });
  }
  return result;
}
