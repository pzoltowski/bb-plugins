// bb-plugin-turn-stats — per-turn timing, token usage, and estimated cost.
//
// The server side tails the normalized thread-event log for threads a client
// is watching (header action or stats panel open). Every poll reduces the
// thread's events into per-turn stats in src/stats.ts; when the reduction
// changes, a realtime publish on channel "turn-stats" nudges open clients to
// refetch. Nothing is persisted — BB already stores the events.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  applyDevinUsage,
  applyOpenCodeUsage,
  computeSessionStats,
  extractProviderThreadId,
  type EventRow,
  type SessionStats,
} from "./src/stats.ts";
import {
  attributeToTurns,
  detectOpenCode,
  fetchSessionMessages,
  type OpenCodeInstall,
} from "./src/opencode.ts";
import {
  attributeDevinTap,
  DEVIN_TAP_PROVIDER_ID,
  devinTapDir,
  devinTapPath,
  readDevinTap,
} from "./src/devin.ts";
import { ACP_TAP_FILENAME, ACP_TAP_SOURCE } from "./src/acp-tap-source.ts";

export const REALTIME_CHANNEL = "turn-stats";
export const PANEL_ACTION_ID = "turn-stats";

const WATCHED_EVENT_TYPES = [
  "thread/started",
  "turn/started",
  "turn/completed",
  "client/turn/requested",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "system/thread/interrupted",
] as const;

const POLL_MS = 2_500;
const WATCH_TTL_MS = 120_000;
const PAGE_SIZE = "100";
const MAX_PAGES = 10;

const tokenTotalsSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
});

const turnStatSchema = z.object({
  turnId: z.string(),
  index: z.number(),
  startSeq: z.number(),
  endSeq: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  model: z.string().nullable(),
  permissionMode: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  inputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningOutputTokens: z.number().nullable(),
  usageCalls: z.number(),
  estimatedCostUsd: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  decodeTokPerSec: z.number().nullable(),
  ttftMs: z.number().nullable(),
  acuCost: z.number().nullable(),
  usageSource: z.enum(["bb-events", "opencode-local", "devin-acp-tap"]).nullable(),
  contextUsedTokens: z.number().nullable(),
  contextWindowTokens: z.number().nullable(),
});

const threadStatsSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  providerId: z.string(),
  status: z.string(),
  createdAt: z.number(),
  lastActivityAt: z.number().nullable(),
  model: z.string().nullable(),
  totals: tokenTotalsSchema.nullable(),
  estimatedCostUsd: z.number().nullable(),
  costUsd: z.number().nullable(),
  usageSource: z.enum(["bb-events", "opencode-local", "devin-acp-tap", "none"]),
  contextUsedTokens: z.number().nullable(),
  contextWindowTokens: z.number().nullable(),
  turns: z.array(turnStatSchema),
});

export const rpcContract = defineRpcContract({
  getThreadStats: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      stats: threadStatsSchema.nullable(),
      error: z.string().nullable(),
    }),
  },
  watchThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

export type ThreadStats = z.infer<typeof threadStatsSchema>;
export type TurnStatResult = z.infer<typeof turnStatSchema>;
export type GetThreadStatsResult = z.infer<
  (typeof rpcContract)["getThreadStats"]["output"]
>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chip: {
      type: "select",
      label: "Header chip",
      description:
        "What the turn-stats chip shows. Stats = duration, tok/s and cost inline; Icon = chart glyph only (hover still shows the card, click opens the panel).",
      options: ["stats", "icon"],
      default: "stats",
    },
    placement: {
      type: "select",
      label: "Chip placement",
      description:
        "Where the chip appears: the thread header, a slim banner above the composer, or both.",
      options: ["header", "composer", "header + composer"],
      default: "header",
    },
    opencodeFallback: {
      type: "select",
      label: "OpenCode local data",
      description:
        "For OpenCode ACP threads, read real per-turn tokens, cost, and decode speed from OpenCode's local session store (~/.local/share/opencode). Off = timing only.",
      options: ["auto", "off"],
      default: "auto",
    },
    devinTap: {
      type: "select",
      label: "Devin stats tap",
      description:
        "Registers a 'Devin (stats tap)' provider that proxies devin acp and records the per-turn usage it already emits (tokens, tok/s, TTFT). Threads must be started on that provider; builtin acp-devin stays timing + context only.",
      options: ["on", "off"],
      default: "on",
    },
  });

  // The tap is a plain Node script the ACP bridge spawns in place of
  // `devin acp`. Rewritten on every plugin start so upgrades self-heal;
  // it lives next to its JSONL output under the plugin's bb dir.
  const tapDir = devinTapDir();
  const shimPath = join(homedir(), ".bb", "plugins", "turn-stats", ACP_TAP_FILENAME);
  function writeTapShim(): void {
    try {
      mkdirSync(tapDir, { recursive: true });
      writeFileSync(shimPath, ACP_TAP_SOURCE, { mode: 0o755 });
    } catch (error) {
      bb.log.warn(`turn-stats: could not write acp tap shim: ${errorText(error)}`);
    }
  }

  function resolveDevinCommand(): string {
    const candidates = [
      join(homedir(), ".local", "bin", "devin"),
      "/usr/local/bin/devin",
      "/opt/homebrew/bin/devin",
    ];
    for (const c of candidates) if (existsSync(c)) return `${c} acp`;
    try {
      const found = execFileSync("which", ["devin"], { encoding: "utf8" }).trim();
      if (found) return `${found} acp`;
    } catch {}
    return "devin acp";
  }

  const prefsNow = await settings.get().catch(() => null);
  if (prefsNow?.devinTap !== "off") {
    writeTapShim();
    bb.providers.register({
      id: DEVIN_TAP_PROVIDER_ID,
      displayName: "Devin (stats tap)",
      family: "acp",
      strings: {
        signInHint: "Sign in to Devin on the machine, then reload.",
        expiredHint: "Your Devin session expired. Sign in on the machine, then reload.",
        installUrl: "https://devin.ai",
      },
      experimental_visibility: "always",
      models: { scope: "host" },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: true,
        supportsNativeUserQuestion: false,
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        fork: "none",
        permissionModes: ["accept-edits", "full"],
        reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      composerActions: [],
      experimental_bridgeOptions: {
        acpLaunchSpec: {
          displayName: "Devin",
          // ELECTRON_RUN_AS_NODE makes the bb binary (process.execPath in
          // this runtime) execute the shim as plain Node — no PATH lookup.
          command: process.execPath,
          args: [shimPath],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            TAP_SPAWN: resolveDevinCommand(),
            TAP_DIR: tapDir,
          } as Record<string, string>,
        },
      },
    });
  }

  // threadId → watch expiry. Any getThreadStats/watchThread call refreshes it;
  // the tailer only polls threads with a live watcher.
  const watchUntil = new Map<string, number>();
  const signatures = new Map<string, string>();

  async function loadRows(threadId: string, signal?: AbortSignal): Promise<EventRow[]> {
    const rows: EventRow[] = [];
    let afterSeq: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await bb.sdk.threads.events.list({
        threadId,
        types: WATCHED_EVENT_TYPES,
        order: "asc",
        limit: PAGE_SIZE,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        ...(signal === undefined ? {} : { signal }),
      });
      for (const row of batch) {
        rows.push({
          id: row.id,
          seq: row.seq,
          createdAt: row.createdAt,
          type: row.type,
          scope: row.scope,
          data: row.data as Record<string, unknown>,
        });
      }
      const last = batch[batch.length - 1];
      if (batch.length < Number(PAGE_SIZE) || last === undefined) break;
      afterSeq = String(last.seq);
    }
    return rows;
  }

  function toResult(thread: {
    id: string;
    title: string | null;
    providerId: string;
    status: string;
    createdAt: number;
  }, session: SessionStats): ThreadStats {
    return {
      threadId: thread.id,
      title: thread.title,
      providerId: thread.providerId,
      status: thread.status,
      createdAt: thread.createdAt,
      lastActivityAt: session.lastActivityAt,
      model: session.model,
      totals: session.totals,
      estimatedCostUsd: session.estimatedCostUsd,
      costUsd: session.costUsd,
      usageSource: session.usageSource,
      contextUsedTokens: session.contextUsedTokens,
      contextWindowTokens: session.contextWindowTokens,
      turns: session.turns,
    };
  }

  let openCodeInstall: OpenCodeInstall | null | undefined;

  async function mergeOpenCode(session: SessionStats, rows: EventRow[]): Promise<string> {
    const prefs = await settings.get().catch(() => null);
    if (prefs?.opencodeFallback === "off") return "";
    if (session.usageSource !== "none") return "";
    if (openCodeInstall === undefined) {
      openCodeInstall = await detectOpenCode().catch(() => null);
      if (openCodeInstall !== null) {
        bb.log.info(`turn-stats: OpenCode local fallback active (${openCodeInstall.dbPath})`);
      }
    }
    if (openCodeInstall === null) return "";
    const providerThreadId = extractProviderThreadId(rows);
    if (providerThreadId === null) return "";
    const data = await fetchSessionMessages(openCodeInstall, providerThreadId,
      (m) => bb.log.warn(`turn-stats: opencode ${m}`)).catch(
      (e) => { bb.log.warn(`turn-stats: opencode fetch threw: ${e}`); return null; },
    );
    if (data === null || data.messages.length === 0) return "";
    const perTurn = attributeToTurns(data.messages, session.turns);
    if (!applyOpenCodeUsage(session, perTurn, data.totals)) return "";
    const last = data.messages[data.messages.length - 1];
    return `oc:${data.messages.length}:${last?.createdAt ?? 0}`;
  }

  function mergeDevin(session: SessionStats, rows: EventRow[]): string {
    if (session.usageSource !== "none") return "";
    const providerThreadId = extractProviderThreadId(rows);
    if (providerThreadId === null) return "";
    if (!existsSync(devinTapPath(providerThreadId))) return "";
    const records = readDevinTap(providerThreadId);
    if (records === null || records.length === 0) return "";
    const perTurn = attributeDevinTap(records, session.turns);
    if (!applyDevinUsage(session, perTurn)) return "";
    const last = records[records.length - 1];
    return `dv:${records.length}:${last?.at ?? 0}`;
  }

  async function compute(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<{ stats: ThreadStats; signature: string }> {
    const [thread, rows] = await Promise.all([
      bb.sdk.threads.get({ threadId, ...(signal === undefined ? {} : { signal }) }),
      loadRows(threadId, signal),
    ]);
    const session = computeSessionStats(rows);
    if (session.startedAt === null) session.startedAt = thread.createdAt;
    const ocTag = await mergeOpenCode(session, rows);
    const dvTag = mergeDevin(session, rows);
    const signature = `${rows.length}:${rows[rows.length - 1]?.seq ?? 0}:${ocTag}:${dvTag}`;
    return { stats: toResult(thread, session), signature };
  }

  async function refresh(threadId: string, publish: boolean, signal?: AbortSignal): Promise<ThreadStats> {
    const { stats, signature } = await compute(threadId, signal);
    if (publish && signatures.get(threadId) !== signature) {
      signatures.set(threadId, signature);
      try {
        bb.realtime.publish(REALTIME_CHANNEL, { threadId });
      } catch {
        // Realtime is best-effort; clients can always refetch.
      }
    }
    return stats;
  }

  bb.rpc.register(rpcContract, {
    async getThreadStats({ threadId }) {
      watchUntil.set(threadId, Date.now() + WATCH_TTL_MS);
      try {
        return { stats: await refresh(threadId, false), error: null };
      } catch (error) {
        return { stats: null, error: errorText(error) };
      }
    },
    async watchThread({ threadId }) {
      watchUntil.set(threadId, Date.now() + WATCH_TTL_MS);
      try {
        await refresh(threadId, true);
      } catch {
        // A deleted or unreachable thread still counts as watched; the next
        // poll or read reports the error.
      }
      return { ok: true };
    },
  });

  bb.background.service("turn-stats-tailer", {
    // Must stay pending until abort — returning early marks the service stopped.
    start(signal) {
      return new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const now = Date.now();
          for (const [threadId, until] of watchUntil) {
            if (until < now) {
              watchUntil.delete(threadId);
              signatures.delete(threadId);
              continue;
            }
            void refresh(threadId, true).catch((error) => {
              bb.log.warn(`turn-stats poll failed for ${threadId}: ${errorText(error)}`);
            });
          }
        }, POLL_MS);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          resolve();
        });
      });
    },
  });
}
