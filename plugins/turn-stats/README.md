# Turn Stats

Per-turn statistics for BB threads — like Zed's `agent.show_turn_stats`, but for
any BB provider. Adds a chart icon to the thread header, a stats action on
message hover, and a side panel with the full turn history.

## Surfaces

| Surface | Slot | What it shows |
|---|---|---|
| Thread-header icon | `experimental_threadHeaderAction` | Chart icon; hover → card with the latest/active turn's stacked token breakdown, duration, avg tok/s, est. cost, session totals. Click → opens the panel. |
| Message action | `messageAction` | "Turn stats" button on the per-message hover bar; opens the panel focused on that message's turn (matched via `message.sourceSeqEnd`). Also appears on user prompts — it maps to the turn that prompt started. |
| Side panel | `threadPanelAction` | Legend, per-turn rows (duration, input / cached / reasoning / output mini-bars, t/s, est. cost), session start + last activity, session totals. |

## Settings

Configurable in Tools → Turn Stats (or `bb plugin config turn-stats`):

| Setting | Options | Default |
|---|---|---|
| `chip` | `stats` / `icon` | `stats` — the header chip shows `40s · 39.7 tok/s · $0.16` inline; `icon` renders just the chart glyph (hover still opens the card, click opens the panel) |
| `placement` | `header` / `composer` / `header + composer` | `header` — `composer` shows the same chip as a slim banner above the composer instead |
| `opencodeFallback` | `auto` / `off` | `auto` — for OpenCode ACP threads, read real per-turn tokens/cost/decode-speed from OpenCode's local session store |
| `devinTap` | `on` / `off` | `on` — registers the "Devin (stats tap)" provider, an acp-tap shim that records the per-turn usage `devin acp` already emits |

Note: there is no BB slot inside the composer's own footer row (where the
permission picker and context meter live) — `composer` places a banner *above*
the composer, which is the nearest supported surface. A true footer-row
placement would need a core BB slot.

## Data

All numbers come from normalized BB thread events (`thread/tokenUsage/updated`,
`thread/contextWindowUsage/updated`, `turn/started`, `turn/completed`,
`client/turn/requested`), reduced in `src/stats.ts`. The server tails events
only for threads a client is watching.

- **Cached input** — one `cachedInputTokens` bucket; BB does not split
  cache-read vs cache-write.
- **Reasoning** — `reasoningOutputTokens`, counted in output for cost.
- **tok/s** — output tokens ÷ whole-turn elapsed. Whole-turn time includes
  queueing, TTFT, tool calls and permission waits, so it is labeled "avg",
  never "decode".
- **Cost** — estimated from a bundled model price table (`estimateCostUsd`);
  labeled `est.`. BB exposes plan quota (`usedUsdCents`) but no per-turn $.
- **Session** — totals from the newest usage event's cumulative `total`
  bucket; start = `thread/started` or thread `createdAt`.
- **Context** — `ctx used/size` per turn and per session from
  `thread/contextWindowUsage/updated`; shown for providers that report it
  (including ACP agents like Devin and OpenCode).

### OpenCode local fallback

ACP's stable protocol has no per-turn token field (get-bb/bb#2397), so ACP
threads normally show timing only. OpenCode persists every model call —
tokens, real USD cost, call timing — in `~/.local/share/opencode/opencode.db`,
and its ACP `usage_update` carries the session id (`ses_…`) as the BB
`providerThreadId`. When a watched thread has no `tokenUsage` events and its
providerThreadId is a valid OpenCode session, the plugin reads that store
(read-only `sqlite3`, with `opencode export` as fallback) and attributes calls
to turns by timestamp. This yields:

- real per-turn input / cached-read / cache-write / reasoning / output;
- **real cost** (`costUsd`, shown without `est.`);
- **true decode tok/s** — output ÷ summed per-call generation time, excluding
  tool runs and queueing (labeled `decode`, vs `avg` for turn-wide).

Provider-native `tokenUsage` events always win when present. Missing OpenCode,
a locked/changed DB, or a session not yet flushed degrade silently to the
usual no-usage state. Disable via `opencodeFallback: off`.

### Devin stats tap

`devin acp` already emits everything needed — BB's generic ACP bridge just
drops it. On a live session we verified:

- `session/prompt` → `result.usage.{inputTokens, outputTokens, totalTokens}`
  (the draft end-turn usage shape);
- `usage_update._meta` → `cognition.ai/inputTokens` / `outputTokens`;
- `_cognition.ai/agent_stopped` → `inputTokens`, `outputTokens`, `ttftMs`,
  `tokensPerSec`, `totalTimeMs`, `modelLabel`, `toolCalls`;
- `_cognition.ai/turn_stats` → Response Statistics incl. cached input;
- `_cognition.ai/billingInformation` → ACU cost, when billed.

The plugin registers a second provider, **Devin (stats tap)**, whose launch
spec runs `~/.bb/plugins/turn-stats/acp-tap.mjs` — a ~100-line stdio
passthrough that spawns the real `devin acp`, forwards traffic byte-for-byte,
and tees the messages above into `~/.bb/acp-tap/<sessionId>.jsonl`. The plugin
reads that file (sessionId = `providerThreadId`) and attributes records to
turns by timestamp. This yields real per-turn input/output/cached tokens,
provider-measured **decode tok/s**, **TTFT**, and ACU cost when reported.

Trade-offs, honestly:

- Threads must be started on the tap provider — the builtin `acp-devin`
  stays timing + context only. Sessions launched there produce no tap file.
- It is a private Cognition extension: renamed/removed fields degrade to
  context-only, never wrong data. The shim forwards bytes regardless of
  parsing, so the pipe itself can't break on payload drift.
- The tap file only exists where the bridge spawned it — local-machine
  threads. A remote host writes its JSONL on the remote, which this server
  can't read; those threads show timing only.
- Disable via `devinTap: off` (stops registering the provider; existing tap
  data stays readable).

### Muse (muse-acp) — same tap, no extra provider

bb-plugin-muse-code routes its own launch spec through the identical shim, so
threads on the normal **Muse Code** provider are tapped automatically — no
second picker entry. muse-acp reports *cumulative* session totals on every
`usage_update` (`_meta.museCumulative.{promptTokens, outputTokens,
totalTokens}`) plus an adapter-computed list-price `cost`. This plugin diffs
consecutive snapshots across turn boundaries to get per-turn input/output and
a per-turn cost estimate.

Honest labeling: Muse cost is marked `est.` — it's the adapter's catalog
list-price estimate (`billing: false`), better rates than our bundled table
but still not a billing figure.

The shim also emits a `turn_timing` record per prompt — only chunk
*timestamps*, never content — which this plugin decomposes into three
wire-measured spans per turn: **ttft** (prompt → first chunk), **gen**
(first → last chunk), and **settle tail** (last chunk → result). The tail is
the interesting one: muse-acp holds the `session/prompt` result open for a
retraction window after `turn/completed`, which we measured at 11–25s. That
dead time is what makes a fast answer feel slow — and what inflates `avg`
t/s — so the card labels these `measured on wire` separately from the
provider-reported numbers.

### Roadmap: the proper fix is upstream

The right long-term fix is in BB's ACP bridge, not here —
[get-bb/bb#2397](https://github.com/get-bb/bb/issues/2397) tracks it. The
bridge already receives `session/prompt` results (containing `usage`) and
`usage_update` `_meta` tokens; it just doesn't map them to
`thread/tokenUsage/updated` events. A small upstream patch would:

1. map `PromptResponse.usage` → `tokenUsage` events (the draft
   [end-turn usage RFD](https://agentclientprotocol.com/rfds/end-turn-token-usage)
   shape — Devin already implements it);
2. forward `usage_update._meta` token fields into the same event;
3. optionally surface `_cognition.ai/agent_stopped` stats (ttft/tokensPerSec)
   and `billingInformation` as cost events.

If/when that lands, native `tokenUsage` events appear and this plugin prefers
them automatically (native always wins over fallbacks). The tap becomes a
harmless passthrough you can disable with `devinTap: off` — no migration
needed. Until then the tap is the only way to get real per-turn Devin stats
without reimplementing an ACP client.

## Architecture

```
BB thread events ──► server tailer (background.service, 2.5s poll of
                     threads with an open watcher) ──► src/stats.ts
                     reduce ──► realtime publish "turn-stats" ──► app.tsx
                     refetches via getThreadStats RPC

OpenCode threads ──► src/opencode.ts reads ~/.local/share/opencode DB
                     (or `opencode export`) ──► merged in src/stats.ts

Devin (stats tap) ──► acp-tap.mjs proxies `devin acp` and tees usage
threads               signals to ~/.bb/acp-tap/<sessionId>.jsonl
                      ──► src/devin.ts reads + attributes ──► stats.ts

Muse Code         ──► same shim inside bb-plugin-muse-code's launch spec
threads               (no separate provider) tees cumulative usage_update
                      snapshots ──► src/muse.ts diffs per-turn deltas
```

Nothing is persisted by the plugin itself; BB stores the events, OpenCode
stores its session DB, and the tap JSONL is a side-channel the shim writes.

## Development

```sh
npm install            # from repo root
npm run typecheck --workspace=bb-plugin-turn-stats
bb plugin install ./plugins/turn-stats
bb plugin reload turn-stats
```

Design mocks and rationale: [`design/`](./design/).
