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
