// Typed host RPC shared by server.ts (caller) and host.ts (implementation).
// Both run on the machine the thread executes on, not the bb server.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const voiceErrorCode = z.enum([
  "auth_required",
  "invalid_response",
  "rate_limited",
  "request_failed",
  "service_unavailable",
  "timeout",
]);

const transcribeOutput = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string() }).strict(),
  z
    .object({ ok: z.literal(false), code: voiceErrorCode, message: z.string() })
    .strict(),
]);

const voiceStatusOutput = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }).strict(),
  z.object({ ready: z.literal(false), message: z.string().min(1) }).strict(),
]);

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
  // `muse voice transcribe` behind the plugin's AI-service registration.
  // The clip arrives base64 because the RPC payload is JSON; the host side
  // normalizes to 16 kHz mono WAV (what muse requires) before invoking it.
  "voice.transcribe": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: transcribeOutput,
  },
  "voice.status": {
    input: z.null(),
    output: voiceStatusOutput,
  },
});
