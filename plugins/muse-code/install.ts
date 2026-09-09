// Install the muse-acp adapter on a machine, mirroring the conventions of the
// project's own install.sh so both paths land in the same place:
//
//   target      {x86_64|aarch64}-{apple-darwin|unknown-linux-gnu}
//   package     muse-acp-<tag>-<target>
//   archive     <package>.tar.gz, verified against <archive>.sha256
//   installDir  ~/.local/bin
//
// The release assets are the ones the upstream project publishes; this plugin
// downloads and verifies them, it does not build or vendor anything.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const REPO = "BrokkAi/muse-acp";
/** Used only when GitHub cannot be reached to resolve `releases/latest`. */
export const FALLBACK_TAG = "v0.2.5";
const MANIFEST = ".muse-acp-install.json";

export interface Target {
  triple: string;
  archive: "tar.gz" | "zip";
  exe: string;
}

export interface InstallOptions {
  installDir: string;
  version?: string;
  force: boolean;
}

export interface InstallResult {
  ok: boolean;
  tag: string;
  triple: string;
  url: string;
  installDir: string;
  binaryPath: string | null;
  version: string | null;
  sha256: string | null;
  alreadyInstalled: boolean;
  error: string | null;
  notes: string[];
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function detectTarget(): Target {
  const platform = os.platform();
  const arch = os.arch();
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (cpu === null) throw new Error(`Unsupported architecture: ${arch}`);
  if (platform === "darwin") return { triple: `${cpu}-apple-darwin`, archive: "tar.gz", exe: "muse-acp" };
  if (platform === "linux") return { triple: `${cpu}-unknown-linux-gnu`, archive: "tar.gz", exe: "muse-acp" };
  if (platform === "win32") {
    if (cpu !== "x86_64") throw new Error("Windows releases are published for x86_64 only");
    return { triple: "x86_64-pc-windows-msvc", archive: "zip", exe: "muse-acp.exe" };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Follow `releases/latest` the way install.sh does — no API token, no rate limit. */
export async function resolveLatestTag(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "follow", signal });
  const tag = response.url.replace(/\/$/, "").split("/").pop() ?? "";
  if (!/^v[0-9][A-Za-z0-9._+-]*$/.test(tag)) {
    throw new Error(`Could not read a release tag from ${response.url}`);
  }
  return tag;
}

export function normalizeTag(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  if (!/^v[0-9][A-Za-z0-9._+-]*$/.test(tag)) throw new Error(`Invalid release version: ${version}`);
  return tag;
}

async function download(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function runInstall(options: InstallOptions, signal?: AbortSignal): Promise<InstallResult> {
  const notes: string[] = [];
  const installDir = expandHome(options.installDir);
  const base: InstallResult = {
    ok: false,
    tag: "",
    triple: "",
    url: "",
    installDir,
    binaryPath: null,
    version: null,
    sha256: null,
    alreadyInstalled: false,
    error: null,
    notes,
  };

  let target: Target;
  try {
    target = detectTarget();
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  base.triple = target.triple;

  let tag: string;
  try {
    tag = options.version === undefined ? await resolveLatestTag(signal) : normalizeTag(options.version);
  } catch (err) {
    tag = FALLBACK_TAG;
    notes.push(`Could not resolve the latest release (${(err as Error).message}); falling back to ${FALLBACK_TAG}.`);
  }
  base.tag = tag;

  const binaryPath = path.join(installDir, target.exe);

  // Already at the requested version? Leave it alone unless forced.
  if (!options.force) {
    const existing = await readVersion(binaryPath);
    if (existing !== null && `v${existing}` === tag) {
      return { ...base, ok: true, binaryPath, version: existing, alreadyInstalled: true };
    }
  }

  const pkg = `muse-acp-${tag}-${target.triple}`;
  const archive = `${pkg}.${target.archive}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${archive}`;
  base.url = url;

  const tmp = await mkdtemp(path.join(os.tmpdir(), "muse-acp-"));
  try {
    const archivePath = path.join(tmp, archive);
    await download(url, archivePath, signal);

    // The project publishes a .sha256 beside every asset; refuse anything else.
    const expected = (await (await fetch(`${url}.sha256`, { redirect: "follow", signal })).text())
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase();
    const actual = await sha256(archivePath);
    if (expected === undefined || expected.length !== 64) {
      return { ...base, error: `Could not read ${archive}.sha256 from the release` };
    }
    if (actual !== expected) {
      return { ...base, error: `Checksum mismatch for ${archive}: expected ${expected}, got ${actual}` };
    }
    base.sha256 = actual;

    // bsdtar reads both .tar.gz and .zip, and ships with macOS, Linux, and
    // Windows 10+.
    await run("tar", ["-xf", archivePath, "-C", tmp], { signal });

    const extracted = path.join(tmp, pkg, target.exe);
    await mkdir(installDir, { recursive: true });
    await copyFile(extracted, binaryPath);
    if (os.platform() !== "win32") await chmod(binaryPath, 0o755);

    const version = await readVersion(binaryPath);
    if (version === null) {
      return { ...base, binaryPath, error: `Installed ${binaryPath} but it did not answer --version` };
    }

    await writeFile(
      path.join(installDir, MANIFEST),
      `${JSON.stringify({ tag, triple: target.triple, url, sha256: actual, version }, null, 2)}\n`,
    );

    if (!isOnPath(installDir)) {
      notes.push(`${installDir} is not on PATH. Add it, or point the plugin's "muse-acp command" setting at ${binaryPath}.`);
    }

    return { ...base, ok: true, binaryPath, version };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await run(binary, ["--version"]);
    return stdout.trim().split(/\s+/).pop() ?? null;
  } catch {
    return null;
  }
}

function isOnPath(dir: string): boolean {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(expandHome);
  return entries.some((entry) => path.resolve(entry) === path.resolve(dir));
}
