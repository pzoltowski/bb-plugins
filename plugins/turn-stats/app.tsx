// bb-plugin-turn-stats — UI side.
//
// Three surfaces, one data path (`useThreadStats` → getThreadStats RPC,
// refreshed by "turn-stats" realtime publishes from the server tailer):
//   1. experimental_threadHeaderAction — chart icon; hover shows the latest
//      turn's breakdown card, click opens the side panel.
//   2. messageAction — "Turn stats" on the per-message hover bar; opens the
//      panel focused on that message's turn (matched via sourceSeqEnd).
//   3. threadPanelAction — the per-turn history list.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRpc,
  useSettings,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadStats, TurnStatResult } from "./server";

const CHANNEL = "turn-stats";
const PANEL_ACTION_ID = "turn-stats";
const PANEL_TITLE = "Turn stats";

const SEG = {
  input: "#8a6fd8",
  cached: "#4a8f6d",
  reasoning: "#d9a04b",
  output: "#7b9bff",
} as const;

const countFmt = new Intl.NumberFormat();

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h ago` : `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTok(n: number | null): string {
  if (n === null) return "—";
  if (n < 1_000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n / 1_000_000)}m`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "";
  return usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function fmtAcu(acu: number): string {
  return acu < 0.01 ? "<0.01 ACU" : `${acu.toFixed(2)} ACU`;
}

/** Short uppercase source tag for the totals row, or null for bb-native. */
function sourceTag(source: ThreadStats["usageSource"]): string | null {
  if (source === "opencode-local") return "VIA OPENCODE";
  if (source === "devin-acp-tap") return "VIA DEVIN TAP";
  if (source === "muse-acp-tap") return "VIA MUSE TAP";
  return null;
}

function avgTps(turn: TurnStatResult, now: number): number | null {
  if (turn.outputTokens === null) return null;
  const secs = ((turn.endedAt ?? now) - turn.startedAt) / 1000;
  if (secs <= 0) return null;
  return turn.outputTokens / secs;
}

/** Decode throughput beats whole-turn average when the provider reports it. */
function turnTps(turn: TurnStatResult, now: number): { value: number; kind: "decode" | "avg" } | null {
  if (turn.decodeTokPerSec !== null && turn.decodeTokPerSec > 0) {
    return { value: turn.decodeTokPerSec, kind: "decode" };
  }
  const avg = avgTps(turn, now);
  return avg === null ? null : { value: avg, kind: "avg" };
}

/** Provider-reported cost when present, else the price-table estimate. */
function turnCost(turn: TurnStatResult): { usd: number; estimated: boolean } | null {
  if (turn.costUsd !== null) return { usd: turn.costUsd, estimated: false };
  if (turn.estimatedCostUsd !== null) return { usd: turn.estimatedCostUsd, estimated: true };
  return null;
}

function sessionCost(stats: ThreadStats): { usd: number; estimated: boolean } | null {
  if (stats.costUsd !== null) return { usd: stats.costUsd, estimated: false };
  if (stats.estimatedCostUsd !== null) return { usd: stats.estimatedCostUsd, estimated: true };
  return null;
}

function fmtCtx(used: number, size: number): string {
  return `context ${fmtTok(used)}/${fmtTok(size)}`;
}

/** "250000" | "250k" | "1m" → tokens; blank/invalid → null (use the window). */
function parseContextLimit(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return null;
  const v = Math.round(
    parseFloat(m[1]!) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1),
  );
  return v > 0 ? v : null;
}

/** Degradation thresholds are absolute, not a share of the provider window. */
function ctxTone(pct: number): string {
  if (pct >= 100) return "text-destructive";
  if (pct >= 75) return "text-warning-text";
  return "text-muted-foreground";
}

/** Mini meter: bar + "34k / 250k · 14%". The bar flex-grows to fill the
 *  space its container gives it; the count stays pinned to the right. */
function ContextMeter({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const fill = Math.min(Math.max(pct, 0), 100);
  return (
    <span className={`flex w-full items-center gap-2 tabular-nums ${ctxTone(pct)}`}>
      <span
        className="min-w-10 flex-1 overflow-hidden rounded-full bg-border"
        style={{ height: 5 }}
      >
        <span
          className="block h-full rounded-full bg-current transition-[width] duration-300"
          style={{ width: `${fill}%` }}
        />
      </span>
      <span className="shrink-0">
        {fmtTok(used)} / {fmtTok(limit)} · {Math.round(pct)}%
      </span>
    </span>
  );
}

function turnDurationMs(turn: TurnStatResult, now: number): number {
  return (turn.endedAt ?? now) - turn.startedAt;
}

function useThreadStats(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [stats, setStats] = useState<ThreadStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await rpc.call("getThreadStats", { threadId });
      setStats(res.stats);
      setError(res.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void rpc.call("watchThread", { threadId }).catch(() => undefined);
    void refresh();
    const keepalive = window.setInterval(() => {
      void rpc.call("watchThread", { threadId }).catch(() => undefined);
    }, 45_000);
    return () => window.clearInterval(keepalive);
  }, [rpc, threadId, refresh]);

  useRealtime(CHANNEL, (payload) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) {
      void refresh();
    }
  });

  const running = stats?.turns.some((t) => t.status === "running") ?? false;
  useEffect(() => {
    if (!running) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [running]);

  return { stats, error, now };
}

function MoneyIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="#3d8a5f"
      strokeWidth="1.1"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-1px" }}
    >
      <rect x="1.2" y="3.2" width="9.6" height="6.2" rx="1" />
      <circle cx="6" cy="6.3" r="1.4" />
    </svg>
  );
}

function SpeedIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="#c99436"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-1px" }}
    >
      <path d="M6.9 1.2 2.8 7h2.1L4.2 10.8 9.2 5H7L6.9 1.2z" />
    </svg>
  );
}

function InfoIcon({ size = 9 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-1px" }}
    >
      <circle cx="6" cy="6" r="5" />
      <line x1="6" y1="5.4" x2="6" y2="8.4" strokeLinecap="round" />
      <circle cx="6" cy="3.4" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function usePrefs() {
  const { values } = useSettings();
  const chip = values?.chip === "icon" ? "icon" : "stats";
  const placement = values?.placement;
  return {
    chip,
    showHeader: placement !== "composer",
    showComposer: placement === "composer" || placement === "header + composer",
    contextLimit: parseContextLimit(
      typeof values?.contextLimit === "string" ? values.contextLimit : undefined,
    ),
  };
}

function StatsHover({
  stats,
  error,
  now,
  side,
  children,
}: {
  stats: ThreadStats | null;
  error: string | null;
  now: number;
  side: "top" | "bottom";
  children: ReactNode;
}) {
  return (
    <HoverCard.Root openDelay={200} closeDelay={150}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 rounded-lg border border-border bg-popover p-3 text-foreground shadow-lg"
          style={{ width: 240 }}
        >
          {stats === null ? (
            <div className="font-mono text-muted-foreground" style={{ fontSize: 10 }}>
              {error !== null ? `Turn stats unavailable: ${error}` : "Loading turn stats…"}
            </div>
          ) : (
            <TurnStatsCard stats={stats} now={now} />
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function BarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path d="M3.5 13.5V9M8 13.5V3M12.5 13.5v-4.5" strokeLinecap="round" />
    </svg>
  );
}

function TokenStack({ turn, height = 6 }: { turn: TurnStatResult; height?: number }) {
  const input = turn.inputTokens ?? 0;
  const cached = turn.cachedInputTokens ?? 0;
  const reasoning = turn.reasoningOutputTokens ?? 0;
  const output = turn.outputTokens ?? 0;
  const total = input + cached + reasoning + output;
  if (total <= 0) return null;
  const pct = (n: number) => `${Math.max(n === 0 ? 0 : 1.5, (n / total) * 100)}%`;
  return (
    <div
      className="flex overflow-hidden rounded-sm"
      style={{ height }}
      role="img"
      aria-label={`input ${input}, cached ${cached}, reasoning ${reasoning}, output ${output}`}
    >
      <div style={{ width: pct(input), background: SEG.input }} />
      <div style={{ width: pct(cached), background: SEG.cached }} />
      <div style={{ width: pct(reasoning), background: SEG.reasoning }} />
      <div style={{ width: pct(output), background: SEG.output }} />
    </div>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ["input", SEG.input],
    ["cached", SEG.cached],
    ["reasoning", SEG.reasoning],
    ["output", SEG.output],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
      {items.map(([label, color]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-[2px]"
            style={{ background: color }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: TurnStatResult["status"] }) {
  const color =
    status === "running"
      ? "#7b9bff"
      : status === "completed"
        ? "#57b585"
        : "#e07575";
  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-full"
      style={{ background: color }}
      aria-label={status}
    />
  );
}

/** The hover card shown by the header icon — latest/active turn breakdown. */
function TurnStatsCard({ stats, now }: { stats: ThreadStats; now: number }) {
  const prefs = usePrefs();
  const ctxLimit = prefs.contextLimit ?? stats.contextWindowTokens;
  const running = stats.turns.find((t) => t.status === "running") ?? null;
  const latest = stats.turns[stats.turns.length - 1] ?? null;
  const turn = running ?? latest;
  if (turn === null) {
    return (
      <div className="font-mono text-muted-foreground" style={{ fontSize: 10 }}>
        No turns yet.
      </div>
    );
  }
  const tps = turnTps(turn, now);
  const cost = turnCost(turn);
  const hasUsage = turn.inputTokens !== null || turn.outputTokens !== null;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span>
          <span
            className="font-semibold text-foreground"
            style={{ fontSize: 11, lineHeight: 1.3 }}
          >
            Turn {turn.index + 1}
            {turn.status === "running" ? " · running" : ""}
          </span>
          <span
            className="block font-mono text-muted-foreground"
            style={{ fontSize: 10, marginTop: 1 }}
          >
            {turn.model ?? stats.providerId}
          </span>
        </span>
        <span className="font-mono text-foreground" style={{ fontSize: 13, fontWeight: 600 }}>
          {fmtDuration(turnDurationMs(turn, now))}
        </span>
      </div>
      <div
        className="flex items-baseline justify-between font-mono text-muted-foreground"
        style={{ fontSize: 10, marginTop: 3 }}
      >
        <span className="inline-flex items-center gap-1">
          {cost !== null ? (
            <>
              <MoneyIcon /> {fmtCost(cost.usd)}
              {cost.estimated ? " est." : ""}
            </>
          ) : turn.acuCost !== null ? (
            <>
              <MoneyIcon /> {fmtAcu(turn.acuCost)}
            </>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1">
          {tps !== null ? (
            <>
              <SpeedIcon /> {tps.value.toFixed(1)} tok/s {tps.kind}
            </>
          ) : null}
        </span>
      </div>
      {hasUsage ? (
        <>
          <div className="mt-2">
            <TokenStack turn={turn} height={6} />
          </div>
          <div className="mt-2 space-y-0.5 font-mono" style={{ fontSize: 10 }}>
            {(
              [
                ["Input", SEG.input, turn.inputTokens],
                ["Cached input", SEG.cached, turn.cachedInputTokens],
                ["Reasoning", SEG.reasoning, turn.reasoningOutputTokens],
                ["Output", SEG.output, turn.outputTokens],
              ] as const
            ).map(([label, color, value]) => (
              <div key={label} className="flex justify-between text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block rounded-[2px]"
                    style={{ background: color, width: 8, height: 8 }}
                  />
                  {label}
                </span>
                <span className="text-foreground">{countFmt.format(value ?? 0)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div
          className="mt-2 font-mono text-muted-foreground"
          style={{ fontSize: 10 }}
        >
          {stats.providerId} did not report token usage for this turn.
          {turn.contextUsedTokens !== null && turn.contextWindowTokens !== null
            ? ` ${fmtCtx(turn.contextUsedTokens, prefs.contextLimit ?? turn.contextWindowTokens)}.`
            : ""}
        </div>
      )}
      {hasUsage && turn.contextUsedTokens !== null && turn.contextWindowTokens !== null ? (
        <div
          className="mt-1 font-mono text-muted-foreground"
          style={{ fontSize: 10 }}
        >
          {fmtCtx(turn.contextUsedTokens, prefs.contextLimit ?? turn.contextWindowTokens)}
        </div>
      ) : null}
      {turn.ttftMs !== null || turn.streamMs !== null || turn.tailMs !== null ? (
        <div
          className="mt-1 font-mono text-muted-foreground"
          style={{ fontSize: 10 }}
        >
          {[
            turn.ttftMs !== null ? `ttft ${(turn.ttftMs / 1000).toFixed(1)}s` : null,
            turn.streamMs !== null ? `gen ${(turn.streamMs / 1000).toFixed(1)}s` : null,
            turn.tailMs !== null ? `settle tail ${(turn.tailMs / 1000).toFixed(1)}s` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          {" · "}
          {turn.usageSource === "devin-acp-tap"
            ? "reported by provider"
            : "measured on wire"}
        </div>
      ) : null}
      <div
        className="mt-2 border-t border-border pt-1.5 font-mono text-muted-foreground"
        style={{ fontSize: 9.5, lineHeight: 1.5 }}
      >
        {stats.totals !== null ? (
          <>
            <div className="flex items-baseline justify-between">
              <span style={{ fontSize: 8.5, letterSpacing: "0.06em", opacity: 0.6 }}>
                TOTAL{sourceTag(stats.usageSource) !== null ? ` · ${sourceTag(stats.usageSource)}` : ""}
              </span>
              {sessionCost(stats)?.estimated === true ? (
                <Tooltip.Provider delayDuration={150}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <span
                        className="inline-flex items-center"
                        style={{ opacity: 0.55, cursor: "help" }}
                        aria-label="Cost estimated from a bundled price table, not provider-billed"
                      >
                        <InfoIcon />
                      </span>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="top"
                        sideOffset={4}
                        className="rounded-md border border-border bg-popover px-2 py-1 font-mono text-muted-foreground shadow-md"
                        style={{ fontSize: 10, maxWidth: 220, zIndex: 70 }}
                      >
                        Cost estimated from a bundled model price table — not provider-billed.
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              ) : null}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="inline-flex items-center gap-1">
                {sessionCost(stats) !== null ? (
                  <>
                    <MoneyIcon /> {fmtCost(sessionCost(stats)!.usd)}
                  </>
                ) : null}
              </span>
              <span>
                {fmtTok(stats.totals.inputTokens)} in · {fmtTok(stats.totals.outputTokens)} out
              </span>
            </div>
          </>
        ) : (
          "session usage unavailable"
        )}
        {stats.contextUsedTokens !== null && ctxLimit !== null ? (
          <div className="mt-1 flex items-baseline justify-end gap-1.5">
            <ContextMeter used={stats.contextUsedTokens} limit={ctxLimit} />
            <span className="opacity-60" style={{ fontSize: 8.5 }}>
              {prefs.contextLimit !== null ? "soft limit" : "window"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChipText({ stats, now }: { stats: ThreadStats; now: number }) {
  const running = stats.turns.find((t) => t.status === "running") ?? null;
  const turn = running ?? stats.turns[stats.turns.length - 1];
  if (turn === undefined) return null;
  const tps = turnTps(turn, now);
  const cost = turnCost(turn);
  return (
    <span
      className="overflow-hidden whitespace-nowrap font-mono tabular-nums"
      style={{ fontSize: 11, maxWidth: 228, textOverflow: "ellipsis" }}
    >
      {fmtDuration(turnDurationMs(turn, now))}
      {turn.usageCalls > 0 ? (
        <>
          {tps !== null
            ? ` · ${tps.value.toFixed(1)} tok/s`
            : ""}
          {cost !== null
            ? ` · ${fmtCost(cost.usd)}`
            : ""}
        </>
      ) : (
        " · no usage"
      )}
    </span>
  );
}

function TurnStatsHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { stats, error, now } = useThreadStats(threadId);
  const { openThreadPanel } = useBbNavigate();
  const prefs = usePrefs();
  const running = stats?.turns.some((t) => t.status === "running") ?? false;

  if (!prefs.showHeader) return null;
  const iconOnly = prefs.chip === "icon" || isCompactViewport;

  return (
    <StatsHover stats={stats} error={error} now={now} side="bottom">
      <button
        type="button"
        aria-label={PANEL_TITLE}
        title={PANEL_TITLE}
        onClick={() =>
          openThreadPanel({ actionId: PANEL_ACTION_ID, title: PANEL_TITLE })
        }
        className={
          iconOnly
            ? "relative inline-flex size-7 items-center justify-center whitespace-nowrap rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            : "relative inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-muted/40 px-2 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        }
      >
        <BarIcon className="size-4 shrink-0" />
        {running ? (
          <span
            className="shrink-0 animate-pulse rounded-full"
            style={{ background: SEG.output, width: 6, height: 6 }}
            aria-hidden="true"
          />
        ) : null}
        {!iconOnly && stats !== null ? (
          <ChipText stats={stats} now={now} />
        ) : null}
      </button>
    </StatsHover>
  );
}

/** Which turn a message's sourceSeqEnd belongs to. */
function turnForSeq(turns: TurnStatResult[], seq: number): TurnStatResult | null {
  const containing = turns.find(
    (t) => t.startSeq <= seq && (t.endSeq === null || seq <= t.endSeq),
  );
  if (containing !== undefined) return containing;
  const triggered = turns.find((t) => t.startSeq > seq);
  if (triggered !== undefined) return triggered;
  return turns[turns.length - 1] ?? null;
}

function TurnStatsPanel({ threadId, params }: PluginThreadPanelProps) {
  const { stats, error, now } = useThreadStats(threadId);
  const prefs = usePrefs();
  const ctxLimit =
    stats !== null ? (prefs.contextLimit ?? stats.contextWindowTokens) : null;
  const focusSeq =
    typeof params === "object" && params !== null && "focusSeq" in params
      ? (params as { focusSeq?: unknown }).focusSeq
      : undefined;
  const focusTurn =
    stats !== null && typeof focusSeq === "number"
      ? turnForSeq(stats.turns, focusSeq)
      : null;
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "nearest" });
  }, [stats, focusSeq]);

  if (error !== null && stats === null) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Turn stats unavailable: {error}
      </div>
    );
  }
  if (stats === null) {
    return <div className="p-3 text-xs text-muted-foreground">Loading turn stats…</div>;
  }

  const ordered = [...stats.turns].reverse();
  return (
    <div className="space-y-3">
      <div className="border-b border-border pb-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
        session started <b className="font-semibold text-foreground">{stats.createdAt !== 0 ? fmtAgo(stats.createdAt, now) : "—"}</b>
        {stats.lastActivityAt !== null ? (
          <>
            {" "}· last activity{" "}
            <b className="font-semibold text-foreground">{fmtAgo(stats.lastActivityAt, now)}</b>
          </>
        ) : null}
        {" "}· <b className="font-semibold text-foreground">{stats.model ?? stats.providerId}</b>
      </div>
      <Legend />
      {stats.usageSource === "opencode-local" ? (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          Tokens and cost read from OpenCode's local session store — provider-reported, not estimated.
        </div>
      ) : stats.usageSource === "devin-acp-tap" ? (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          Tokens and speed tapped from devin acp's wire — provider-reported, not estimated.
        </div>
      ) : stats.usageSource === "muse-acp-tap" ? (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          Per-turn tokens diffed from muse-acp's cumulative usage — cost is the adapter's catalog list-price estimate.
        </div>
      ) : stats.turns.length > 0 &&
        stats.turns.every((t) => t.usageCalls === 0) ? (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          {stats.providerId} did not report token usage for this thread — timing only.
        </div>
      ) : null}
      <div className="space-y-1">
        {ordered.map((turn) => {
          const tps = turnTps(turn, now);
          const cost = turnCost(turn);
          const focused = focusTurn !== null && focusTurn.turnId === turn.turnId;
          return (
            <div
              key={turn.turnId}
              ref={focused ? focusRef : undefined}
              className={
                "rounded-md px-2 py-2" +
                (focused ? " border border-border bg-muted/50" : " border border-transparent")
              }
            >
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <StatusDot status={turn.status} />
                <span className="text-foreground">turn {turn.index + 1}</span>
                <span className="text-muted-foreground">{fmtDuration(turnDurationMs(turn, now))}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                  {turn.status === "failed" || turn.status === "interrupted" ? (
                    `${turn.status}${turn.usageCalls === 0 ? " · no usage" : ""}`
                  ) : turn.usageCalls === 0 ? (
                    "no usage reported"
                  ) : (
                    <>
                      {tps !== null ? (
                        <>
                          <SpeedIcon size={9} /> {tps.value.toFixed(1)} t/s {tps.kind}
                        </>
                      ) : (
                        "—"
                      )}
                      {cost !== null ? (
                        <>
                          {" · "}
                          <MoneyIcon size={9} /> {fmtCost(cost.usd)}
                          {cost.estimated ? "" : ""}
                        </>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
              {turn.inputTokens !== null || turn.outputTokens !== null ? (
                <div className="mt-1.5">
                  <TokenStack turn={turn} height={8} />
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {fmtTok(turn.inputTokens)} in · {fmtTok(turn.cachedInputTokens)} cached
                    {(turn.cacheWriteTokens ?? 0) > 0
                      ? ` · w ${fmtTok(turn.cacheWriteTokens)}`
                      : ""}
                    {" "}· {fmtTok(turn.reasoningOutputTokens)} think · {fmtTok(turn.outputTokens)} out
                    {turn.contextUsedTokens !== null && turn.contextWindowTokens !== null
                      ? ` · ${fmtCtx(turn.contextUsedTokens, prefs.contextLimit ?? turn.contextWindowTokens)}`
                      : ""}
                  </div>
                </div>
              ) : turn.contextUsedTokens !== null && turn.contextWindowTokens !== null ? (
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {fmtCtx(turn.contextUsedTokens, prefs.contextLimit ?? turn.contextWindowTokens)}
                </div>
              ) : null}
            </div>
          );
        })}
        {ordered.length === 0 ? (
          <div className="text-xs text-muted-foreground">No turns recorded yet.</div>
        ) : null}
      </div>
      {stats.totals !== null ? (
        <div className="border-t border-border pt-2 font-mono text-[10.5px] text-muted-foreground">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-wide opacity-60">Session total</span>
            {sessionCost(stats)?.estimated === true ? (
              <Tooltip.Provider delayDuration={150}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <span
                      className="inline-flex items-center opacity-55"
                      style={{ cursor: "help" }}
                      aria-label="Cost estimated from a bundled price table, not provider-billed"
                    >
                      <InfoIcon />
                    </span>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="top"
                      sideOffset={4}
                      className="rounded-md border border-border bg-popover px-2 py-1 font-mono text-muted-foreground shadow-md"
                      style={{ fontSize: 10, maxWidth: 220, zIndex: 70 }}
                    >
                      Cost estimated from a bundled model price table — not provider-billed.
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            ) : null}
          </div>
          <span className="inline-flex items-baseline gap-1">
            <b className="font-medium text-foreground">
              {fmtTok(stats.totals.inputTokens)} in · {fmtTok(stats.totals.outputTokens)} out
            </b>
            {sessionCost(stats) !== null ? (
              <>
                {" · "}
                <MoneyIcon size={9} />{" "}
                <b className="font-medium text-foreground">{fmtCost(sessionCost(stats)!.usd)}</b>
                {sessionCost(stats)!.estimated ? " est." : ""}
              </>
            ) : null}
          </span>
          {stats.contextUsedTokens !== null && ctxLimit !== null ? (
            <div className="mt-1 flex items-baseline justify-end gap-1.5">
              <ContextMeter used={stats.contextUsedTokens} limit={ctxLimit} />
              <span className="opacity-60" style={{ fontSize: 8.5 }}>
                {prefs.contextLimit !== null ? "soft limit" : "window"}
              </span>
            </div>
          ) : null}
        </div>
      ) : stats.contextUsedTokens !== null && ctxLimit !== null ? (
        <div className="border-t border-border pt-2 font-mono text-[10.5px] text-muted-foreground">
          <div className="flex items-baseline justify-end gap-1.5">
            <ContextMeter used={stats.contextUsedTokens} limit={ctxLimit} />
            <span className="opacity-60" style={{ fontSize: 8.5 }}>
              {prefs.contextLimit !== null ? "soft limit" : "window"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TurnStatsComposerBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const { stats, error, now } = useThreadStats(threadId ?? "");
  const { openThreadPanel } = useBbNavigate();
  const prefs = usePrefs();

  if (!prefs.showComposer || threadId === null) return null;
  const running = stats?.turns.some((t) => t.status === "running") ?? false;

  return (
    <StatsHover stats={stats} error={error} now={now} side="top">
      <button
        type="button"
        onClick={() =>
          openThreadPanel({ actionId: PANEL_ACTION_ID, title: PANEL_TITLE })
        }
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
      >
      <BarIcon className="size-3.5 shrink-0" />
      {running ? (
        <span
          className="shrink-0 animate-pulse rounded-full"
          style={{ background: SEG.output, width: 6, height: 6 }}
          aria-hidden="true"
        />
      ) : null}
      {stats !== null ? (
        <ChipText stats={stats} now={now} />
      ) : (
        <span className="font-mono" style={{ fontSize: 11 }}>
          Turn stats
        </span>
      )}
      {stats !== null &&
      stats.contextUsedTokens !== null &&
      (prefs.contextLimit ?? stats.contextWindowTokens) !== null ? (
        <span className="ml-auto min-w-0 flex-1 font-mono" style={{ fontSize: 10 }}>
          <ContextMeter
            used={stats.contextUsedTokens}
            limit={(prefs.contextLimit ?? stats.contextWindowTokens)!}
          />
        </span>
      ) : (
        <span className="ml-auto font-mono text-muted-foreground" style={{ fontSize: 10 }}>
          details →
        </span>
      )}
      </button>
    </StatsHover>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "turn-stats-header",
    title: PANEL_TITLE,
    component: TurnStatsHeaderAction,
  });
  app.composer.customize({
    id: "turn-stats-banner",
    scopes: ["thread"],
    banners: [{ id: "turn-stats", chrome: "bare", component: TurnStatsComposerBanner }],
  });
  app.slots.messageAction({
    id: "turn-stats",
    title: PANEL_TITLE,
    icon: "ChartColumn",
    async run(context) {
      let focusSeq: number = context.message.sourceSeqEnd;
      try {
        const res = await fetch(
          `/api/v1/plugins/${encodeURIComponent("turn-stats")}/rpc/getThreadStats`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: context.threadId }),
          },
        );
        const json = (await res.json()) as {
          result?: { stats?: { turns?: TurnStatResult[] } | null };
        };
        const turns = json.result?.stats?.turns;
        if (turns !== undefined) {
          const turn = turnForSeq(turns, focusSeq);
          if (turn !== null) focusSeq = turn.startSeq;
        }
      } catch {
        // Fall back to the message's seq — still lands on the right turn.
      }
      context.openPanel({
        actionId: PANEL_ACTION_ID,
        title: PANEL_TITLE,
        params: { focusSeq },
      });
    },
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: PANEL_TITLE,
    icon: "ChartColumn",
    component: TurnStatsPanel,
    layout: "padded",
  });
});
