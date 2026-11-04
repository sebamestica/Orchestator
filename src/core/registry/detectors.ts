import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { z } from 'zod';
import type { AgentKind, Provider } from '../../shared/index.ts';
import { runJsonl } from '../process/run-jsonl.ts';

/** CLI de agente encontrado en este PC. */
export interface DetectedCli {
  /** Id que tendrá el agente al registrarlo (`codex`, `agy`). */
  id: string;
  kind: Extract<AgentKind, 'codex-cli' | 'agy-cli'>;
  provider: Extract<Provider, 'codex' | 'antigravity'>;
  displayName: string;
  /** Ejecutable real (sin `.cmd`, para lanzarlo sin shell). */
  executable: string;
  /** Argumentos previos fijos (p. ej. la ruta de `codex.js` cuando el ejecutable es `node`). */
  argsPrefix: string[];
  version?: string;
}

export interface CliDetector {
  readonly name: string;
  /** Devuelve el CLI si está instalado y responde a `--version`; `null` si no está. Nunca gasta cupo. */
  detect(): Promise<DetectedCli | null>;
}

export interface VersionOutput {
  exitCode: number | null;
  output: string;
}

export interface DetectorDeps {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Ejecutable de Node para lanzar `codex.js` (por defecto el de este proceso). */
  nodePath?: string;
  exists?: (path: string) => Promise<boolean>;
  /** Ejecuta `<comando> <args> --version` sin shell y devuelve la salida (stdout y stderr). */
  runVersion?: (command: string, args: readonly string[]) => Promise<VersionOutput>;
}

const versionSchema = z.string().regex(/\d+\.\d+\.\d+[0-9A-Za-z.+-]*/);

/** Extrae la versión (x.y.z) de la salida de `--version`. */
export function parseVersion(output: string): string | undefined {
  const match = output.slice(0, 2000).match(/\d+\.\d+\.\d+[0-9A-Za-z.+-]*/);
  const parsed = versionSchema.safeParse(match?.[0]);
  return parsed.success ? parsed.data.slice(0, 64) : undefined;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunVersion(command: string, args: readonly string[]): Promise<VersionOutput> {
  const lines: string[] = [];
  let exitCode: number | null = null;
  for await (const item of runJsonl({ command, args: [...args, '--version'], cwd: homedir(), timeoutMs: 15_000 })) {
    if (item.kind === 'exit') exitCode = item.code;
    else if (lines.length < 20) lines.push(item.line);
  }
  return { exitCode, output: lines.join('\n') };
}

function resolved(deps: DetectorDeps) {
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    home: deps.home ?? homedir(),
    exists: deps.exists ?? defaultExists,
    runVersion: deps.runVersion ?? defaultRunVersion,
    nodePath: deps.nodePath ?? process.execPath,
  };
}

async function probeVersion(
  r: ReturnType<typeof resolved>,
  executable: string,
  argsPrefix: string[],
): Promise<{ ok: boolean; version?: string }> {
  try {
    const out = await r.runVersion(executable, argsPrefix);
    if (out.exitCode !== 0) return { ok: false };
    const version = parseVersion(out.output);
    return version ? { ok: true, version } : { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Codex CLI instalado con npm de Windows: `node %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`. */
export function codexDetector(deps: DetectorDeps = {}): CliDetector {
  return {
    name: 'codex',
    async detect() {
      const r = resolved(deps);
      if (r.platform !== 'win32') return null;
      const appData = r.env.APPDATA?.trim() || win32.join(r.home, 'AppData', 'Roaming');
      const script = win32.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!(await r.exists(script))) return null;
      const v = await probeVersion(r, r.nodePath, [script]);
      if (!v.ok) return null;
      return {
        id: 'codex',
        kind: 'codex-cli',
        provider: 'codex',
        displayName: 'Codex CLI',
        executable: r.nodePath,
        argsPrefix: [script],
        ...(v.version ? { version: v.version } : {}),
      };
    },
  };
}

/** Antigravity CLI: `%LOCALAPPDATA%\agy\bin\agy.exe`. */
export function agyDetector(deps: DetectorDeps = {}): CliDetector {
  return {
    name: 'agy',
    async detect() {
      const r = resolved(deps);
      if (r.platform !== 'win32') return null;
      const local = r.env.LOCALAPPDATA?.trim() || win32.join(r.home, 'AppData', 'Local');
      const exe = win32.join(local, 'agy', 'bin', 'agy.exe');
      if (!(await r.exists(exe))) return null;
      const v = await probeVersion(r, exe, []);
      if (!v.ok) return null;
      return {
        id: 'agy',
        kind: 'agy-cli',
        provider: 'antigravity',
        displayName: 'Antigravity (agy)',
        executable: exe,
        argsPrefix: [],
        ...(v.version ? { version: v.version } : {}),
      };
    },
  };
}

export function defaultCliDetectors(deps: DetectorDeps = {}): CliDetector[] {
  return [codexDetector(deps), agyDetector(deps)];
}
