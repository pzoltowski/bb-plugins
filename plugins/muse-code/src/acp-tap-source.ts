// Source of the ACP tap shim, embedded so the built plugin writes it to disk
// at startup — no packaging concerns. KEEP IN SYNC with the identical copy in
// bb-plugin-turn-stats (src/acp-tap-source.ts); the shim is generic — it runs
// whatever TAP_SPAWN says and tees usage signals to TAP_DIR.
//
// The shim is spawned as the provider command: bb's ACP bridge talks stdio
// JSON-RPC to the shim, the shim forwards everything byte-for-byte to the
// real agent (`muse-acp`), and on the side parses agent→client traffic for
// usage signals the bridge drops: session/prompt result.usage, usage_update
// (used/size/cost/_meta incl. museCumulative), and extension notifications.
//
// Forwarding happens before parsing and every capture is wrapped — the worst
// outcome of any bug is a missing stats line, never a broken pipe.

export const ACP_TAP_FILENAME = "acp-tap.mjs";

export const ACP_TAP_SOURCE = `#!/usr/bin/env node
// Generated — do not edit, the plugin rewrites it on startup.
// Env: TAP_SPAWN (command line to run, e.g. "muse-acp"), TAP_DIR (JSONL out).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

const SPAWN = (process.env.TAP_SPAWN || "muse-acp").split(/\\s+/);
const TAP_DIR = process.env.TAP_DIR;
const MAX_BYTES = 4 * 1024 * 1024;

if (TAP_DIR) {
  try { mkdirSync(TAP_DIR, { recursive: true }); } catch {}
}

const child = spawn(SPAWN[0], SPAWN.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

// request id → { method, sessionId, sentAt } so bare response objects (which carry
// no sessionId) can still be attributed. Bounded: ids are deleted on use.
const pending = new Map();

// sessionId → in-flight turn timing. Only chunk TIMESTAMPS are kept — never
// content — so each turn emits one turn_timing record when its prompt result
// arrives: {promptAt, firstChunkAt, lastChunkAt, chunks}. That decomposes a
// turn into TTFT / streaming / settle-tail as measured on the wire, which is
// how adapter latency (e.g. muse-acp's ~20s post-completion hold) becomes
// visible without trusting provider self-reports.
const turnTiming = new Map();

function tap(sessionId, kind, data) {
  if (!TAP_DIR || !sessionId) return;
  try {
    const file = join(TAP_DIR, sessionId + ".jsonl");
    try {
      if (statSync(file).size > MAX_BYTES) {
        renameSync(file, file + ".1");
      }
    } catch {}
    appendFileSync(file, JSON.stringify({ at: Date.now(), kind, data }) + "\\n");
  } catch {}
}

function inspectClient(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method) {
    pending.set(m.id, { method: m.method, sessionId: m.params?.sessionId, sentAt: Date.now() });
    if (m.method === "session/prompt" && m.params?.sessionId) {
      turnTiming.set(m.params.sessionId, { promptAt: Date.now(), firstChunkAt: 0, lastChunkAt: 0, chunks: 0 });
    }
  }
}

function inspectAgent(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const sid = m.params?.sessionId || m.result?.sessionId;
  if (m.method === "session/update") {
    const u = m.params?.update;
    if (u?.sessionUpdate === "usage_update") {
      tap(sid, "usage_update", { used: u.used, size: u.size, cost: u.cost, meta: u._meta });
    } else if (u && String(u.sessionUpdate).includes("chunk")) {
      const t = sid ? turnTiming.get(sid) : undefined;
      if (t) {
        const now = Date.now();
        if (!t.firstChunkAt) t.firstChunkAt = now;
        t.lastChunkAt = now;
        t.chunks++;
      }
    } else if (u && u.sessionUpdate) {
      tap(sid, "update:" + u.sessionUpdate, u);
    }
  } else if (typeof m.method === "string" && m.method.startsWith("_")) {
    const name = m.method.slice(1);
    tap(sid, name.startsWith("cognition.ai/") ? name.slice("cognition.ai/".length) : name.replace(/\\//g, ":"), m.params);
  } else if (m.id !== undefined && m.result !== undefined) {
    const req = pending.get(m.id);
    pending.delete(m.id);
    if (req?.method === "session/prompt") {
      const t = req.sessionId ? turnTiming.get(req.sessionId) : undefined;
      if (req.sessionId) turnTiming.delete(req.sessionId);
      tap(req.sessionId, "turn_timing", {
        promptAt: t?.promptAt ?? req.sentAt,
        firstChunkAt: t?.firstChunkAt || null,
        lastChunkAt: t?.lastChunkAt || null,
        chunks: t?.chunks ?? 0,
      });
      if (m.result.usage) {
        tap(req.sessionId, "prompt_usage", {
          usage: m.result.usage,
          stopReason: m.result.stopReason,
          meta: m.result._meta,
        });
      }
    } else if (req?.method === "session/new" || req?.method === "session/load") {
      if (m.result?.sessionId) tap(m.result.sessionId, "session_open", {});
    }
  }
}

let inBuf = "";
process.stdin.on("data", (chunk) => {
  child.stdin.write(chunk);
  inBuf += chunk.toString("utf8");
  let i;
  while ((i = inBuf.indexOf("\\n")) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (line) inspectClient(line);
  }
});
process.stdin.on("end", () => child.stdin.end());

let outBuf = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  outBuf += chunk.toString("utf8");
  let i;
  while ((i = outBuf.indexOf("\\n")) >= 0) {
    const line = outBuf.slice(0, i).trim();
    outBuf = outBuf.slice(i + 1);
    if (line) inspectAgent(line);
  }
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write("acp-tap: failed to spawn " + SPAWN.join(" ") + ": " + err.message + "\\n");
  process.exit(127);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
`;
