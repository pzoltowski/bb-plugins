# Muse Code (ACP)

Registers [Muse Code](https://github.com/BrokkAi/muse-acp) as a first-class bb
agent provider, so it carries its own name and icon everywhere bb shows a
provider — instead of the generic tool glyph that a `customAgents` entry gets.

Requires the `muse-acp` adapter on `PATH` (v0.2.5 or newer) and a Muse Code
subscription. The adapter ships its own installer; this plugin does not
download binaries.

## Status

Working registration; not yet released. Installing it should replace the
`customAgents` entry for Muse in bb's `provider-acp` settings — both claim the
provider id `acp-muse-code`.

What registering here fixes, versus that `customAgents` entry:

| | `customAgents` | this plugin |
| --- | --- | --- |
| Icon | `Toolbox` generic glyph | Meta mark, tinted |
| Reasoning levels | `low…max` — invents `max`, drops `none`/`ultra` | the six Muse levels bb can express |
| Service tiers | `default`/`fast` — Muse has neither | none |
| Sign-in hint | generic | points at the `muse` CLI, which is where Muse actually authenticates |

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
