// turn-stats — DeepSeek Harness (dsh) local-session fallback.
//
// BB's ACP bridge does not forward per-turn token usage, but `dsh` journals
// every model call — fresh input, cache-read/-write, output tokens — into its
// own session log at ~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd.
// The ACP bridge's contextWindowUsage events carry providerThreadId = that
// session id (a UUID), so BB turns join onto dsh calls by timestamp exactly
// like the OpenCode fallback in ./opencode.ts.
//
// dsh logs tokens, not dollars, so cost is an estimate from DeepSeek's public
// per-token rates, including the weekday peak / off-peak doubling.
//
// All IO is read-only and best-effort: a missing zstd, a log still being
// written, or schema drift degrades to "no usage".

import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { OpenCodeMessage, OpenCodeSessionTotals } from "./opencode.ts";

const run = promisify(execFile);

export interface DshInstall {
  /** Absolute path to <dshHome>/sessions. */
  sessionsDir: string;
  /** zstd CLI used to read the log ("" → node:zlib zstd). */
  zstdPath: string;
}

const ZSTD_CANDIDATES = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd"];
const LOG_NAME = "session.v4.jsonl.zstd";

const hasNodeZstd = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Detect a usable dsh install. Null → the fallback stays disabled. */
export async function detectDsh(): Promise<DshInstall | null> {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const sessionsDir = join(home, "sessions");
  if (!(await exists(sessionsDir))) return null;
  let zstdPath = "";
  for (const candidate of ZSTD_CANDIDATES) {
    if (await exists(candidate)) {
      zstdPath = candidate;
      break;
    }
  }
  if (zstdPath === "" && !hasNodeZstd) return null;
  return { sessionsDir, zstdPath };
}

/** Strict validation before the id is used in a path. */
export function isDshSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const fileCache = new Map<string, string>();

async function findLogFile(install: DshInstall, sessionId: string): Promise<string | null> {
  const cached = fileCache.get(sessionId);
  if (cached !== undefined && (await exists(cached))) return cached;
  let slugs: string[];
  try {
    slugs = await readdir(install.sessionsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const candidate = join(install.sessionsDir, slug, sessionId, LOG_NAME);
    if (await exists(candidate)) {
      fileCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

async function readLog(install: DshInstall, file: string): Promise<string> {
  if (install.zstdPath !== "") {
    const { stdout } = await run(install.zstdPath, ["-dc", file], {
      timeout: 10_000,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  }
  const zstd = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync;
  return zstd(await readFile(file)).toString("utf8");
}

// ── Pricing ────────────────────────────────────────────────────────────────

interface DshRates {
  /** USD per 1M tokens, off-peak. Peak is exactly double. */
  miss: number;
  hit: number;
  out: number;
}

// https://api-docs.deepseek.com/quick_start/pricing — checked 2026-10-18.
const DSH_RATES: ReadonlyArray<{ match: string; rates: DshRates }> = [
  { match: "pro", rates: { miss: 0.66, hit: 0.022, out: 1.98 } },
  { match: "flash", rates: { miss: 0.15, hit: 0.003, out: 0.6 } },
];

/**
 * DeepSeek peak hours: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. Chinese public
 * holidays are off-peak too, but are not modelled — such days read slightly
 * high, which is why the figure stays labelled "est.".
 */
export function isDeepSeekPeak(atMs: number): boolean {
  const d = new Date(atMs);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function estimateDshCostUsd(
  model: string | null,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  atMs: number,
): number | null {
  if (model === null) return null;
  const lower = model.toLowerCase();
  if (!lower.includes("deepseek")) return null;
  const entry = DSH_RATES.find((e) => lower.includes(e.match));
  if (entry === undefined) return null;
  const k = isDeepSeekPeak(atMs) ? 2 : 1;
  // DeepSeek has no cache-write surcharge: written tokens are plain misses.
  const usd =
    (((usage.input + usage.cacheWrite) * entry.rates.miss +
      usage.cacheRead * entry.rates.hit +
      usage.output * entry.rates.out) *
      k) /
    1_000_000;
  return usd;
}

// ── Log parsing ────────────────────────────────────────────────────────────

interface LogRecord {
  type?: unknown;
  time?: unknown;
  data?: Record<string, unknown>;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Turn a decompressed dsh session log into one message per model call.
 * `createdAt` is the step start and `completedAt` the committed assistant
 * message, so attribution and decode speed work as for OpenCode. A trailing
 * partial line (log still being appended) is skipped.
 */
export function parseDshLog(text: string): OpenCodeMessage[] {
  const stepStart = new Map<string, number>();
  const out: OpenCodeMessage[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    const time = typeof rec.time === "number" ? rec.time : null;
    const data = rec.data;
    if (time === null || data === undefined) continue;
    const key = `${String(data.turn)}:${String(data.step)}`;
    if (rec.type === "step/start") {
      stepStart.set(key, time);
      continue;
    }
    if (rec.type !== "assistant/message") continue;
    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage === undefined || typeof usage !== "object") continue;
    const message = data.message as { source?: { model?: unknown } } | undefined;
    const model = typeof message?.source?.model === "string" ? message.source.model : null;
    const tokens = {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      reasoning: 0,
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
    };
    out.push({
      role: "assistant",
      createdAt: stepStart.get(key) ?? time,
      completedAt: time,
      tokens,
      cost: estimateDshCostUsd(model, tokens, time),
      model,
    });
  }
  return out;
}

export function totalsOf(messages: readonly OpenCodeMessage[]): OpenCodeSessionTotals | null {
  let any = false;
  const totals: OpenCodeSessionTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    model: null,
  };
  for (const m of messages) {
    if (m.tokens === null) continue;
    any = true;
    totals.input += m.tokens.input;
    totals.output += m.tokens.output;
    totals.cacheRead += m.tokens.cacheRead;
    totals.cacheWrite += m.tokens.cacheWrite;
    totals.cost += m.cost ?? 0;
    if (m.model !== null) totals.model = m.model;
  }
  return any ? totals : null;
}

/**
 * Read a dsh session by its id. Null when the log is absent or unreadable —
 * callers keep the plugin's no-usage state.
 */
export async function fetchDshSession(
  install: DshInstall,
  sessionId: string,
  onError?: (msg: string) => void,
): Promise<{ messages: OpenCodeMessage[]; totals: OpenCodeSessionTotals | null } | null> {
  if (!isDshSessionId(sessionId)) return null;
  try {
    const file = await findLogFile(install, sessionId);
    if (file === null) return null;
    const messages = parseDshLog(await readLog(install, file));
    if (messages.length === 0) return null;
    return { messages, totals: totalsOf(messages) };
  } catch (e) {
    onError?.(String(e).slice(0, 300));
    return null;
  }
}
