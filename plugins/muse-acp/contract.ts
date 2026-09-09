// Typed host RPC shared by server.ts (caller) and host.ts (implementation).
// Both run on the machine the thread executes on, not the bb server.
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
      museCliPath: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  install: {
    input: z
      .object({
        installDir: z.string().min(1),
        version: z.string().optional(),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      tag: z.string(),
      triple: z.string(),
      url: z.string(),
      installDir: z.string(),
      binaryPath: z.string().nullable(),
      version: z.string().nullable(),
      sha256: z.string().nullable(),
      alreadyInstalled: z.boolean(),
      error: z.string().nullable(),
      notes: z.array(z.string()),
    }),
  },
});
