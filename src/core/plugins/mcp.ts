/**
 * Forma neutra de los servidores MCP que el núcleo entrega a los agentes (plugins de F5). Cada adaptador la
 * traduce a lo suyo: Claude SDK → `mcpServers` de `query` (con `${VAR}` para los secretos), Codex CLI → `-c
 * mcp_servers.<nombre>.…` y variables de entorno del hijo. agy todavía no recibe servidores por sesión.
 *
 * Los secretos (p. ej. `Authorization: Bearer …`) viajan aquí solo en memoria. Los adaptadores los pasan por el
 * entorno del proceso del agente, nunca por argumentos, y los tachan de sus eventos (`mcpSecrets`).
 */
import type { AgentKind } from '../../shared/index.ts';

export interface McpStdioSpec {
  type: 'stdio';
  command: string;
  args: string[];
  /** Variables para el proceso del servidor (pueden ser secretas: van por entorno, no por argumentos). */
  env?: Readonly<Record<string, string>>;
  /** Nota para el agente (se agrega al encargo). */
  instructions?: string;
  /** Tope de una llamada a herramienta, en segundos (Codex: `tool_timeout_sec`). Sin él, el de cada cliente. */
  toolTimeoutSec?: number;
}

export interface McpHttpSpec {
  type: 'http';
  url: string;
  /** Encabezados HTTP (p. ej. `Authorization: Bearer …`). Se tratan siempre como secretos. */
  headers: Readonly<Record<string, string>>;
  instructions?: string;
  toolTimeoutSec?: number;
}

export type McpServerSpec = McpStdioSpec | McpHttpSpec;
export type McpServerMap = Readonly<Record<string, McpServerSpec>>;

/** Lo que recibe un adaptador para una ejecución: los servidores, notas para el encargo y cómo soltarlos. */
export interface McpGrant {
  servers: McpServerMap;
  /** Avisos para el agente (p. ej. «esta sesión no tiene navegador: no abras ninguno»). */
  notes: string[];
  /** Suelta los recursos de la ejecución (p. ej. un candado de Chrome que su puerta no alcanzó a soltar). Idempotente; nunca lanza. */
  release(): Promise<void>;
}

export interface McpGrantRequest {
  agentId: string;
  kind: AgentKind;
  /** Tarea (o sesión de la mente) que usará los servidores: dueño de los candados. */
  taskId: string;
  signal?: AbortSignal;
}

/** Fuente de servidores MCP por ejecución (la implementa `PluginService.grant`). */
export type McpServerSource = (req: McpGrantRequest) => Promise<McpGrant>;

export const EMPTY_GRANT: McpGrant = Object.freeze({ servers: Object.freeze({}), notes: [], release: async () => undefined });

/**
 * Nombre de servidor: minúsculas, dígitos y guiones, sin `_` ni `.`. Así `mcp__<nombre>__<herramienta>` no es
 * ambiguo para la política de Claude y la clave con puntos de Codex (`mcp_servers.<nombre>.url`) es una clave TOML
 * desnuda válida.
 */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertServerName(name: string): string {
  if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`Nombre de servidor MCP inválido: ${JSON.stringify(name).slice(0, 60)}`);
  return name;
}

/** Variable de entorno para un secreto de un servidor: `ORQ_MCP_<SERVIDOR>_<CLAVE>`. */
export function mcpEnvName(server: string, key: string): string {
  const part = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `ORQ_MCP_${part(server)}_${part(key) || 'VALOR'}`;
}

/** `Bearer <token>` → token (o undefined si el encabezado no tiene esa forma). */
export function bearerToken(value: string): string | undefined {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
  return m?.[1];
}

/** Valores secretos de los servidores, para `redactSecrets` (encabezados, tokens y `env`). */
export function mcpSecrets(servers: McpServerMap): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(servers)) {
    const values = spec.type === 'http' ? Object.values(spec.headers) : Object.values(spec.env ?? {});
    for (const v of values) {
      out.add(v);
      const token = bearerToken(v);
      if (token) out.add(token);
    }
  }
  return [...out].filter((v) => v.length >= 8);
}

/** Notas para el encargo: las del permiso y las de cada servidor, en orden. */
export function mcpNotes(grant: Pick<McpGrant, 'servers' | 'notes'>): string[] {
  const perServer = Object.entries(grant.servers).flatMap(([name, spec]) => (spec.instructions ? [`\`${name}\`: ${spec.instructions}`] : []));
  return [...grant.notes, ...perServer];
}

/** Sección «Plugins» para el encargo (vacía si no hay servidores ni notas). */
export function pluginsSection(grant: Pick<McpGrant, 'servers' | 'notes'>): string {
  const names = Object.keys(grant.servers);
  const notes = mcpNotes(grant);
  if (names.length === 0 && notes.length === 0) return '';
  const lines = ['## Plugins del orquestador'];
  if (names.length > 0) lines.push(`Servidores MCP disponibles en esta sesión: ${names.map((n) => `\`${n}\``).join(', ')}.`);
  for (const note of notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

/**
 * Pide los servidores a la fuente sin que un fallo tumbe la ejecución: si la fuente falla, la sesión sigue sin
 * plugins y un aviso queda en `notes`.
 */
export async function safeGrant(source: McpServerSource | undefined, req: McpGrantRequest): Promise<McpGrant> {
  if (!source) return EMPTY_GRANT;
  try {
    const grant = await source(req);
    const servers: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries(grant.servers)) if (MCP_SERVER_NAME_RE.test(name)) servers[name] = spec;
    return { servers, notes: [...grant.notes], release: grant.release };
  } catch {
    // El motivo no va al encargo: podría traer datos de la bóveda. El servicio ya lo registró tachado.
    return { servers: {}, notes: ['Los plugins no están disponibles en esta sesión (no se pudieron preparar).'], release: async () => undefined };
  }
}
