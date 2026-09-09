# Muse Code (ACP)

Registers [Muse Code](https://github.com/BrokkAi/muse-acp) as a first-class bb
agent provider, so it carries its own name and icon everywhere bb shows a
provider — instead of the generic tool glyph a `customAgents` entry gets.

## Install

```sh
bb plugin install git:https://github.com/pzoltowski/bb-plugins.git@semver:muse-code/:^0.1.0
bb muse-code install
```

The second command downloads the upstream release for the machine's platform,
verifies it against the SHA-256 the project publishes beside each asset, and
installs it to `~/.local/bin` — the same place the project's own `install.sh`
uses, so the two paths agree. `--machine <id-or-name>` installs on another
machine; `--version <x.y.z>` pins one; `--force` reinstalls.

Muse Code itself still needs its own CLI, which is where authentication lives:

```sh
curl -fsSL https://api.meta.ai/muse-launcher.sh | sh   # then: muse
```

`bb muse-code status` reports both, so it always says which piece is missing.

## What this fixes versus a `customAgents` entry

| | `customAgents` | this plugin |
| --- | --- | --- |
| Icon | `Toolbox` generic glyph | Meta mark, tinted |
| Reasoning levels | `low…max` — invents `max`, drops `none`/`ultra` | the six Muse levels bb can express |
| Service tiers | `default`/`fast` — Muse has neither | none |
| Sign-in hint | generic | points at the `muse` CLI, where Muse actually authenticates |
| Getting the binary | find it yourself | `bb muse-code install` |

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

bb's own vocabularies differ, so the registration maps onto them: permission
modes are `accept-edits`, `auto`, `full`; reasoning levels are `none`, `low`,
`medium`, `high`, `xhigh`, `ultracode`, `max`, `ultra`. Muse's `minimal` has no
bb equivalent and is dropped.

## Provider id

`acp-muse-code`. It is permanent once published, and it collides with a
`customAgents` entry using the same id — remove that entry when installing this
plugin.
