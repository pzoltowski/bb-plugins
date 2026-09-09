// Locate the muse-acp adapter on a machine's PATH and read its version.
//
// Deliberately no installer: muse-acp publishes signed release tarballs and an
// install.sh, so duplicating that here would be a second, worse install path.
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
  error: string | null;
};

export async function probeLocal(command = "muse-acp"): Promise<Probe> {
  const base: Probe = {
    ok: false,
    platform: platform(),
    arch: arch(),
    binaryPath: null,
    version: null,
    error: null,
  };
  try {
    const { stdout } = await run("which", [command]);
    base.binaryPath = stdout.trim() || null;
  } catch {
    return { ...base, error: `\`${command}\` is not on PATH. Install it with the muse-acp installer.` };
  }
  try {
    const { stdout } = await run(command, ["--version"]);
    // `muse-acp 0.2.5` -> `0.2.5`
    base.version = stdout.trim().split(/\s+/).pop() ?? null;
  } catch (err) {
    return { ...base, error: `Found ${base.binaryPath} but \`--version\` failed: ${(err as Error).message}` };
  }
  return { ...base, ok: true };
}
