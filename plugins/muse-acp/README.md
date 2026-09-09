# Muse Code (ACP)

Registers [Muse Code](https://github.com/BrokkAi/muse-acp) as a first-class bb
agent provider, so it carries its own name and icon everywhere bb shows a
provider — instead of the generic tool glyph that a `customAgents` entry gets.

Requires the `muse-acp` adapter on `PATH` (v0.2.5 or newer) and a Muse Code
subscription. The adapter ships its own installer; this plugin does not
download binaries.

## Status

Scaffold. The provider registration is not written yet, and two decisions block
it:

1. **Icon.** No Muse SVG exists on disk. The manifest currently names a
   built-in glyph as a placeholder. Note that Muse Code is a Meta product: the
   mark can be used for identification, with the disclaimer other bb plugins
   carry in `THIRD_PARTY_NOTICES.md`, but it stays Meta's trademark.
2. **Provider id.** Permanent once published. `acp-muse-code` is the natural
   slug and collides with an existing local `customAgents` entry, which should
   be removed at the same time the plugin lands.

## What the adapter advertises

Read from muse-acp v0.2.5, `src/main.rs` (`V1_INIT` / `V2_INIT`) and
`src/acp.rs` (`config_options`):

| | |
| --- | --- |
| Auth | `authMethods: []` — Muse Code signs in out of band through the `muse` CLI |
| Sessions | `loadSession: true`; capabilities `list`, `resume`, `close`; no fork |
| Prompt | text, image, embedded context; no audio |
| Session mode | `ask`, `auto`, `deny` |
| Reasoning effort | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra` |

bb's own vocabularies differ, so the registration has to map onto them:
permission modes are `accept-edits`, `auto`, `full`; reasoning levels are
`none`, `low`, `medium`, `high`, `xhigh`, `ultracode`, `max`, `ultra`.
