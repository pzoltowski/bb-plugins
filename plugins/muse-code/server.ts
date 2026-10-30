// bb-plugin-muse-code — Muse Code as a first-class bb agent provider, through
// the muse-acp adapter (https://github.com/BrokkAi/muse-acp).
//
// Configuring Muse as a `customAgents` entry instead gets you bb's generic
// `Toolbox` glyph and a set of guessed capabilities: five reasoning levels
// that include `max` (Muse has no such level) and omit `none`/`ultra` (it has
// both), plus service tiers Muse does not implement. Registering the provider
// here replaces all of that with what the adapter actually advertises, and
// adds `bb muse-code install` so nobody has to go find the binary first.
//
// Capability facts read from muse-acp v0.16.0 and confirmed against a live
// handshake on Muse 1.4.12 (host fingerprint status=unknown — the adapter's
// newest classified pin is 1.4.11; additive-only surface, works):
//   authMethods:  muse-login         — terminal auth (`muse-acp login`); bb
//                                      0.47 advertises auth.terminal, so
//                                      sign-in can run in-band now
//   loadSession:  true               — list/resume/close/fork/subagents/
//                                      additionalDirectories; rename granted
//   prompt:       text, image, embeddedContext; chunked video since v0.13.0
//   mcp:          http + the adapter's `editor` server (v0.16.0): when the
//                 client advertises fs.read/writeTextFile — bb 0.47 does —
//                 Muse gets read/write/edit_text_file tools that go through
//                 the editor's fs (unsaved buffers, diff cards)
//   modes:        default | readOnly | plan (real ACP session modes since
//                 v0.10.0 — read-only/plan run on a second muse host with
//                 writes and shell disabled)
//   approval:     own `approval_mode` selector since v0.10.0 — allowAll |
//                 promptUnmatched | onRequest | denyUnmatched; approval ids
//                 still accepted on `mode`/`session/set_mode` for old clients
//   auto_review:  off | on selector (v0.10.0, default off; needs Muse >=1.4.2;
//                 boolean toggle for clients with configOptions.boolean)
//   reasoning:    per-model tiers since v0.10.0, remembered per model since
//                 v0.13.0
//   steering:     _meta.steering.supported on ACP v1 since v0.11.0
//   commands:     compact, goal, rename, workflow-child, feedback (v0.10.0),
//                 recap, skill-activation, workflow pause/resume (v0.13.0),
//                 plus Muse's skills
//   v1-only gaps: bb stays on ACP v1 — tool-call diffs, streamed tool output,
//                 agent terminals and URL-elicitation login are v2
import { type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { museHostContract } from "./contract.js";
import { runInstall } from "./install.js";
import { probeLocal } from "./probe.js";
import { transcribeClip, voiceStatus } from "./voice.js";
import { ACP_TAP_FILENAME, ACP_TAP_SOURCE } from "./src/acp-tap-source.js";

const PROVIDER_ID = "acp-muse-code";
const DISPLAY_NAME = "Muse Code";

// The tap shim sits between bb's bridge and `muse-acp` on stdio: traffic
// passes through byte-for-byte while usage_update / prompt responses are
// teed to ~/.bb/acp-tap/<sessionId>.jsonl — where bb-plugin-turn-stats (or
// any consumer) picks up the per-turn usage the bridge drops.
const TAP_DIR = join(homedir(), ".bb", "acp-tap");
const SHIM_PATH = join(homedir(), ".bb", "plugins", "muse-code", ACP_TAP_FILENAME);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "muse-acp command",
      description:
        "The adapter binary. Found on PATH by default; an absolute path also works.",
      default: "muse-acp",
    },
    installDir: {
      type: "string",
      label: "Install directory",
      description:
        "Where `bb muse-code install` puts the adapter. `~` expands on the target machine. Matches the upstream installer's default.",
      default: "~/.local/bin",
    },
  });

  const host = bb.hosts.experimental_client({ contract: museHostContract });

  // `muse voice transcribe` as a bb AI service — the same trick the Codex
  // provider uses for gpt-transcribe, riding the Muse Code sign-in instead
  // of a billing API key. Voice calls land on the primary host (the machine
  // the user works on); the server machine is the fallback. The `muse` CLI
  // takes no vocabulary prompt, so bb's `hint` goes unused.
  const VOICE_TIMEOUT_MS = 65_000;
  bb.experimental_aiServices.register({
    id: "muse",
    displayName: "Muse",
    async transcribe(audio, { signal }) {
      const input = {
        audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
        filename: audio.name === "" ? "voice-input" : audio.name,
        mimeType: audio.type === "" ? "application/octet-stream" : audio.type,
        timeoutMs: VOICE_TIMEOUT_MS,
      };
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      const result =
        hostId === null
          ? await transcribeClip(input, signal)
          : await host.call("voice.transcribe", input, {
              hostId,
              signal,
              timeoutMs: VOICE_TIMEOUT_MS + 10_000,
            });
      if (!result.ok) throw new Error(result.message);
      return result.text;
    },
    async status() {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (hostId === null) return voiceStatus();
      return host.call("voice.status", null, { hostId, timeoutMs: 5_000 });
    },
  });

  // Written on every plugin start so upgrades self-heal. The provider is
  // registered unconditionally — if the shim can't be written the launch
  // fails loudly in the bridge log rather than silently running untapped.
  try {
    mkdirSync(TAP_DIR, { recursive: true });
    mkdirSync(join(SHIM_PATH, ".."), { recursive: true });
    writeFileSync(SHIM_PATH, ACP_TAP_SOURCE, { mode: 0o755 });
  } catch (error) {
    bb.log.warn(`muse-code: could not write acp tap shim: ${error instanceof Error ? error.message : error}`);
  }

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    family: "acp",
    icon: "./icons/muse-code.svg",
    strings: {
      // The adapter advertises a terminal auth method (`muse-acp login`), but
      // bb's ACP bridge only runs headless auth methods, so sign-in stays out
      // of band. `muse-acp login` offers to install Muse Code first if it is
      // missing, then runs `muse login`.
      signInHint: "Run `muse-acp login` on that machine and approve the code in your browser, then reload the provider.",
      expiredHint: "Your Muse Code session expired. Run `muse-acp login` on that machine to sign in again, then reload.",
      installUrl: "https://github.com/BrokkAi/muse-acp#installation",
      iconTint: { light: "#0064E0", dark: "#0082FB" },
    },
    // Listed even where the adapter is missing, so the provider is
    // discoverable and `bb muse-code install` is reachable from its entry.
    // Hiding it until installed leaves a new user with nothing to click.
    experimental_visibility: "always",
    // Muse resolves model/list from the signed-in account, so one probe per
    // machine serves every workspace on it.
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      // No service tier concept in the adapter or in Muse's config options.
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      // bb's bridge sends compaction as a bare `/compact` prompt, which the
      // adapter submits to Muse natively (since v0.5.0).
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      // `/rename` exists as a Muse command, but bb's ACP bridge does not
      // forward thread renames to the agent.
      supportsThreadRename: false,
      // sessionCapabilities advertises list/resume/close/fork — ACP fork
      // clones at the tip only, no checkpoint rewind.
      fork: "tip",
      // bb answers the adapter's permission requests itself and never sets
      // Muse's own approval mode, so Muse's mode names don't matter here.
      // The ACP bridge rejects "auto".
      permissionModes: ["accept-edits", "full"],
      // Fallback ladder only; the live picker comes from the adapter's
      // reasoning_effort option. Muse's `minimal` has no bb equivalent.
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    },
    // The composer inserts `/goal ` and `/plan `. The adapter maps `/goal`
    // onto Muse's goal/* methods (since v0.7.0), and `plan` is a native Muse
    // skill; the rest of Muse's skills arrive as ACP available commands.
    composerActions: ["goal", "plan"],
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: DISPLAY_NAME,
        // ELECTRON_RUN_AS_NODE makes the bb binary (process.execPath in this
        // runtime) execute the shim as plain Node — no PATH lookup needed.
        command: process.execPath,
        args: [SHIM_PATH],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          // Absolute path preferred — the bridge's spawn env may not share
          // the PATH that resolved `command` at probe time.
          TAP_SPAWN:
            (await probeLocal((await settings.get()).command).catch(() => null))
              ?.binaryPath ?? (await settings.get()).command,
          TAP_DIR,
        } as Record<string, string>,
      },
    },
  });

  bb.cli.register({
    name: "muse-code",
    summary: "Install and inspect the Muse Code ACP provider",
    commands: [
      {
        name: "status",
        summary: "Show where the adapter and the Muse Code CLI resolve on a machine",
        usage: "bb muse-code status [--machine <id-or-name>] [--json]",
      },
      {
        name: "install",
        summary:
          "Install the adapter on a machine: downloads the upstream release for its platform, verifies the published SHA-256, and puts it in the install directory",
        usage:
          "bb muse-code install [--machine <id-or-name>] [--version <x.y.z>] [--install-dir <path>] [--force] [--json]",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      if (command === "install") return installCmd(rest, ctx);
      return statusCmd(command === "status" ? rest : argv, ctx);
    },
  });

  async function installCmd(
    argv: string[],
    ctx: PluginCliContext,
  ): Promise<{ exitCode: number; stdout: string }> {
    const json = argv.includes("--json");
    const current = await settings.get();
    const installDir = flag(argv, "--install-dir") ?? current.installDir;
    const version = flag(argv, "--version");
    const force = argv.includes("--force");
    const target = await resolveTarget(bb, ctx, flag(argv, "--machine"));

    if (target.error !== undefined) {
      return { exitCode: 1, stdout: json ? JSON.stringify({ ok: false, error: target.error }) : target.error };
    }

    const input = { installDir, force, ...(version === undefined ? {} : { version }) };
    const result =
      target.hostId === null
        ? await runInstall(input, ctx.signal)
        : await host.call("install", input, { hostId: target.hostId, signal: ctx.signal });

    if (json) return { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result) };

    const lines = result.ok
      ? [
          result.alreadyInstalled
            ? `Already installed: muse-acp ${result.version} at ${result.binaryPath}`
            : `Installed muse-acp ${result.version} to ${result.binaryPath}`,
          `target:   ${result.triple}`,
          `release:  ${result.tag}`,
          ...(result.sha256 === null ? [] : [`sha256:   ${result.sha256}`]),
        ]
      : [`Install failed: ${result.error}`, `url:      ${result.url}`];

    return { exitCode: result.ok ? 0 : 1, stdout: [...lines, ...result.notes.map((n) => `note:     ${n}`)].join("\n") };
  }

  async function statusCmd(
    argv: string[],
    ctx: PluginCliContext,
  ): Promise<{ exitCode: number; stdout: string }> {
    const json = argv.includes("--json");
    const current = await settings.get();
    const target = await resolveTarget(bb, ctx, flag(argv, "--machine"));

    let probe;
    if (target.hostId !== null && target.error === undefined) {
      try {
        probe = await host.call("probe", null, { hostId: target.hostId, signal: ctx.signal });
      } catch (err) {
        probe = {
          ok: false,
          platform: "",
          arch: "",
          binaryPath: null,
          version: null,
          museCliPath: null,
          error: (err as Error).message,
        };
      }
    } else {
      // No host daemon in play: probe the machine the bb server runs on.
      probe = await probeLocal(current.command);
    }

    const status = {
      providerId: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      command: current.command,
      target: target.hostId === null ? target.error ?? "this machine (server)" : target.label,
      platform: [probe.platform, probe.arch].filter(Boolean).join(" ") || "unknown",
      resolvedBinary: probe.binaryPath,
      version: probe.version,
      museCli: probe.museCliPath,
      ready: probe.ok,
      hint: probe.ok
        ? "Ready."
        : probe.error ?? "Not installed. Run `bb muse-code install`.",
    };

    return {
      exitCode: status.ready ? 0 : 1,
      stdout: json
        ? JSON.stringify(status)
        : [
            `providerId:      ${status.providerId}`,
            `displayName:     ${status.displayName}`,
            `command:         ${status.command}`,
            `target:          ${status.target}`,
            `platform:        ${status.platform}`,
            `resolvedBinary:  ${status.resolvedBinary ?? "-"}`,
            `version:         ${status.version ?? "-"}`,
            `muse CLI:        ${status.museCli ?? "- (not installed)"}`,
            `ready:           ${status.ready}`,
            `hint:            ${status.hint}`,
          ].join("\n"),
    };
  }

  function flag(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  }

  async function resolveTarget(
    bb: BbPluginApi,
    ctx: PluginCliContext,
    machine: string | undefined,
  ): Promise<{ hostId: string | null; label: string; error?: string }> {
    if (machine !== undefined) {
      const hosts = await bb.sdk.hosts.list({ signal: ctx.signal });
      const hit = hosts.find((h) => h.id === machine || h.name === machine);
      if (hit === undefined) {
        return { hostId: null, label: "", error: `Machine '${machine}' not found. See \`bb machine list\`.` };
      }
      return { hostId: hit.id, label: hit.name };
    }
    if (ctx.threadId !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
        if (thread.environmentId) {
          const env = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal: ctx.signal });
          return { hostId: env.hostId, label: `environment ${thread.environmentId} on ${env.hostId}` };
        }
      } catch {
        // fall through to server-local
      }
    }
    return { hostId: null, label: "this machine (server)" };
  }
}
