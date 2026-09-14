// turn-stats — pure reduction of BB thread event rows into per-turn stats.
//
// Event sources (normalized BB thread events):
//   turn/started                scope.turnId, createdAt
//   turn/completed              scope.turnId, data.status, createdAt
//   client/turn/requested       data.execution.{model,permissionMode,reasoningLevel}
//   thread/tokenUsage/updated   data.tokenUsage.{last,total} + modelContextWindow
//   thread/contextWindowUsage/updated  data.providerThreadId + contextWindowUsage.{usedTokens,modelContextWindow}
//   system/thread/interrupted   createdAt (marks a still-running turn interrupted)
//
// Usage semantics: `last` is the most recent model call's bucket, `total` the
// thread-cumulative bucket. A turn may contain several calls (tool loops), so a
// turn's output is the SUM of last.outputTokens over in-window events, while
// input/cached/reasoning come from the LAST in-window event — the context the
// model saw at the turn's final call. Session totals come from the newest
// event's `total` bucket.

export type EventScope = { kind: "thread" } | { kind: "turn"; turnId: string };

export interface EventRow {
  id: string;
  seq: number;
  createdAt: number;
  type: string;
  scope: EventScope;
  data: Record<string, unknown>;
}

export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface TurnStat {
  turnId: string;
  /** 0-based position in the thread's turn order. */
  index: number;
  startSeq: number;
  endSeq: number | null;
  startedAt: number;
  endedAt: number | null;
  status: TurnStatus;
  model: string | null;
  permissionMode: string | null;
  reasoningLevel: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  /** How many tokenUsage events contributed to this turn. */
  usageCalls: number;
  estimatedCostUsd: number | null;
  /** Provider-reported cache-write tokens (OpenCode local data only). */
  cacheWriteTokens: number | null;
  /** Provider-reported USD cost (not a price-table estimate). */
  costUsd: number | null;
  /** True decode throughput from per-call timing (local fallback data only). */
  decodeTokPerSec: number | null;
  /** Provider-reported time-to-first-token (Devin tap only). */
  ttftMs: number | null;
  /** Provider-reported cost in ACUs (Devin tap only — not USD). */
  acuCost: number | null;
  /** Where this turn's token numbers came from. */
  usageSource: "bb-events" | "opencode-local" | "devin-acp-tap" | "muse-acp-tap" | null;
  /** Latest context-window snapshot inside this turn, when reported. */
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
}

export interface SessionStats {
  startedAt: number | null;
  lastActivityAt: number | null;
  model: string | null;
  totals: TokenTotals | null;
  estimatedCostUsd: number | null;
  /** Provider-reported session cost (OpenCode local data only). */
  costUsd: number | null;
  /** Dominant usage source across the session. */
  usageSource: "bb-events" | "opencode-local" | "devin-acp-tap" | "muse-acp-tap" | "none";
  /** Latest context-window snapshot for the thread. */
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  turns: TurnStat[];
}

/** Provider session id carried on contextWindowUsage events (e.g. "ses_…"). */
export function extractProviderThreadId(rows: readonly EventRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.type !== "thread/contextWindowUsage/updated") continue;
    const id = (row.data as { providerThreadId?: unknown }).providerThreadId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

interface ModelRequest {
  seq: number;
  model: string;
  permissionMode: string | null;
  reasoningLevel: string | null;
}

interface UsagePoint {
  seq: number;
  createdAt: number;
  turnId: string | null;
  last: TokenTotals;
  total: TokenTotals;
}

interface ContextPoint {
  createdAt: number;
  turnId: string | null;
  used: number;
  size: number;
}

interface MutableTurn extends TurnStat {
  outSum: number;
}

const PRICE_TABLE: ReadonlyArray<{
  match: string;
  inPerM: number;
  cachedPerM: number;
  outPerM: number;
}> = [
  { match: "claude-opus-5", inPerM: 5, cachedPerM: 0.5, outPerM: 25 },
  { match: "claude-opus-4-5", inPerM: 5, cachedPerM: 0.5, outPerM: 25 },
  { match: "claude-opus-4-1", inPerM: 15, cachedPerM: 1.5, outPerM: 75 },
  { match: "claude-opus", inPerM: 15, cachedPerM: 1.5, outPerM: 75 },
  { match: "claude-sonnet", inPerM: 3, cachedPerM: 0.3, outPerM: 15 },
  { match: "claude-haiku-4-5", inPerM: 1, cachedPerM: 0.1, outPerM: 5 },
  { match: "claude-haiku", inPerM: 0.8, cachedPerM: 0.08, outPerM: 4 },
  { match: "codex-mini", inPerM: 1.5, cachedPerM: 0.375, outPerM: 6 },
  { match: "gpt-5", inPerM: 1.25, cachedPerM: 0.125, outPerM: 10 },
  { match: "o4-mini", inPerM: 1.1, cachedPerM: 0.275, outPerM: 4.4 },
  { match: "gemini-3-pro", inPerM: 2, cachedPerM: 0.2, outPerM: 12 },
  { match: "gemini-2.5-pro", inPerM: 1.25, cachedPerM: 0.125, outPerM: 10 },
];

export function estimateCostUsd(
  model: string | null,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number },
): number | null {
  if (model === null) return null;
  const lower = model.toLowerCase();
  const price = PRICE_TABLE.find((entry) => lower.includes(entry.match));
  if (price === undefined) return null;
  const usd =
    (usage.inputTokens * price.inPerM +
      usage.cachedInputTokens * price.cachedPerM +
      (usage.outputTokens + usage.reasoningOutputTokens) * price.outPerM) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

function readTotals(value: unknown): TokenTotals | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const input = raw.inputTokens;
  const output = raw.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return {
    inputTokens: input,
    cachedInputTokens: typeof raw.cachedInputTokens === "number" ? raw.cachedInputTokens : 0,
    outputTokens: output,
    reasoningOutputTokens:
      typeof raw.reasoningOutputTokens === "number" ? raw.reasoningOutputTokens : 0,
    totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : input + output,
  };
}

export function computeSessionStats(rows: readonly EventRow[]): SessionStats {
  const turns: MutableTurn[] = [];
  const byTurnId = new Map<string, MutableTurn>();
  const requests: ModelRequest[] = [];
  const usagePoints: UsagePoint[] = [];
  const contextPoints: ContextPoint[] = [];
  const interrupts: number[] = [];
  let sessionStartedAt: number | null = null;
  let lastActivityAt: number | null = null;

  for (const row of rows) {
    if (lastActivityAt === null || row.createdAt > lastActivityAt) {
      lastActivityAt = row.createdAt;
    }
    if (row.type === "thread/started" && sessionStartedAt === null) {
      sessionStartedAt = row.createdAt;
      continue;
    }
    if (row.type === "client/turn/requested") {
      const execution = (row.data as { execution?: Record<string, unknown> }).execution;
      if (execution && typeof execution.model === "string") {
        requests.push({
          seq: row.seq,
          model: execution.model,
          permissionMode:
            typeof execution.permissionMode === "string" ? execution.permissionMode : null,
          reasoningLevel:
            typeof execution.reasoningLevel === "string" ? execution.reasoningLevel : null,
        });
      }
      continue;
    }
    if (row.type === "thread/contextWindowUsage/updated") {
      const usage = (row.data as { contextWindowUsage?: Record<string, unknown> })
        .contextWindowUsage;
      const used = usage?.usedTokens;
      const size = usage?.modelContextWindow;
      if (typeof used === "number" && typeof size === "number") {
        contextPoints.push({
          createdAt: row.createdAt,
          turnId: row.scope.kind === "turn" ? row.scope.turnId : null,
          used,
          size,
        });
      }
      continue;
    }
    if (row.type === "thread/tokenUsage/updated") {
      const usage = (row.data as { tokenUsage?: Record<string, unknown> }).tokenUsage;
      const last = readTotals(usage?.last);
      const total = readTotals(usage?.total);
      if (last && total) {
        usagePoints.push({
          seq: row.seq,
          createdAt: row.createdAt,
          turnId: row.scope.kind === "turn" ? row.scope.turnId : null,
          last,
          total,
        });
      }
      continue;
    }
    if (row.type === "system/thread/interrupted") {
      interrupts.push(row.createdAt);
      continue;
    }
    if (row.type === "turn/started") {
      const turnId = row.scope.kind === "turn" ? row.scope.turnId : `seq-${row.seq}`;
      let turn = byTurnId.get(turnId);
      if (turn === undefined) {
        turn = {
          turnId,
          index: turns.length,
          startSeq: row.seq,
          endSeq: null,
          startedAt: row.createdAt,
          endedAt: null,
          status: "running",
          model: null,
          permissionMode: null,
          reasoningLevel: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          usageCalls: 0,
          estimatedCostUsd: null,
          cacheWriteTokens: null,
          costUsd: null,
          decodeTokPerSec: null,
          ttftMs: null,
          acuCost: null,
          usageSource: null,
          contextUsedTokens: null,
          contextWindowTokens: null,
          outSum: 0,
        };
        byTurnId.set(turnId, turn);
        turns.push(turn);
      } else {
        // Restarted turn id (providers may reuse ids): keep the earliest start.
        if (row.createdAt < turn.startedAt) turn.startedAt = row.createdAt;
      }
      continue;
    }
    if (row.type === "turn/completed") {
      const statusRaw = (row.data as { status?: string }).status;
      const status: TurnStatus =
        statusRaw === "failed"
          ? "failed"
          : statusRaw === "interrupted"
            ? "interrupted"
            : "completed";
      const turnId = row.scope.kind === "turn" ? row.scope.turnId : null;
      let turn = turnId !== null ? byTurnId.get(turnId) : undefined;
      if (turn === undefined) {
        // Orphan completion (start predates our window) or thread-scoped:
        // attach to the latest still-running turn; else synthesize one.
        turn = [...turns].reverse().find((candidate) => candidate.status === "running");
      }
      if (turn === undefined) {
        turn = {
          turnId: turnId ?? `seq-${row.seq}`,
          index: turns.length,
          startSeq: row.seq,
          endSeq: row.seq,
          startedAt: row.createdAt,
          endedAt: row.createdAt,
          status,
          model: null,
          permissionMode: null,
          reasoningLevel: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          usageCalls: 0,
          estimatedCostUsd: null,
          cacheWriteTokens: null,
          costUsd: null,
          decodeTokPerSec: null,
          ttftMs: null,
          acuCost: null,
          usageSource: null,
          contextUsedTokens: null,
          contextWindowTokens: null,
          outSum: 0,
        };
        byTurnId.set(turn.turnId, turn);
        turns.push(turn);
      }
      turn.status = status;
      turn.endedAt = row.createdAt;
      turn.endSeq = row.seq;
      continue;
    }
  }

  // Keep turn order stable even if a synthesized turn landed out of place.
  turns.sort((a, b) => a.startSeq - b.startSeq);
  turns.forEach((turn, index) => {
    turn.index = index;
  });

  // A still-running turn ended by a thread interruption.
  for (const interruptedAt of interrupts) {
    const running = turns.filter((t) => t.status === "running" && t.startedAt <= interruptedAt);
    const latest = running[running.length - 1];
    if (latest !== undefined) {
      latest.status = "interrupted";
      latest.endedAt = interruptedAt;
    }
  }

  // Turn requests (model/mode) precede their turn/started; assign each to the
  // first following turn that still lacks a model.
  const pendingTurns = [...turns];
  for (const request of requests) {
    const idx = pendingTurns.findIndex((t) => t.model === null && t.startSeq >= request.seq);
    const target = idx === -1 ? pendingTurns.find((t) => t.model === null) : pendingTurns[idx];
    if (target === undefined) continue;
    target.model = request.model;
    target.permissionMode = request.permissionMode;
    target.reasoningLevel = request.reasoningLevel;
    pendingTurns.splice(pendingTurns.indexOf(target), 1);
  }

  // Attribute usage events: scope.turnId wins; otherwise the event lands in
  // the latest turn that started at or before it (final usage often flushes a
  // moment after turn/completed).
  const sortedTurns = [...turns].sort((a, b) => a.startedAt - b.startedAt);
  for (const point of usagePoints) {
    let turn = point.turnId !== null ? byTurnId.get(point.turnId) : undefined;
    if (turn === undefined) {
      for (let i = sortedTurns.length - 1; i >= 0; i -= 1) {
        if (sortedTurns[i].startedAt <= point.createdAt) {
          turn = sortedTurns[i];
          break;
        }
      }
    }
    if (turn === undefined) continue;
    turn.usageCalls += 1;
    turn.inputTokens = point.last.inputTokens;
    turn.cachedInputTokens = point.last.cachedInputTokens;
    turn.reasoningOutputTokens = point.last.reasoningOutputTokens;
    turn.outSum += point.last.outputTokens;
  }

  // Context-window snapshots attribute the same way as usage points.
  for (const point of contextPoints) {
    let turn = point.turnId !== null ? byTurnId.get(point.turnId) : undefined;
    if (turn === undefined) {
      for (let i = sortedTurns.length - 1; i >= 0; i -= 1) {
        if (sortedTurns[i].startedAt <= point.createdAt) {
          turn = sortedTurns[i];
          break;
        }
      }
    }
    if (turn === undefined) continue;
    turn.contextUsedTokens = point.used;
    turn.contextWindowTokens = point.size;
  }

  let sessionCost = 0;
  let sessionCostKnown = false;
  for (const turn of turns) {
    if (turn.usageCalls > 0) {
      turn.outputTokens = turn.outSum;
      turn.usageSource = "bb-events";
    }
    const usage =
      turn.inputTokens !== null
        ? {
            inputTokens: turn.inputTokens,
            cachedInputTokens: turn.cachedInputTokens ?? 0,
            outputTokens: turn.outputTokens ?? 0,
            reasoningOutputTokens: turn.reasoningOutputTokens ?? 0,
          }
        : null;
    turn.estimatedCostUsd =
      usage === null ? null : estimateCostUsd(turn.model, usage);
    if (turn.estimatedCostUsd !== null) {
      sessionCost += turn.estimatedCostUsd;
      sessionCostKnown = true;
    }
  }

  const latestTotal = usagePoints.length > 0 ? usagePoints[usagePoints.length - 1].total : null;
  const latestModel = [...turns].reverse().find((t) => t.model !== null)?.model ?? null;
  const latestContext = contextPoints.length > 0 ? contextPoints[contextPoints.length - 1] : null;

  return {
    startedAt: sessionStartedAt,
    lastActivityAt,
    model: latestModel,
    totals: latestTotal,
    estimatedCostUsd: sessionCostKnown ? Math.round(sessionCost * 10_000) / 10_000 : null,
    costUsd: null,
    usageSource: usagePoints.length > 0 ? "bb-events" : "none",
    contextUsedTokens: latestContext?.used ?? null,
    contextWindowTokens: latestContext?.size ?? null,
    turns: turns.map(({ outSum: _outSum, ...turn }) => turn),
  };
}

/**
 * Fill per-turn usage from OpenCode's local session store. Only applied when
 * BB events carried no token usage at all; native reporting always wins.
 * Numbers are provider-reported, so costUsd/decodeTokPerSec are real — not
 * price-table estimates.
 */
export function applyOpenCodeUsage(
  session: SessionStats,
  perTurn: ReadonlyMap<number, {
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    costUsd: number | null;
    decodeTokPerSec: number | null;
  }>,
  totals: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    model: string | null;
  } | null,
): boolean {
  let anyApplied = false;
  for (const [index, usage] of perTurn) {
    const turn = session.turns[index];
    if (turn === undefined || turn.usageCalls > 0) continue;
    turn.usageCalls = usage.calls;
    turn.inputTokens = usage.inputTokens;
    turn.cachedInputTokens = usage.cachedInputTokens;
    turn.cacheWriteTokens = usage.cacheWriteTokens;
    turn.outputTokens = usage.outputTokens;
    turn.reasoningOutputTokens = usage.reasoningOutputTokens;
    turn.costUsd = usage.costUsd;
    turn.decodeTokPerSec = usage.decodeTokPerSec;
    turn.usageSource = "opencode-local";
    anyApplied = true;
  }
  if (!anyApplied) return false;
  session.usageSource = "opencode-local";
  if (totals !== null) {
    session.totals = {
      inputTokens: totals.input,
      cachedInputTokens: totals.cacheRead,
      outputTokens: totals.output,
      reasoningOutputTokens: totals.reasoning,
      totalTokens: totals.input + totals.cacheRead + totals.output + totals.reasoning,
    };
    session.costUsd = totals.cost;
    if (session.model === null && totals.model !== null) session.model = totals.model;
  } else {
    let cost = 0;
    let known = false;
    for (const turn of session.turns) {
      if (turn.costUsd !== null) {
        cost += turn.costUsd;
        known = true;
      }
    }
    session.costUsd = known ? cost : null;
  }
  return true;
}

/**
 * Fill per-turn usage from the Devin ACP tap (`_cognition.ai/*` records the
 * shim teed to disk). Same contract as applyOpenCodeUsage: only turns with
 * no BB-native usage are touched. agent_stopped stats are provider-measured,
 * so decodeTokPerSec/ttftMs are real — the turn's whole-duration average
 * remains separate.
 */
export function applyDevinUsage(
  session: SessionStats,
  perTurn: ReadonlyMap<number, {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    tokensPerSec: number | null;
    ttftMs: number | null;
    totalTimeMs: number | null;
    model: string | null;
    toolCalls: number | null;
    acuCost: number | null;
  }>,
): boolean {
  let anyApplied = false;
  for (const [index, usage] of perTurn) {
    const turn = session.turns[index];
    if (turn === undefined || turn.usageCalls > 0) continue;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) continue;
    turn.usageCalls = 1;
    turn.inputTokens = usage.inputTokens;
    turn.outputTokens = usage.outputTokens;
    turn.cachedInputTokens = usage.cachedInputTokens;
    turn.decodeTokPerSec = usage.tokensPerSec;
    turn.ttftMs = usage.ttftMs;
    turn.acuCost = usage.acuCost;
    turn.usageSource = "devin-acp-tap";
    if (turn.model === null && usage.model !== null) turn.model = usage.model;
    anyApplied = true;
  }
  if (!anyApplied) return false;
  session.usageSource = "devin-acp-tap";
  // Add devin-sourced turns to whatever BB events already produced.
  let input = session.totals?.inputTokens ?? 0;
  let output = session.totals?.outputTokens ?? 0;
  let cached = session.totals?.cachedInputTokens ?? 0;
  const reasoning = session.totals?.reasoningOutputTokens ?? 0;
  for (const turn of session.turns) {
    if (turn.usageSource !== "devin-acp-tap") continue;
    input += turn.inputTokens ?? 0;
    output += turn.outputTokens ?? 0;
    cached += turn.cachedInputTokens ?? 0;
  }
  session.totals = {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: input + cached + output + reasoning,
  };
  return true;
}

/**
 * Fill per-turn usage from a Muse (muse-acp) tap file. The adapter reports
 * cumulative session totals on each usage_update; src/muse.ts has already
 * diffed them into per-turn deltas. Only usage-less turns are touched.
 * The adapter's cost is a catalog list-price estimate — still "est.", just
 * computed upstream with real rates instead of our bundled table.
 */
export function applyMuseUsage(
  session: SessionStats,
  perTurn: ReadonlyMap<number, {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
  }>,
): boolean {
  let anyApplied = false;
  for (const [index, usage] of perTurn) {
    const turn = session.turns[index];
    if (turn === undefined || turn.usageCalls > 0) continue;
    if (usage.inputTokens === 0 && usage.outputTokens === 0) continue;
    turn.usageCalls = 1;
    turn.inputTokens = usage.inputTokens;
    turn.outputTokens = usage.outputTokens;
    if (usage.estimatedCostUsd !== null) {
      turn.estimatedCostUsd = usage.estimatedCostUsd;
    }
    turn.usageSource = "muse-acp-tap";
    anyApplied = true;
  }
  if (!anyApplied) return false;
  session.usageSource = "muse-acp-tap";
  let input = session.totals?.inputTokens ?? 0;
  let output = session.totals?.outputTokens ?? 0;
  const cached = session.totals?.cachedInputTokens ?? 0;
  const reasoning = session.totals?.reasoningOutputTokens ?? 0;
  let est = session.estimatedCostUsd ?? 0;
  let estKnown = session.estimatedCostUsd !== null;
  for (const turn of session.turns) {
    if (turn.usageSource !== "muse-acp-tap") continue;
    input += turn.inputTokens ?? 0;
    output += turn.outputTokens ?? 0;
    if (turn.estimatedCostUsd !== null) {
      est += turn.estimatedCostUsd;
      estKnown = true;
    }
  }
  session.totals = {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: input + cached + output + reasoning,
  };
  session.estimatedCostUsd = estKnown ? est : null;
  return true;
}
