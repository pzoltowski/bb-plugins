// Transcribe an audio clip through `muse voice transcribe` — Muse Code's own
// STT (Meta's Voyager ASR over the signed-in account, no API key). Used by
// the host entry's voice.* handlers and by the server-side AI service as a
// local fallback when no primary host is connected.
//
// muse requires a clip that decodes to 16 kHz mono PCM, so anything else
// (webm/opus from bb's composer, m4a, mp3) is normalized through ffmpeg
// first. Without ffmpeg the clip goes to muse untouched — already-valid WAV
// still works; anything else fails with muse's own error message.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type VoiceErrorCode =
  | "auth_required"
  | "invalid_response"
  | "rate_limited"
  | "request_failed"
  | "service_unavailable"
  | "timeout";

export interface TranscribeInput {
  audioBase64: string;
  filename: string;
  mimeType: string;
  timeoutMs: number;
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; code: VoiceErrorCode; message: string };

export type VoiceStatus = { ready: true } | { ready: false; message: string };

const MUSE_CLI_CANDIDATES = [
  "~/.local/bin/muse",
  "/opt/homebrew/bin/muse",
  "/usr/local/bin/muse",
];

const FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

const EXT_BY_MIME: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
};

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command: string, fallbacks: string[]): Promise<string | null> {
  if (command.includes("/") || command.includes("\\")) {
    const expanded = expandHome(command);
    return (await isExecutable(expanded)) ? expanded : null;
  }
  try {
    const { stdout } = await run(os.platform() === "win32" ? "where" : "which", [command]);
    const found = stdout
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (found !== undefined) return found;
  } catch {
    // fall through to candidate paths
  }
  for (const candidate of fallbacks) {
    const expanded = expandHome(candidate);
    if (await isExecutable(expanded)) return expanded;
  }
  return null;
}

export function resolveMuseCli(): Promise<string | null> {
  return resolveCommand("muse", MUSE_CLI_CANDIDATES);
}

function museAuthPath(): string {
  const override = process.env.MUSE_AUTH_PATH;
  if (override !== undefined && override !== "") return expandHome(override);
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "muse", "auth.json");
}

export async function voiceStatus(): Promise<VoiceStatus> {
  if ((await resolveMuseCli()) === null) {
    return { ready: false, message: "The `muse` CLI is not installed on this machine." };
  }
  // OAuth sign-in lands a `providers` entry here; the secret itself lives in
  // macOS Keychain (`storage: "keychain"`) or a keychain-fallback file.
  if ((process.env.META_API_KEY ?? "") !== "") return { ready: true };
  try {
    const auth = JSON.parse(await readFile(museAuthPath(), "utf8")) as {
      providers?: Record<string, unknown>;
    };
    if (Object.keys(auth.providers ?? {}).length > 0) return { ready: true };
  } catch {
    // unreadable or malformed credential file — fall through to not-ready
  }
  return {
    ready: false,
    message: "Sign in to Muse Code on this machine with `muse login`.",
  };
}

function clipExtension(mimeType: string, filename: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base in EXT_BY_MIME) return EXT_BY_MIME[base];
  const ext = path.extname(filename);
  return ext === "" ? ".bin" : ext;
}

function lastLines(text: string, count = 4): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-count).join(" ").trim();
}

function classifyFailure(detail: string): VoiceErrorCode {
  if (/auth|credential|sign ?in|log ?in|token|401|403/i.test(detail)) return "auth_required";
  if (/rate.?limit|429|quota/i.test(detail)) return "rate_limited";
  if (/network|unreachable|offline|connect|socket|econn/i.test(detail)) return "service_unavailable";
  return "request_failed";
}

function fail(code: VoiceErrorCode, message: string): TranscribeResult {
  return { ok: false, code, message };
}

export async function transcribeClip(
  input: TranscribeInput,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "muse-voice-"));
  try {
    const clip = path.join(tmp, `clip${clipExtension(input.mimeType, input.filename)}`);
    await writeFile(clip, Buffer.from(input.audioBase64, "base64"));

    let target = clip;
    const ffmpeg = await resolveCommand("ffmpeg", FFMPEG_CANDIDATES);
    if (ffmpeg !== null) {
      const wav = path.join(tmp, "clip-16k.wav");
      try {
        await run(
          ffmpeg,
          ["-v", "error", "-y", "-i", clip, "-ac", "1", "-ar", "16000", "-f", "wav", wav],
          { signal, timeout: 30_000 },
        );
        target = wav;
      } catch (err) {
        return fail(
          "invalid_response",
          `ffmpeg could not decode the clip: ${lastLines(stderrOf(err))}`,
        );
      }
    }

    const muse = await resolveMuseCli();
    if (muse === null) {
      return fail(
        "service_unavailable",
        "The `muse` CLI is not installed on this machine.",
      );
    }

    try {
      const { stdout } = await run(muse, ["voice", "transcribe", target], {
        // Skip the launcher's background update check and never let an auth
        // hiccup open an interactive device-login prompt inside an RPC.
        env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" },
        signal,
        timeout: input.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      const text = stdout.trim();
      if (text === "") return fail("invalid_response", "muse returned an empty transcript");
      return { ok: true, text };
    } catch (err) {
      const e = err as {
        killed?: boolean;
        signal?: string;
        code?: unknown;
        stderr?: string;
        message?: string;
      };
      if (e.killed === true || e.code === "ABORT_ERR") {
        return fail("timeout", `muse voice transcribe timed out after ${Math.round(input.timeoutMs / 1000)}s`);
      }
      const detail = lastLines(e.stderr ?? e.message ?? "unknown error");
      const code = classifyFailure(detail);
      return fail(
        code,
        code === "auth_required"
          ? `${detail} — sign in again with \`muse login\``
          : detail,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return e.stderr ?? e.message ?? "unknown error";
}
