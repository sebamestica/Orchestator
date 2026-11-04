import { spawn as nodeSpawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { UI_DEV_ORIGIN, type DesktopConfig } from './lib/config.ts';
import { probeCore, runningTasks, type FetchLike } from './lib/core-client.ts';
import { childEnv } from './lib/node-path.ts';
import { tailLines, waitForReady } from './lib/ready-line.ts';
import { decodeSession, encodeSession, type Cipher, type CoreSession } from './lib/session-file.ts';
import { decideOnClose, type CoreOwnership, type ShutdownDecision } from './lib/shutdown-policy.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface ConnectedCore {
  origin: string;
  wsUrl: string;
  token: string;
  port: number;
  ownership: CoreOwnership;
  /** PID del núcleo si lo abrió Berland (para apagarlo); `null` si es ajeno. */
  pid: number | null;
}

export type ConnectResult = { ok: true; core: ConnectedCore } | { ok: false; title: string; detail?: string; hint?: string };

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SupervisorDeps {
  config: DesktopConfig;
  env: Env;
  platform: NodeJS.Platform;
  /** `safeStorage` de Electron; `null` si el cifrado no está disponible (entonces no se guarda la sesión). */
  cipher: Cipher | null;
  fetch: FetchLike;
  /** `node.exe` resuelto del PATH (o `ORQ_NODE`). */
  nodePath: string | null;
  log(line: string): void;
  spawn?: SpawnFn;
  killTree?: (pid: number) => Promise<void>;
  now?: () => Date;
}

/** Tope del registro del núcleo lanzado por la app antes de rotarlo. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Mata un proceso y sus hijos (en Windows, `taskkill /T /F`; sin shell). */
export function defaultKillTree(platform: NodeJS.Platform, env: Env): (pid: number) => Promise<void> {
  return (pid) =>
    new Promise<void>((resolve) => {
      if (platform !== 'win32') {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Ya no existía.
        }
        resolve();
        return;
      }
      const exe = win32.join(env.SystemRoot?.trim() || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve());
    });
}

function rotate(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No existe todavía.
  }
}

function readTail(path: string, bytes = 8192): string {
  try {
    const text = readFileSync(path, 'utf8');
    return tailLines(text.slice(-bytes), 15);
  } catch {
    return '';
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Busca, lanza, reutiliza y apaga el núcleo. No importa `electron` (el cifrador y `fetch` llegan inyectados).
 *
 * 1. `GET /health` en 127.0.0.1:<puerto>. Si hay un núcleo vivo, se usa el token de la sesión cifrada
 *    (`session.json`) siempre que el núcleo lo acepte; si no, es un núcleo ajeno y la app lo explica.
 * 2. Si no hay núcleo, lanza `node.exe src/core/app/cli.ts iniciar` (sin shell, oculto y desacoplado para que
 *    sobreviva a la ventana), lee su línea `ready` por stdout y guarda la sesión con token y pid cifrados.
 *    stderr va a `logs/nucleo-escritorio.log` (archivo, no tubería: si la ventana se cierra, el núcleo
 *    sigue escribiendo sin romperse).
 * 3. Al cerrar, `decideOnClose`: se apaga solo si lo abrió Berland y no hay tareas `running`.
 */
export class CoreSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly spawnFn: SpawnFn;
  private readonly killTree: (pid: number) => Promise<void>;
  private core: ConnectedCore | null = null;
  private child: ChildProcess | null = null;
  private connecting: Promise<ConnectResult> | null = null;
  private stopping = false;
  private readonly exitListeners = new Set<(code: number | null) => void>();

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.spawnFn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, [...args], opts));
    this.killTree = deps.killTree ?? defaultKillTree(deps.platform, deps.env);
  }

  get current(): ConnectedCore | null {
    return this.core;
  }

  get logPath(): string {
    return join(this.deps.config.logDir, 'nucleo-escritorio.log');
  }

  /** Avisa si el núcleo que lanzó la app termina solo (no al apagarlo con la ventana). */
  onUnexpectedExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  connect(): Promise<ConnectResult> {
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connected(core: ConnectedCore): ConnectResult {
    this.core = core;
    return { ok: true, core };
  }

  private async doConnect(): Promise<ConnectResult> {
    const { config, fetch, log } = this.deps;
    const { port, coreOrigin: origin } = config;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    if (config.coreToken) {
      const check = await runningTasks(origin, config.coreToken, fetch);
      if (check.status === 'ok') {
        log(`núcleo ajeno en ${origin} con ORQ_CORE_TOKEN: no se apagará al cerrar`);
        return this.connected({ origin, wsUrl, token: config.coreToken, port, ownership: 'external', pid: null });
      }
      return {
        ok: false,
        title: `ORQ_CORE_TOKEN no vale para el núcleo de 127.0.0.1:${port}`,
        hint: check.status === 'unauthorized' ? 'Copia el token de la línea ready del núcleo.' : 'El núcleo no respondió; comprueba que está abierto.',
      };
    }
    let probe = await probeCore(origin, fetch, 2000);
    if (probe === 'timeout') probe = await probeCore(origin, fetch, 6000);
    if (probe === 'foreign') {
      return { ok: false, title: `El puerto ${port} está ocupado por otro programa`, hint: 'Ciérralo o abre Berland con otro ORQ_PORT.' };
    }
    if (probe === 'timeout') {
      return { ok: false, title: `El núcleo de 127.0.0.1:${port} no responde`, hint: 'Puede estar muy ocupado: espera un momento y vuelve a abrir Berland.' };
    }
    return probe === 'alive' ? this.adopt(origin, wsUrl, port) : this.launch(origin, port);
  }

  private async adopt(origin: string, wsUrl: string, port: number): Promise<ConnectResult> {
    const { fetch, log } = this.deps;
    const session = this.readSession();
    if (session && session.port === port) {
      const check = await runningTasks(origin, session.token, fetch);
      if (check.status === 'ok') {
        log(`núcleo vivo de una apertura anterior (pid ${session.pid}, ${check.running} tareas en curso): se reutiliza`);
        return this.connected({ origin, wsUrl, token: session.token, port, ownership: 'adopted', pid: session.pid });
      }
      if (check.status === 'error') {
        return { ok: false, title: `El núcleo de 127.0.0.1:${port} no respondió`, hint: 'Espera un momento y vuelve a abrir Berland.' };
      }
      // El núcleo de la sesión ya no existe y en su puerto hay otro: la sesión quedó vieja.
      this.removeSession();
    }
    log(`núcleo ajeno en ${origin}: Berland no tiene su token`);
    return {
      ok: false,
      title: `Ya hay un núcleo en 127.0.0.1:${port} que no abrió Berland`,
      detail: 'Berland solo guarda el token (cifrado) de los núcleos que lanza ella misma, y ese núcleo se abrió de otra forma (por ejemplo con «iniciar» en una terminal).',
      hint: 'Ciérralo (Ctrl+C en su terminal) y vuelve a abrir Berland para que lance el suyo, o abre la interfaz con el enlace que imprimió ese núcleo.',
    };
  }

  private async launch(origin: string, port: number): Promise<ConnectResult> {
    const { config, log, nodePath } = this.deps;
    const cli = join(config.repoRoot, 'src', 'core', 'app', 'cli.ts');
    if (!existsSync(cli)) {
      return { ok: false, title: 'No encuentro el núcleo', detail: cli, hint: 'Abre Berland desde la carpeta del repo o define ORQ_REPO_ROOT.' };
    }
    if (!nodePath) {
      return { ok: false, title: 'No encuentro node.exe en el PATH', hint: 'Instala Node 24 de Windows o define ORQ_NODE con su ruta.' };
    }
    const logPath = this.logPath;
    let fd: number;
    try {
      mkdirSync(config.logDir, { recursive: true });
      rotate(logPath);
      fd = openSync(logPath, 'a');
      writeSync(fd, `--- ${(this.deps.now ?? (() => new Date()))().toISOString()} Berland lanza el núcleo en el puerto ${port} ---\n`);
    } catch (err) {
      return { ok: false, title: 'No se pudo abrir el registro del núcleo', detail: err instanceof Error ? err.message : String(err) };
    }
    const allowedOrigins = config.uiDev ? [origin, UI_DEV_ORIGIN] : [origin];
    let child: ChildProcess;
    try {
      child = this.spawnFn(nodePath, [cli, 'iniciar'], {
        cwd: config.repoRoot,
        env: childEnv(this.deps.env, { port, allowedOrigins }),
        // stdout por tubería (solo para la línea ready); stderr directo al archivo de registro.
        stdio: ['ignore', 'pipe', fd],
        windowsHide: true,
        detached: true,
        shell: false,
      });
    } catch (err) {
      return { ok: false, title: 'No se pudo lanzar el núcleo', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      closeSync(fd);
    }
    this.child = child;
    child.unref();
    const stdout = child.stdout;
    if (!stdout) return { ok: false, title: 'No se pudo leer la salida del núcleo' };
    log(`núcleo lanzado (pid ${child.pid ?? '?'}): ${nodePath} ${cli} iniciar`);
    try {
      const ready = await waitForReady({ stdout, child }, { timeoutMs: config.readyTimeoutMs, expectedPort: port });
      // Se sigue drenando stdout para que la tubería nunca se llene.
      stdout.on('data', () => undefined);
      child.once('exit', (code) => this.onChildExit(code));
      const pid = child.pid ?? 0;
      this.writeSession({ port, pid, token: ready.token, startedAt: (this.deps.now ?? (() => new Date()))().toISOString() });
      log(`núcleo listo en ${ready.origin} (pid ${pid})`);
      return this.connected({ origin: ready.origin, wsUrl: ready.wsUrl, token: ready.token, port, ownership: 'launched', pid });
    } catch (err) {
      if (child.exitCode === null && child.pid) await this.killTree(child.pid);
      this.child = null;
      const message = err instanceof Error ? err.message : String(err);
      log(`el núcleo no arrancó: ${message}`);
      const tail = readTail(logPath);
      return { ok: false, title: 'El núcleo no arrancó', detail: tail ? `${message}\n\n${tail}` : message, hint: `Registro completo: ${logPath}` };
    }
  }

  private onChildExit(code: number | null): void {
    if (this.stopping) return;
    this.deps.log(`el núcleo terminó solo (código ${code ?? '?'})`);
    if (this.core?.ownership === 'launched') this.core = null;
    this.child = null;
    for (const l of this.exitListeners) l(code);
  }

  /**
   * Cierre de la ventana: aplica `decideOnClose` y, si toca, apaga el núcleo (y sus hijos) por PID.
   * Si el núcleo seguía arrancando, se detiene: todavía no puede tener tareas.
   */
  async onAppClose(): Promise<ShutdownDecision> {
    const { fetch, log } = this.deps;
    if (this.connecting) await Promise.race([this.connecting, delay(3000)]);
    const core = this.core;
    if (!core) {
      const pid = this.child?.exitCode === null ? this.child.pid : undefined;
      if (pid) {
        this.stopping = true;
        await this.killTree(pid);
        log(`núcleo detenido a medio arrancar (pid ${pid})`);
        return { stop: true, reason: 'el núcleo no terminó de arrancar: se detiene' };
      }
      return decideOnClose(null, null);
    }
    const check = core.ownership === 'external' ? null : await runningTasks(core.origin, core.token, fetch, 3000);
    const decision = decideOnClose(core.ownership, check);
    log(`cierre: ${decision.reason}`);
    if (decision.stop && core.pid) {
      this.stopping = true;
      await this.killTree(core.pid);
      this.removeSession();
      this.core = null;
    }
    return decision;
  }

  private readSession(): CoreSession | null {
    const { cipher, config } = this.deps;
    if (!cipher) return null;
    try {
      return decodeSession(readFileSync(config.sessionPath, 'utf8'), cipher);
    } catch {
      return null;
    }
  }

  private writeSession(session: CoreSession): void {
    const { cipher, config, log } = this.deps;
    if (!cipher) {
      log('safeStorage no está disponible: la sesión no se guarda y la próxima apertura no podrá reutilizar este núcleo');
      return;
    }
    try {
      mkdirSync(dirname(config.sessionPath), { recursive: true });
      const tmp = `${config.sessionPath}.${process.pid}.tmp`;
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, encodeSession(session, cipher));
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, config.sessionPath);
    } catch (err) {
      log(`no se pudo guardar la sesión: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeSession(): void {
    try {
      rmSync(this.deps.config.sessionPath, { force: true });
    } catch {
      // Sin permiso o ya borrada: la próxima apertura la descarta al no validar el token.
    }
  }
}
