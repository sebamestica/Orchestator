import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  agentConfigSchema,
  idSchema,
  probeResultSchema,
  redactSecrets,
  type AgentAdapter,
  type AgentConfig,
  type ProbeResult,
  type QuotaProvider,
} from '../../shared/index.ts';
import { redactDeep, StoreError, type AgentRecord, type SqliteStore } from '../store/index.ts';
import type { SecretVault } from '../vault/index.ts';
import type { CliDetector, DetectedCli } from './detectors.ts';

/** Secretos que el registro entrega, solo en memoria, a la fábrica de adaptadores. */
export interface AgentSecrets {
  apiKey?: string;
}

/** Crea el adaptador de un agente (los implementan otros módulos: claude-sdk, codex-cli, agy-cli, api). */
export type AdapterFactory = (config: AgentConfig, secrets: AgentSecrets) => AgentAdapter | Promise<AgentAdapter>;

/** Crea el lector de cupo de un agente según su método; `undefined` si no tiene. */
export type QuotaProviderFactory = (
  agent: AgentRecord,
  secrets: AgentSecrets,
) => QuotaProvider | undefined | Promise<QuotaProvider | undefined>;

/** Parte del almacén que usa el registro. */
export type AgentStore = Pick<SqliteStore, 'putAgent' | 'createAgent' | 'getAgent' | 'listAgents' | 'deleteAgent'>;

export type RegistryErrorCode = 'invalid' | 'not_found' | 'conflict' | 'probe_failed' | 'not_configured';
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
  readonly code: RegistryErrorCode;
  /** Datos ya tachados que se pueden mostrar (p. ej. advertencias del probe). */
  readonly details?: { warnings?: string[] };
  constructor(code: RegistryErrorCode, message: string, details?: { warnings?: string[] }) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const keyProviderSchema = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'openai-compatible']);
const httpUrl = z.url({ protocol: /^https?$/ });

/** Alta de un agente por API (o Claude con tu clave): la clave va a la bóveda, nunca a SQLite. */
export const addAgentFromKeySchema = z
  .strictObject({
    provider: keyProviderSchema,
    apiKey: z.string().trim().min(8).max(4096),
    displayName: z.string().trim().min(1).max(80),
    baseUrl: httpUrl.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    id: idSchema.optional(),
    /** Solo `anthropic`: `claude-sdk` (agente con herramientas, por defecto) o `api` (chat). */
    kind: z.enum(['claude-sdk', 'api']).optional(),
    budgetUsd: z.number().positive().optional(),
    quotaFloor: z.number().min(0).max(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'openai-compatible' && !v.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Requerida para openai-compatible' });
    if (v.kind === 'claude-sdk' && v.provider !== 'anthropic') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'claude-sdk solo con provider anthropic' });
  });
export type AddAgentFromKeyInput = z.input<typeof addAgentFromKeySchema>;

/** Alta manual sin clave (CLIs detectados o configurados a mano). */
export const agentInputSchema = agentConfigSchema.omit({ secretRef: true });
export type AgentInput = z.input<typeof agentInputSchema>;

/** Cambios permitidos sobre un agente existente (`null` borra el campo opcional). */
export const agentPatchSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    baseUrl: httpUrl.nullable().optional(),
    quotaFloor: z.number().min(0).max(1).optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Sin cambios' });
export type AgentPatch = z.input<typeof agentPatchSchema>;

export interface RegistryOptions {
  store: AgentStore;
  vault: SecretVault;
  /** Si falta, `probe` y `addAgentFromKey` responden `not_configured`. */
  adapterFactory?: AdapterFactory;
  detectors?: readonly CliDetector[];
  probeTimeoutMs?: number;
}

export interface AddAgentResult {
  agent: AgentRecord;
  probe: ProbeResult;
}

export interface DetectResult {
  detected: DetectedCli[];
  /** Agentes nuevos registrados (los ya existentes no se tocan). */
  added: AgentRecord[];
}

function invalid(error: z.ZodError): RegistryError {
  const fields = error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
  return new RegistryError('invalid', redactSecrets(`Datos inválidos: ${fields}`).slice(0, 500));
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(r.error);
  return r.data;
}

function safeMessage(err: unknown, secrets: readonly string[]): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg, secrets).slice(0, 300);
}

/** Id legible a partir del nombre: sin tildes, minúsculas, guiones. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * Registro de agentes: CRUD de `AgentConfig` sobre el almacén, altas por clave (bóveda + probe)
 * y detección de CLIs instalados. Los adaptadores llegan por una fábrica inyectada.
 */
export class AgentRegistry {
  private readonly opts: RegistryOptions;
  /** Ids reservados por altas en curso (entre la comprobación y el guardado hay `await`). */
  private readonly reserved = new Set<string>();

  constructor(opts: RegistryOptions) {
    this.opts = opts;
  }

  list(): AgentRecord[] {
    return this.opts.store.listAgents();
  }

  get(id: string): AgentRecord | undefined {
    return this.opts.store.getAgent(id);
  }

  require(id: string): AgentRecord {
    const agent = this.get(id);
    if (!agent) throw new RegistryError('not_found', `No existe el agente ${id}`);
    return agent;
  }

  /** Alta o reemplazo de un agente sin clave (p. ej. un CLI). Los agentes con clave usan `addAgentFromKey`. */
  put(input: unknown): AgentRecord {
    const config = parse(agentInputSchema, input);
    if (config.kind === 'claude-sdk' || config.kind === 'api') {
      throw new RegistryError('invalid', `Los agentes ${config.kind} se agregan con su clave (apiKey)`);
    }
    const existing = this.get(config.id);
    if (existing?.config.secretRef) throw new RegistryError('conflict', `El agente ${config.id} ya existe con una clave guardada`);
    return this.opts.store.putAgent({ config });
  }

  update(id: string, patchInput: unknown): AgentRecord {
    const patch = parse(agentPatchSchema, patchInput);
    const current = this.require(id).config;
    const next: Record<string, unknown> = { ...current };
    const cleared = new Set<string>();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) cleared.add(key);
      else if (value !== undefined) next[key] = value;
    }
    const merged = Object.fromEntries(Object.entries(next).filter(([k]) => !cleared.has(k)));
    return this.opts.store.putAgent({ config: parse(agentConfigSchema, merged) });
  }

  /** Borra el agente y su clave de la bóveda (si ningún otro agente la usa). */
  async delete(id: string): Promise<boolean> {
    const agent = this.get(id);
    if (!agent) return false;
    this.opts.store.deleteAgent(id);
    const ref = agent.config.secretRef;
    if (ref && !this.list().some((a) => a.config.secretRef === ref)) await this.opts.vault.delete(ref);
    return true;
  }

  /**
   * Prueba el agente con la clave solo en memoria (fábrica inyectada); si autentica, lo guarda con su
   * método de cupo (inserción exclusiva) y después guarda la clave en la bóveda. Si el probe falla no se
   * escribe nada; si falla la bóveda, se revierte el agente.
   */
  async addAgentFromKey(input: unknown): Promise<AddAgentResult> {
    const v = parse(addAgentFromKeySchema, input);
    const factory = this.requireFactory();
    const id = v.id ?? this.uniqueId(v.displayName, v.provider);
    if (this.get(id) || this.reserved.has(id)) throw new RegistryError('conflict', `Ya existe el agente ${id}`);
    const config = parse(agentConfigSchema, {
      id,
      kind: v.provider === 'anthropic' ? (v.kind ?? 'claude-sdk') : 'api',
      provider: v.provider,
      displayName: v.displayName,
      ...(v.model ? { model: v.model } : {}),
      ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
      secretRef: `${id.slice(0, 48)}-key-${randomBytes(3).toString('hex')}`,
      ...(v.quotaFloor !== undefined ? { quotaFloor: v.quotaFloor } : {}),
      ...(v.budgetUsd !== undefined ? { budgetUsd: v.budgetUsd } : {}),
    });
    const secretRef = config.secretRef ?? '';
    this.reserved.add(id);
    try {
      // 1) Probe con la clave solo en memoria: si el proceso muere aquí, no queda nada guardado.
      const probe = await this.runProbe(factory, config, { apiKey: v.apiKey });
      if (!probe.installed || !probe.authenticated) {
        throw new RegistryError('probe_failed', probe.installed ? 'El proveedor rechazó la clave' : 'El agente no está disponible', {
          warnings: probe.warnings,
        });
      }
      // 2) Inserción exclusiva: si otra instancia creó el mismo id mientras se probaba, no se reemplaza.
      let agent: AgentRecord;
      try {
        agent = this.opts.store.createAgent({ config, quotaMethod: probe.quotaMethod, lastProbe: probe });
      } catch (err) {
        if (err instanceof StoreError && err.code === 'conflict') throw new RegistryError('conflict', `Ya existe el agente ${id}`);
        throw err;
      }
      // 3) La clave va a la bóveda solo después de un probe correcto; si falla, se revierte el agente.
      try {
        await this.opts.vault.set(secretRef, v.apiKey, { label: `${config.displayName} (${config.provider})` });
      } catch (err) {
        this.opts.store.deleteAgent(id);
        await this.opts.vault.delete(secretRef).catch(() => undefined);
        throw err;
      }
      return { agent, probe };
    } finally {
      this.reserved.delete(id);
    }
  }

  /** Prueba un agente registrado y guarda el resultado y su método de cupo. */
  async probe(id: string): Promise<AddAgentResult> {
    const agent = this.require(id);
    const factory = this.requireFactory();
    const secrets = await this.secretsFor(agent.config);
    const probe = await this.runProbe(factory, agent.config, secrets);
    const saved = this.opts.store.putAgent({ config: agent.config, quotaMethod: probe.quotaMethod, lastProbe: probe });
    return { agent: saved, probe };
  }

  /** Adaptador listo para ejecutar tareas (lo usa la orquestación). */
  async createAdapter(id: string): Promise<AgentAdapter> {
    const agent = this.require(id);
    return this.requireFactory()(agent.config, await this.secretsFor(agent.config));
  }

  /** Clave del agente, solo en memoria (para la fábrica de adaptadores o de cupos). */
  async secretsFor(config: AgentConfig): Promise<AgentSecrets> {
    if (!config.secretRef) return {};
    const apiKey = await this.opts.vault.get(config.secretRef);
    if (apiKey === undefined) throw new RegistryError('not_found', `Falta la clave del agente ${config.id} en la bóveda`);
    return { apiKey };
  }

  /** Detecta CLIs instalados (codex, agy) y registra los que aún no existen. */
  async detectClis(): Promise<DetectResult> {
    const detected: DetectedCli[] = [];
    const added: AgentRecord[] = [];
    for (const detector of this.opts.detectors ?? []) {
      let found: DetectedCli | null = null;
      try {
        found = await detector.detect();
      } catch {
        found = null;
      }
      if (!found) continue;
      detected.push(found);
      if (this.get(found.id)) continue;
      added.push(this.opts.store.putAgent({ config: parse(agentConfigSchema, { id: found.id, kind: found.kind, provider: found.provider, displayName: found.displayName }) }));
    }
    return { detected, added };
  }

  private requireFactory(): AdapterFactory {
    if (!this.opts.adapterFactory) throw new RegistryError('not_configured', 'No hay fábrica de adaptadores configurada');
    return this.opts.adapterFactory;
  }

  private async runProbe(factory: AdapterFactory, config: AgentConfig, secrets: AgentSecrets): Promise<ProbeResult> {
    const extra = secrets.apiKey ? [secrets.apiKey] : [];
    const timeoutMs = this.opts.probeTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    let raw: unknown;
    try {
      const adapter: AgentAdapter = await factory(config, secrets);
      raw = await Promise.race([
        adapter.probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sin respuesta en ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      throw new RegistryError('probe_failed', `Falló la prueba del agente ${config.id}: ${safeMessage(err, extra)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const parsed = probeResultSchema.safeParse(raw);
    if (!parsed.success) throw new RegistryError('probe_failed', `El adaptador de ${config.id} devolvió un probe inválido`);
    return redactDeep({ ...parsed.data, agentId: config.id }, extra);
  }

  private uniqueId(displayName: string, provider: string): string {
    let base = slugify(displayName);
    if (!idSchema.safeParse(base).success) base = slugify(provider);
    let id = base;
    for (let n = 2; this.get(id) || this.reserved.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}
