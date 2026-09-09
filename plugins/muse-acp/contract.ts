// Typed host RPC shared by server.ts (caller) and host.ts (implementation).
// muse-acp ships its own installer, so the plugin only ever asks a machine
// whether the binary is there — it never installs one.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const museHostContract = defineRpcContract({
  probe: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      platform: z.string(),
      arch: z.string(),
      binaryPath: z.string().nullable(),
      version: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
});
