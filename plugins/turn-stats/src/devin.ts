// Devin ACP tap fallback.
//
// `devin acp` emits per-turn usage the generic bridge never maps:
//   - result.usage on session/prompt   (draft end-turn usage shape)
//   - usage_update._meta               (cognition.ai/inputTokens|outputTokens)
//   - _cognition.ai/agent_stopped      (input/output tokens, ttftMs,
//                                      tokensPerSec, totalTimeMs, modelLabel)
//   - _cognition.ai/turn_stats         (full Response Statistics payload)
//   - _cognition.ai/billingInformation (ACU/credit cost, when reported)
//
// The acp-tap shim (registered as provider `acp-devin-tap`) proxies the wire
// unchanged and tees those messages into <tapDir>/<sessionId>.jsonl. The ACP
// sessionId is BB's providerThreadId, so this module reads that file and
// attributes records to BB turns by timestamp — same approach as OpenCode.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEVIN_TAP_PROVIDER_ID = "acp-devin-tap";

export function devinTapDir(): string {
  return join(homedir(), ".bb", "plugins", "turn-stats", "acp-tap");
}

export function devinTapPath(sessionId: string): string {
  return join(devinTapDir(), `${sessionId}.jsonl`);
}

export interface DevinTapRecord {
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface DevinTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Provider-measured decode speed (agent_stopped.stats.tokensPerSec). */
  tokensPerSec: number | null;
  ttftMs: number | null;
  totalTimeMs: number | null;
  model: string | null;
  toolCalls: number | null;
  /** Real cost when billingInformation reports one (ACU units). */
  acuCost: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Read and parse the tap JSONL for a session. Missing/corrupt → null. */
export function readDevinTap(sessionId: string): DevinTapRecord[] | null {
  const path = devinTapPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const records: DevinTapRecord[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (typeof r.at === "number" && typeof r.kind === "string") {
          records.push(r as DevinTapRecord);
        }
      } catch {
        // partial/corrupt line — skip, keep the rest
      }
    }
    return records;
  } catch {
    return null;
  }
}

/**
 * Attribute tap records to BB turns. agent_stopped/turn_stats arrive at turn
 * end; each joins the latest turn that started at or before it (slack for
 * bridge/store clock skew), matching the OpenCode strategy.
 */
export function attributeDevinTap(
  records: readonly DevinTapRecord[],
  turns: readonly { startedAt: number }[],
): Map<number, DevinTurnUsage> {
  const SLACK_MS = 15_000;
  const result = new Map<number, DevinTurnUsage>();
  const sorted = turns
    .map((t, index) => ({ startedAt: t.startedAt, index }))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (sorted.length === 0) return result;

  const owner = (at: number): number | null => {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].startedAt - SLACK_MS <= at) return sorted[i].index;
    }
    return null;
  };
  const slot = (index: number): DevinTurnUsage => {
    let u = result.get(index);
    if (u === undefined) {
      u = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        tokensPerSec: null,
        ttftMs: null,
        totalTimeMs: null,
        model: null,
        toolCalls: null,
        acuCost: null,
      };
      result.set(index, u);
    }
    return u;
  };

  for (const r of records) {
    const index = owner(r.at);
    if (index === null) continue;
    const u = slot(index);
    if (r.kind === "agent_stopped") {
      const s = (r.data.stats ?? r.data) as Record<string, unknown>;
      // agent_stopped is a per-turn summary; latest record wins, do not sum.
      const input = num(s.inputTokens ?? s.input_tokens);
      const output = num(s.outputTokens ?? s.output_tokens);
      if (input !== null) u.inputTokens = input;
      if (output !== null) u.outputTokens = output;
      const tps = num(s.tokensPerSec ?? s.tokens_per_sec);
      if (tps !== null) u.tokensPerSec = tps;
      const ttft = num(s.ttftMs ?? s.ttft_ms);
      if (ttft !== null) u.ttftMs = ttft;
      const total = num(s.totalTimeMs ?? s.total_time_ms);
      if (total !== null) u.totalTimeMs = total;
      if (typeof s.modelLabel === "string") u.model = s.modelLabel;
      const tools = num(s.toolCalls ?? s.tool_calls);
      if (tools !== null) u.toolCalls = tools;
      const acu = num(s.committed_acu_cost ?? s.committedAcuCost);
      if (acu !== null) u.acuCost = acu;
    } else if (r.kind === "prompt_usage") {
      // Same turn totals as agent_stopped — fill gaps only, never add.
      const usage = (r.data.usage ?? {}) as Record<string, unknown>;
      const meta = (r.data.meta ?? {}) as Record<string, unknown>;
      if (u.inputTokens === 0) {
        u.inputTokens =
          num(usage.inputTokens) ?? num(meta["cognition.ai/inputTokens"]) ?? 0;
      }
      if (u.outputTokens === 0) {
        u.outputTokens =
          num(usage.outputTokens) ?? num(meta["cognition.ai/outputTokens"]) ?? 0;
      }
    } else if (r.kind === "billingInformation") {
      const acu = num(
        r.data.committed_acu_cost ?? r.data.committedAcuCost ?? r.data.acuCost,
      );
      if (acu !== null) u.acuCost = acu;
    } else if (r.kind === "turn_stats") {
      // Response Statistics table: mine cumulativeMetric dims by uid for
      // cached-input and as a token fallback when agent_stopped is absent.
      const dims = r.data.responseDimensions;
      if (Array.isArray(dims)) {
        for (const d of dims) {
          const dim = d as Record<string, unknown>;
          const kind = dim.kind as Record<string, unknown> | undefined;
          const value = num(kind?.value);
          if (value === null) continue;
          if (dim.uid === "cached_input_tokens") {
            u.cachedInputTokens = value;
          } else if (dim.uid === "input_tokens" && u.inputTokens === 0) {
            u.inputTokens = value;
          } else if (dim.uid === "output_tokens" && u.outputTokens === 0) {
            u.outputTokens = value;
          }
        }
      }
    }
  }
  return result;
}
