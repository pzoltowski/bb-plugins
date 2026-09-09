// Report what a machine has: the adapter, and the Muse Code CLI it talks to.
//
// Both matter for onboarding. The adapter is what this plugin installs; the
// `muse` CLI is where Muse Code authentication lives, and no adapter can
// substitute for being signed in there.
import { execFile } from "node:child_process";
import { arch, platform } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Probe = {
  ok: boolean;
  platform: string;
  arch: string;
  binaryPath: string | null;
  version: string | null;
  museCliPath: string | null;
  error: string | null;
};

async function which(command: string): Promise<string | null> {
  const finder = platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await run(finder, [command]);
    return stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function probeLocal(command = "muse-acp"): Promise<Probe> {
  const base: Probe = {
    ok: false,
    platform: platform(),
    arch: arch(),
    binaryPath: null,
    version: null,
    museCliPath: await which("muse"),
    error: null,
  };

  base.binaryPath = command.includes("/") || command.includes("\\") ? command : await which(command);
  if (base.binaryPath === null) {
    return { ...base, error: `\`${command}\` is not installed. Run \`bb muse-acp install\`.` };
  }

  try {
    const { stdout } = await run(base.binaryPath, ["--version"]);
    // `muse-acp 0.2.5` -> `0.2.5`
    base.version = stdout.trim().split(/\s+/).pop() ?? null;
  } catch (err) {
    return { ...base, error: `Found ${base.binaryPath} but \`--version\` failed: ${(err as Error).message}` };
  }

  if (base.museCliPath === null) {
    return {
      ...base,
      error: "The adapter is installed, but the `muse` CLI is not. Install Muse Code and sign in: curl -fsSL https://api.meta.ai/muse-launcher.sh | sh",
    };
  }

  return { ...base, ok: true };
}
