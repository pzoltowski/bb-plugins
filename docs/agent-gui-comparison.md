# Agent GUI comparison: T3 Code vs bb vs Paseo vs Zed Delta

Last checked: **2026-10-02**

| App | Version checked |
|---|---|
| T3 Code | v0.0.44 (2026-09-29); main at 54084ae |
| bb | installed desktop app |
| Paseo | CLI 0.10.2 |
| Zed Delta | 0.18.0 (public beta since 2026-09-16) |

Legend: ✅ yes · 🟡 partial / caveat · ❌ no · ❓ unknown · 🔌 only via a plugin (not built in)

## Summary table

| Feature | T3 Code | bb | Paseo | Zed Delta |
|---|---|---|---|---|
| **Providers:** custom ACP agent (Devin, Muse Code…) | 🟡 6 built-in; can't add your own (PRs open) | ✅ by config (`customAgents`) | ✅ about 38 one-click, plus custom in config | ❌ own agent only; ACP is "in progress" |
| **Cmd+F** in the current thread | ❌ (PR #12959 open) | 🟡 browser find; may miss off-screen messages | ✅ also finds unloaded history | ✅ with Cmd+G next/prev |
| **Search across threads** | ✅ Cmd+K, full text | ✅ Cmd+K, full text | 🟡 metadata only | 🟡 titles only (Cmd+T) |
| **Context usage** meter | ✅ ring, used/max on hover | ✅ ring with breakdown | ✅ ring, used/max and cost | 🟡 ring, but bytes, not tokens |
| **Token stats per turn** (tok/s, cost, in/out/cache) | 🟡 aggregate Usage page only | 🔌 turn-stats (my plugin) | 🟡 session cost only | ❌ |
| **Plan usage limits** (5h / weekly) | ✅ in app, plus mobile widgets | ✅ built in, plus plugins | ✅ Usage screen | 🟡 web dashboard, Zed credits only |
| **Handoff to a new model or provider** | 🟡 model switch only; provider locked | ✅ one-click "Handoff to new thread" | 🟡 model switch; handoff via skill | 🟡 model switch inside its own agent |
| **Spawn agents on other providers** | ❌ (V2 preview only) | ✅ `thread spawn`, MCP tools | ✅ MCP `create_agent` (opt-in) | 🟡 subagents, but only its own agent |
| **Shortcut hints on hover** | ✅ about 25 buttons | 🟡 badges while holding Cmd | ✅ tooltips with shortcut badges | 🟡 Cmd+/ reference sheet |
| **Rebind keys** | ✅ | ✅ | ✅ | ❌ fixed defaults |
| **Mobile** | ✅ polished native iOS/Android, widgets, Live Activities | 🟡 early-access native app, plus web via bb Connect | ✅ polished native iOS/Android | 🟡 mobile web only |

## Notes and evidence

### Providers / custom ACP
- **T3 Code:**
  - Built in: Codex, Claude Code, Cursor, Grok Build, OpenCode and Antigravity.
  - The "Custom ACP executable" setting only changes which Antigravity binary runs.
  - Open PRs that would add custom agents: #13801 (ACP registry agents, including Devin), #14014 (Devin/Gemini/Muse), #14693 (Kiro).
- **bb:**
  - Built in: claude-code, codex, pi, plus the ACP agents cursor, grok and opencode.
  - Custom agents: `bb plugin config provider-acp set customAgents '[{id,displayName,command}]'`. The Devin providers use this.
  - Muse Code gets a proper icon from my muse-code plugin.
- **Paseo:**
  - The ACP catalog installs agents with one click.
  - Custom agents: set `"extends": "acp"` in `~/.paseo/config.json`. Devin isn't in the catalog, so it goes here.
- **Zed Delta:**
  - Runs its own agent on many models. Supports ChatGPT/Copilot/Grok subscriptions, API keys, and OpenAI- or Anthropic-compatible endpoints.
  - Claude Code over ACP is on the roadmap but not shipped. Custom ACP is a feature of the **Zed editor**, not Delta.

### Search
- **bb:**
  - Cmd+F runs `window.find` (desktop app only).
  - The timeline only renders rows near the current scroll position, so far-away messages likely won't match. That probably explains why it seemed missing.
  - For older messages, use Cmd+K or `bb thread search <q>`. I found no per-project filter.
- **T3 Code:**
  - Five Cmd+F PRs have been closed. #12959 is still open.
  - Cmd+K searches user messages and final agent replies across all environments.

### Context and token stats
- **Context meters:**
  - T3 Code's meter is buggy for Claude (it jumps to 100% at the end of a turn; #8594).
  - Delta measures **bytes**, not tokens.
- **Per-turn tok/s and the in/out/cache split:** no app has this built in. bb has it only through my turn-stats plugin.
  - T3 Code shows "Worked for X" per turn, and cost and cache totals on the Usage page (mod+U).

### Plan limits
- **T3 Code** has the most features here:
  - Pools multiple accounts into one bar
  - "Use reset" for banked reset credits
  - `/usage-limits` command in the composer
  - iOS/Android home-screen widgets
- **bb:**
  - Built in: the provider-usage sidebar footer and `bb settings usage`.
  - Optional: the provider-retry plugin waits for a limit reset and retries (currently disabled).
  - Extra third-party usage plugins are installed.

### Handoff / subagents
- **bb** is the only app with built-in one-click handoff to a different provider. It is in the follow-up model picker.
- **T3 Code:**
  - The provider is locked once a thread starts.
  - Fork (#14559, same provider) is still a PR.
  - Cross-provider `delegate_task` exists only on the unmerged Orchestrator V2 preview (#2829, #14416).
- **Paseo:** spawning agents through MCP has to be turned on in Settings → host → Agents → Enable Paseo tools.
- **Delta:**
  - Subagents use Worker, Scout and Reviewer profiles and can run different models.
  - At most 4 per thread and 8 total.

### Shortcuts discoverability
- **T3 Code:**
  - Buttons show their shortcut via `shortcutLabelForCommand`.
  - Bindings are stored in `~/.t3/userdata/keybindings.json` and support `when` conditions.
- **Paseo:** has hover tooltips with shortcut badges and a searchable shortcut help.
- **bb:**
  - Holding Cmd shows shortcut badges (`showKeyboardHints`).
  - Rebinding works through `bb settings keyboard list|set|reset`.
  - It's unclear whether every button shows its shortcut on hover, Codex-app style.

### Mobile
- **T3 Code:** native apps from the App Store and Google Play.
  - Connects through the T3 Connect relay or Tailscale.
  - Push notifications, widgets, Live Activities, and iPad keyboard support.
- **Paseo:** mobile is its main focus.
  - Native apps plus web.
  - E2E-encrypted relay, Tailscale or LAN.
- **bb:**
  - The native app is behind the `mobileApp` experiment (enabled on this Mac).
  - Otherwise use the touch-friendly web UI at `<handle>.getbb.app`.
- **Delta:** mobile browser only.
  - You can read, message and review.
  - No terminals. Firefox mobile is not supported.

## Ideas for new rows
- Worktree / isolation per thread
- Diff review and commenting
- Live multiplayer collaboration (Delta's main pitch)
- Push notifications
- Plugin / extension SDK
- Scheduled / automated runs
