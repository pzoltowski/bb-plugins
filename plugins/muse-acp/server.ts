// bb-plugin-muse-acp — Muse Code as a first-class bb agent provider, through
// the muse-acp adapter (https://github.com/BrokkAi/muse-acp).
//
// Configuring Muse as a `customAgents` entry instead gets you bb's generic
// `Toolbox` glyph and a set of guessed capabilities: five reasoning levels
// that include `max` (Muse has no such level) and omit `none`/`ultra` (it has
// both), plus service tiers Muse does not implement. Registering the provider
// here replaces all of that with what the adapter actually advertises, and
// adds `bb muse-acp install` so nobody has to go find the binary first.
//
// Capability facts read from muse-acp v0.2.5, src/main.rs (V1_INIT/V2_INIT)
// and src/acp.rs (config_options):
//   authMethods:  []                 — Muse signs in out of band, via `muse`
//   loadSession:  true               — list/resume/close; no session/fork
//   prompt:       text, image, embeddedContext
//   session mode: ask | auto | deny
//   reasoning:    none | minimal | low | medium | high | xhigh | ultra
import { type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { museHostContract } from "./contract.js";
import { runInstall } from "./install.js";
import { probeLocal } from "./probe.js";

const PROVIDER_ID = "acp-muse-code";
const DISPLAY_NAME = "Muse Code";

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
        "Where `bb muse-acp install` puts the adapter. `~` expands on the target machine. Matches the upstream installer's default.",
      default: "~/.local/bin",
    },
  });

  const host = bb.hosts.experimental_client({ contract: museHostContract });

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    family: "acp",
    icon: "./icons/muse-code.svg",
    strings: {
      // muse-acp advertises `authMethods: []` — there is no in-band ACP login
      // to prompt for. Muse Code authenticates through its own CLI.
      signInHint: "Run `muse` on that machine and sign in, then reload the provider.",
      expiredHint: "Your Muse Code session expired. Run `muse` on that machine to sign in again, then reload.",
      installUrl: "https://github.com/BrokkAi/muse-acp#installation",
      iconTint: { light: "#0064E0", dark: "#0082FB" },
    },
    // Listed even where the adapter is missing, so the provider is
    // discoverable and `bb muse-acp install` is reachable from its entry.
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
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // sessionCapabilities advertises list/resume/close, no fork.
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      // Muse's seven efforts minus `minimal`, which bb's vocabulary lacks.
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "ultra"],
    },
    // "goal" | "plan" composer buttons; Muse's own skills already arrive as
    // ACP available commands, so nothing extra is needed here.
    composerActions: [],
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: DISPLAY_NAME,
        command: (await settings.get()).command,
        args: [],
        env: {} as Record<string, string>,
      },
    },
  });

  bb.cli.register({
    name: "muse-acp",
    summary: "Install and inspect the Muse Code ACP provider",
    commands: [
      {
        name: "status",
        summary: "Show where the adapter and the Muse Code CLI resolve on a machine",
        usage: "bb muse-acp status [--machine <id-or-name>] [--json]",
      },
      {
        name: "install",
        summary:
          "Install the adapter on a machine: downloads the upstream release for its platform, verifies the published SHA-256, and puts it in the install directory",
        usage:
          "bb muse-acp install [--machine <id-or-name>] [--version <x.y.z>] [--install-dir <path>] [--force] [--json]",
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
        : probe.error ?? "Not installed. Run `bb muse-acp install`.",
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
