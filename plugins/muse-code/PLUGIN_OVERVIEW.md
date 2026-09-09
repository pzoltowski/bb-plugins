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

Requires a Muse Code subscription and the `muse` CLI, which is where Muse Code
authentication lives.
