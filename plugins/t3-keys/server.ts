import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Frontend-only plugin: every command lives in app.tsx. bb requires a server
// entry, so this one does nothing.
export default async function plugin(_bb: BbPluginApi): Promise<void> {}
