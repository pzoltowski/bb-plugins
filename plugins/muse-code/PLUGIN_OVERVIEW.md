# Muse Code (ACP)

Runs bb threads on Muse Code, Meta's terminal coding agent, through the
`muse-acp` adapter — a native bridge between bb's Agent Client Protocol and
Muse Code's own session protocol.

`bb muse-code install` fetches the adapter for the machine's platform and checks
it against the SHA-256 the project publishes, on any machine bb manages. Muse
Code arrives as a named provider with its own icon, rather than the generic
glyph a manually configured ACP agent shows. Its reasoning levels come from
what the adapter reports, so the picker offers the efforts Muse implements and
none it does not.

Token and context usage come from Muse itself rather than an estimate, so the
context meter reflects what the session actually spent.

Requires a Muse Code subscription and the `muse` CLI, which is where Muse Code
authentication lives. `muse-acp login` installs the CLI if it is missing and
signs in.

The plugin also registers a **Muse** voice service — `muse voice transcribe`
as a bb AI service, the same trick the Codex provider uses for gpt-transcribe.
Select it with `bb settings ai-services set voice muse` and bb's mic button,
`bb voice transcribe`, and anything else routed through bb voice dictation use
Muse instead of bb cloud. Dictation is online: clips are normalized to
16 kHz mono WAV locally, then sent to Meta's Voyager ASR over your Muse Code
sign-in — no API key, no extra cleanup pass. Unlike Codex, the `muse` CLI
accepts no vocabulary hint, so jargon priming needs a Prompt action instead of
the transcribe `hint`.
