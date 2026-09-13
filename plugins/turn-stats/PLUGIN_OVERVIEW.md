# Turn Stats

Per-turn statistics for bb threads, for any provider that reports token usage —
a Zed-style turn footer, reimagined for bb's surfaces.

A small chart icon sits in the thread header; hovering it opens a card with the
latest turn's token breakdown (input, cached input, reasoning, output),
elapsed time, whole-turn average tok/s, and an estimated cost. Every message's
hover toolbar gains a "Turn stats" action that jumps into a side panel listing
every turn in the session — durations, stacked token bars, throughput, and
estimated per-turn and session cost, plus when the session started and when it
was last active.

Numbers come from bb's normalized thread events, so they work across providers.
Throughput is labeled as an average over the whole turn, and cost is estimated
from a bundled model price table — the plugin never claims decode speed or
provider-billed dollars it cannot see.

Useful for comparing prompting styles: how much context each turn re-reads,
how much of it was cached, and which turns were the expensive ones.
