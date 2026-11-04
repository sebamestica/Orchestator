import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insecureUrlWarning } from '../adapters/claude-sdk/index.ts';
import { startCore } from '../main.ts';
import { RegistryError } from '../registry/index.ts';
import type { AgentRecord } from '../store/index.ts';
import { assertNoSecretArgs, CliError, parseFlags, parseUsd, readApiKey, type CliIo } from './cli-io.ts';
import type { Composition } from './compose.ts';
import { HOST_CREDENTIAL_VARS } from './env.ts';
import { runSmokeTask, SMOKE_PROMPT } from './smoke.ts';

export const DEFAULT_CLAUDE_ID = 'claude';

/** `agregar-claude`: prueba la clave, la guarda en la bóveda DPAPI y registra el agente con su URL. */
export async function agregarClaude(argv: readonly string[], io: CliIo, comp: Composition): Promise<number> {
  assertNoSecretArgs(argv);
  const f = parseFlags(argv, {
    url: { type: 'string' },
    presupuesto: { type: 'string' },
    id: { type: 'string' },
    nombre: { type: 'string' },
    modelo: { type: 'string' },
    stdin: { type: 'boolean' },
    reemplazar: { type: 'boolean' },
  });
  const budgetUsd = parseUsd(f.presupuesto, '--presupuesto');
  const { key, source } = await readApiKey(io, f.stdin === true);
  const baseUrl = f.url ?? (io.env.ANTHROPIC_BASE_URL?.trim() || undefined);
  const id = f.id ?? DEFAULT_CLAUDE_ID;
  const insecure = insecureUrlWarning(baseUrl);
  if (insecure) io.err(`Aviso: ${insecure}`);

  if (comp.registry.get(id)) {
    if (!f.reemplazar) throw new CliError(`Ya existe el agente ${id}: usa --reemplazar para cambiar su clave o su URL, o --id para otro agente.`);
    await comp.registry.delete(id);
    io.out(`Agente ${id} anterior borrado (y su clave, de la bóveda).`);
  }
  io.out(`Probando la clave (tomada de ${source === 'stdin' ? 'stdin' : 'ANTHROPIC_API_KEY'}) contra ${baseUrl ?? 'https://api.anthropic.com'}…`);
  let res;
  try {
    res = await comp.registry.addAgentFromKey({
      provider: 'anthropic',
      kind: 'claude-sdk',
      apiKey: key,
      id,
      displayName: f.nombre ?? 'Claude (mi clave)',
      ...(baseUrl ? { baseUrl } : {}),
      ...(f.modelo ? { model: f.modelo } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });
  } catch (err) {
    if (err instanceof RegistryError) for (const w of err.details?.warnings ?? []) io.err(`Aviso: ${w}`);
    throw err;
  }
  const { agent, probe } = res;
  io.out(`Agente ${id} registrado: la clave quedó solo en la bóveda DPAPI (${comp.config.vaultPath}, referencia ${agent.config.secretRef ?? '-'}).`);
  io.out(`URL: ${agent.config.baseUrl ?? 'https://api.anthropic.com (por defecto)'} · modelo: ${agent.config.model ?? 'por defecto del adaptador'} · presupuesto: ${agent.config.budgetUsd ?? 'sin tope'} USD`);
  io.out(`Prueba: autenticado=${probe.authenticated} · ${probe.models.length} modelos · cupo: ${probe.quotaMethod}${probe.version ? ` · SDK ${probe.version}` : ''}`);
  for (const w of probe.warnings) if (w !== insecure) io.err(`Aviso: ${w}`);
  return 0;
}

function describeAgent(a: AgentRecord, spent: number): string {
  const c = a.config;
  return [
    c.id,
    `${c.kind}/${c.provider}`,
    `«${c.displayName}»`,
    `url=${c.baseUrl ?? '-'}`,
    `clave=${c.secretRef ? 'en la bóveda' : 'no usa'}`,
    `presupuesto=${c.budgetUsd ?? '-'}`,
    `gastado=${spent.toFixed(4)} USD`,
    `cupo=${a.quotaMethod ?? '-'}`,
    ...(c.enabled ? [] : ['(deshabilitado)']),
  ].join('  ');
}

/** `agentes`: configuración sin claves y gasto registrado en SQLite. */
export async function agentes(argv: readonly string[], io: CliIo, comp: Composition): Promise<number> {
  parseFlags(argv, {});
  const list = comp.registry.list();
  if (list.length === 0) io.out('No hay agentes registrados. Agrega Claude con: node src/core/app/cli.ts agregar-claude');
  for (const a of list) io.out(describeAgent(a, comp.spentUsd(a.config.id)));
  return 0;
}

/** Enlace de la interfaz web con el token en el fragmento (`#t=`): el navegador nunca lo envía al servidor. */
export function webUrl(coreUrl: string, token: string): string {
  return `${coreUrl}/#t=${token}`;
}

/**
 * Abre una URL en el navegador predeterminado de Windows: `rundll32 url.dll,FileProtocolHandler <url>` por `spawn` sin
 * shell (la URL va como un solo argumento, sin pasar por cmd). Sin `windowsHide`: rundll32 no tiene ventana y, con
 * ella, pasaría `SW_HIDE` al navegador. Solo URLs del núcleo en loopback; fuera de Windows no hace nada.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, spawnFn: typeof spawn = spawn): boolean {
  if (platform !== 'win32' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9#=_.~/-]*$/.test(url)) return false;
  const child = spawnFn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  child.once('error', () => undefined);
  child.unref();
  return true;
}

export interface IniciarOptions {
  /** Abre el enlace web (por defecto `openInBrowser`). */
  open?: (url: string) => boolean;
}

/**
 * `iniciar [--abrir]`: núcleo en 127.0.0.1 con la composición completa; imprime la línea JSON (URL y token), el
 * enlace de la interfaz web y, con `--abrir`, lo abre en el navegador. Espera Ctrl+C.
 */
export async function iniciar(argv: readonly string[], io: CliIo, comp: Composition, opts: IniciarOptions = {}): Promise<number> {
  const f = parseFlags(argv, { abrir: { type: 'boolean' } });
  const core = await startCore(comp.deps);
  // Los eventos de la flota también se difunden por /ws.
  comp.fleet.attachSink(core.hub);
  io.out(JSON.stringify({ ready: true, url: core.url, wsUrl: core.server.wsUrl, token: core.token }));
  const web = webUrl(core.url, core.token);
  io.out(`web: ${web}`);
  io.out(`Núcleo en ${core.url} (token arriba; Ctrl+C para detener). Agentes: ${core.registry.list().length}.`);
  if (f.abrir === true) {
    const opened = (opts.open ?? ((url) => openInBrowser(url)))(web);
    if (!opened) io.err('Aviso: no se pudo abrir el navegador; abre el enlace «web:» a mano.');
  }
  try {
    await io.waitForStop();
  } finally {
    await core.stop();
  }
  return 0;
}

export function pickClaude(comp: Composition, agentId?: string): AgentRecord {
  if (agentId) return comp.registry.require(agentId);
  const agent = comp.registry.list().find((a) => a.config.kind === 'claude-sdk' && a.config.enabled);
  if (!agent) throw new CliError('No hay un agente Claude registrado: usa «node src/core/app/cli.ts agregar-claude».');
  return agent;
}

/** Borra una carpeta temporal: en Windows el CLI de Claude la retiene unos segundos tras cerrar. */
export async function removeDir(dir: string, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/** `probar-claude`: «Responde exactamente: OK» con el agente registrado y la clave de la bóveda. */
export async function probarClaude(argv: readonly string[], io: CliIo, comp: Composition): Promise<number> {
  const f = parseFlags(argv, { agente: { type: 'string' } });
  const agent = pickClaude(comp, f.agente);
  const id = agent.config.id;
  const inherited = HOST_CREDENTIAL_VARS.filter((k) => io.env[k] !== undefined);
  io.out(`Credenciales en el entorno de este proceso: ${inherited.length ? `${inherited.join(', ')} (se ignoran)` : 'ninguna'}; la clave sale de la bóveda.`);
  const adapter = await comp.registry.createAdapter(id);
  await comp.env.load(id);
  const dir = await mkdtemp(join(tmpdir(), 'orq-probar-claude-'));
  try {
    io.out(`Ejecutando «${SMOKE_PROMPT}» con ${id} (${agent.config.baseUrl ?? 'https://api.anthropic.com'}) en ${dir}…`);
    const r = await runSmokeTask({ adapter, envFor: comp.envFor, sink: comp.store, worktreePath: dir });
    const a = r.attempt;
    io.out(`Respuesta: ${r.text || '(sin texto)'}`);
    io.out(`Tokens: entrada ${a?.usage.inputTokens ?? 0} · salida ${a?.usage.outputTokens ?? 0} · costo ${(a?.usage.costUsd ?? 0).toFixed(4)} USD`);
    io.out(`Sesión: ${a?.sessionId ?? '-'} · resultado: ${r.run.outcome}${a?.error ? ` (${a.error.code}: ${a.error.message})` : ''}`);
    io.out(`Gasto registrado de ${id} en SQLite: ${comp.spentUsd(id).toFixed(4)} USD`);
    return r.run.ok && /\bOK\b/.test(r.text) ? 0 : 1;
  } finally {
    if (!(await removeDir(dir))) io.err(`Aviso: no se pudo borrar la carpeta temporal ${dir}`);
  }
}
