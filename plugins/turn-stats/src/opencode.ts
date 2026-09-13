// turn-stats — OpenCode local-session fallback.
//
// BB's ACP bridge does not forward per-turn token usage (ACP has no stable
// field for it yet — see get-bb/bb#2397). OpenCode, however, persists every
// model call — input/output/reasoning/cache tokens, real cost, and call
// timing — in its own SQLite store at ~/.local/share/opencode/opencode.db.
// When a BB thread runs through an OpenCode ACP agent, the bridge's
// contextWindowUsage events carry providerThreadId = the OpenCode session id
// ("ses_…"), so we can join BB turns onto OpenCode calls by timestamp.
//
// All IO is read-only and best-effort: any failure (OpenCode missing, DB
// gone, schema drift, session not flushed yet) degrades to "no usage", the
// same state the plugin already shows for usage-less providers.

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface OpenCodeInstall {
  /** Absolute path to opencode.db. */
  dbPath: string;
  /** Path to the sqlite3 CLI used for reads ("" when absent → export fallback). */
  sqlite3Path: string;
  /** Path to the opencode binary, when found (export fallback). */
  opencodePath: string | null;
}

export interface OpenCodeMessage {
  role: "user" | "assistant" | string;
  createdAt: number;
  completedAt: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  /** Provider-reported cost in USD (OpenCode prices calls itself). */
  cost: number | null;
  model: string | null;
}

export interface OpenCodeSessionTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
}

export interface OpenCodeTurnUsage {
  calls: number;
  /** Last call's fresh input tokens (context at the turn's final call). */
  inputTokens: number;
  /** Last call's cache-read tokens. */
  cachedInputTokens: number;
  /** Summed cache-write tokens across the turn's calls. */
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** Provider-reported USD cost summed across the turn's calls. */
  costUsd: number | null;
  /**
   * True decode throughput: summed output tokens / summed per-call
   * (completed - created) seconds. Excludes tool execution and queueing.
   */
  decodeTokPerSec: number | null;
}

const SQLITE3_CANDIDATES = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3"];
const OPENCODE_BIN_CANDIDATES = [
  join(homedir(), ".opencode/bin/opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
];

function opencodeDbCandidates(): string[] {
  const home = homedir();
  if (platform() === "win32") return [];
  if (platform() === "darwin") {
    return [join(home, ".local/share/opencode/opencode.db")];
  }
  const xdg = process.env.XDG_DATA_HOME;
  return [
    ...(xdg ? [join(xdg, "opencode/opencode.db")] : []),
    join(home, ".local/share/opencode/opencode.db"),
  ];
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Detect a usable OpenCode install. Null → the fallback stays disabled. */
export async function detectOpenCode(): Promise<OpenCodeInstall | null> {
  const dbPath = await firstExisting(opencodeDbCandidates());
  if (dbPath === null) return null;
  const sqlite3Path = await firstExisting(SQLITE3_CANDIDATES);
  const opencodePath = await firstExisting(OPENCODE_BIN_CANDIDATES);
  if (sqlite3Path === null && opencodePath === null) return null;
  return { dbPath, sqlite3Path: sqlite3Path ?? "", opencodePath };
}

/** Strict validation before interpolating into SQL / CLI args. */
export function isOpenCodeSessionId(value: string): boolean {
  return /^ses_[A-Za-z0-9]+$/.test(value);
}

interface RawRow {
  role?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: unknown;
  model?: unknown;
  created?: unknown;
  completed?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMessageRow(row: RawRow): OpenCodeMessage | null {
  const created = num(row.created);
  if (created === null || typeof row.role !== "string") return null;
  const input = num(row.input);
  const output = num(row.output);
  const tokens =
    input !== null || output !== null
      ? {
          input: input ?? 0,
          output: output ?? 0,
          reasoning: num(row.reasoning) ?? 0,
          cacheRead: num(row.cacheRead) ?? 0,
          cacheWrite: num(row.cacheWrite) ?? 0,
        }
      : null;
  return {
    role: row.role,
    createdAt: created,
    completedAt: num(row.completed),
    tokens,
    cost: num(row.cost),
    model: typeof row.model === "string" ? row.model : null,
  };
}

const MESSAGES_SQL = `
SELECT json_extract(data,'$.role')               AS role,
       json_extract(data,'$.tokens.input')       AS input,
       json_extract(data,'$.tokens.output')      AS output,
       json_extract(data,'$.tokens.reasoning')   AS reasoning,
       json_extract(data,'$.tokens.cache.read')  AS cacheRead,
       json_extract(data,'$.tokens.cache.write') AS cacheWrite,
       json_extract(data,'$.cost')               AS cost,
       json_extract(data,'$.modelID')            AS model,
       json_extract(data,'$.time.created')       AS created,
       json_extract(data,'$.time.completed')     AS completed
FROM message
WHERE session_id = ?
ORDER BY time_created;
`;

const SESSION_SQL = `
SELECT tokens_input       AS input,
       tokens_output      AS output,
       tokens_reasoning   AS reasoning,
       tokens_cache_read  AS cacheRead,
       tokens_cache_write AS cacheWrite,
       cost               AS cost,
       model              AS model
FROM session
WHERE id = ?;
`;

async function sqliteQuery(
  install: OpenCodeInstall,
  sql: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const uri = `file:${install.dbPath}?mode=ro`;
  const { stdout } = await run(
    install.sqlite3Path,
    ["-readonly", "-json", "-cmd", ".timeout 3000", uri, sql.replace("?", `'${sessionId}'`)],
    { timeout: 8_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

async function exportFallback(
  install: OpenCodeInstall,
  sessionId: string,
): Promise<OpenCodeMessage[]> {
  if (install.opencodePath === null) return [];
  const { stdout } = await run(install.opencodePath, ["export", sessionId], {
    timeout: 15_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const start = stdout.indexOf("{");
  if (start === -1) return [];
  const doc = JSON.parse(stdout.slice(start)) as {
    messages?: { info?: Record<string, unknown> }[];
  };
  const out: OpenCodeMessage[] = [];
  for (const m of doc.messages ?? []) {
    const info = m.info;
    if (info === undefined) continue;
    const t = info.tokens as Record<string, unknown> | undefined;
    const cache = (t?.cache ?? {}) as Record<string, unknown>;
    const time = (info.time ?? {}) as Record<string, unknown>;
    const msg = parseMessageRow({
      role: info.role,
      input: t?.input,
      output: t?.output,
      reasoning: t?.reasoning,
      cacheRead: cache.read,
      cacheWrite: cache.write,
      cost: info.cost,
      model: info.modelID,
      created: time.created,
      completed: time.completed,
    });
    if (msg !== null) out.push(msg);
  }
  return out;
}

/**
 * Read all messages of an OpenCode session. Returns null when the session is
 * not present yet or the store is unreadable — callers treat that as
 * "no local data" and keep the plugin's no-usage state.
 */
export async function fetchSessionMessages(
  install: OpenCodeInstall,
  sessionId: string,
  onError?: (msg: string) => void,
): Promise<{ messages: OpenCodeMessage[]; totals: OpenCodeSessionTotals | null } | null> {
  if (!isOpenCodeSessionId(sessionId)) return null;
  try {
    if (install.sqlite3Path !== "") {
      let lastErr: unknown;
      let rows: Record<string, unknown>[] | null = null;
      for (let attempt = 0; attempt < 3 && rows === null; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 150 * attempt));
        try {
          rows = await sqliteQuery(install, MESSAGES_SQL, sessionId);
        } catch (e) {
          lastErr = e;
        }
      }
      if (rows === null) throw lastErr;
      // Session totals are enrichment only — a transient WAL lock must not
      // take the per-turn messages down with it.
      const sessionRows = await sqliteQuery(install, SESSION_SQL, sessionId).catch(
        () => [] as Record<string, unknown>[],
      );
      const messages = rows
        .map((r) => parseMessageRow(r as RawRow))
        .filter((m): m is OpenCodeMessage => m !== null);
      if (sessionRows.length === 0 && messages.length === 0) return null;
      const s = sessionRows[0];
      let model: string | null = null;
      if (s !== undefined && typeof s.model === "string") {
        try {
          const parsed = JSON.parse(s.model) as { id?: unknown };
          model = typeof parsed.id === "string" ? parsed.id : s.model;
        } catch {
          model = s.model;
        }
      }
      const totals: OpenCodeSessionTotals | null =
        s === undefined
          ? null
          : {
              input: num(s.input) ?? 0,
              output: num(s.output) ?? 0,
              reasoning: num(s.reasoning) ?? 0,
              cacheRead: num(s.cacheRead) ?? 0,
              cacheWrite: num(s.cacheWrite) ?? 0,
              cost: num(s.cost) ?? 0,
              model,
            };
      return { messages, totals };
    }
  } catch (e) {
    onError?.(`sqlite: ${String(e).slice(0, 300)}`);
  }
  try {
    const messages = await exportFallback(install, sessionId);
    if (messages.length === 0) onError?.("export: 0 messages");
    return messages.length === 0 ? null : { messages, totals: null };
  } catch (e) {
    onError?.(`export: ${String(e).slice(0, 300)}`);
    return null;
  }
}

/**
 * Attribute OpenCode assistant calls to BB turns.
 *
 * BB turn boundaries (`turn/started` timestamps) precede the OpenCode user
 * message by a few ms; assistant calls land inside the turn window. Each call
 * joins the latest turn that started at or before it (with a small slack for
 * clock skew between the bridge and the local store). Calls predating the
 * first turn — e.g. history replayed into a forked BB thread — are ignored.
 */
export function attributeToTurns(
  messages: readonly OpenCodeMessage[],
  turns: readonly { startedAt: number }[],
): Map<number, OpenCodeTurnUsage> {
  const SLACK_MS = 15_000;
  const result = new Map<number, OpenCodeTurnUsage>();
  const sorted = turns
    .map((t, index) => ({ startedAt: t.startedAt, index }))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (sorted.length === 0) return result;

  const decodeOut = new Map<number, number>();
  const decodeSecs = new Map<number, number>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || msg.tokens === null) continue;
    let target: number | null = null;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].startedAt - SLACK_MS <= msg.createdAt) {
        target = sorted[i].index;
        break;
      }
    }
    if (target === null) continue;
    let agg = result.get(target);
    if (agg === undefined) {
      agg = {
        calls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        costUsd: null,
        decodeTokPerSec: null,
      };
      result.set(target, agg);
    }
    const t = msg.tokens;
    agg.calls += 1;
    agg.inputTokens = t.input;
    agg.cachedInputTokens = t.cacheRead;
    agg.cacheWriteTokens += t.cacheWrite;
    agg.outputTokens += t.output;
    agg.reasoningOutputTokens += t.reasoning;
    if (msg.cost !== null) agg.costUsd = (agg.costUsd ?? 0) + msg.cost;
    if (msg.completedAt !== null && msg.completedAt > msg.createdAt) {
      decodeOut.set(target, (decodeOut.get(target) ?? 0) + t.output);
      decodeSecs.set(
        target,
        (decodeSecs.get(target) ?? 0) + (msg.completedAt - msg.createdAt) / 1000,
      );
    }
  }
  for (const [index, agg] of result) {
    const out = decodeOut.get(index) ?? 0;
    const secs = decodeSecs.get(index) ?? 0;
    agg.decodeTokPerSec = out > 0 && secs > 0 ? out / secs : null;
  }
  return result;
}
