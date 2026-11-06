/**
 * Cableado del chat con la mente (c15) sobre la composición: ajustes, plugins, flota, planificador, memoria, skills,
 * cupos y bóveda. Se registra con una línea en `ROUTE_MODULE_FACTORIES` (route-modules.ts).
 *
 * Ajustes (c14) y plugins (c16) llegan por `ChatWiring`: mientras no estén cableados, la mente usa `DEFAULT_SETTINGS`
 * y ningún servidor MCP extra.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS } from '../../shared/index.ts';
import type { Settings } from '../../shared/index.ts';
import { claudeMcpOptions } from '../adapters/claude-sdk/adapter.ts';
import { ClaudeSdkTranslator } from '../adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService, conversationsRoot, registerChatRoutes, type MindPlugins, type MindPort } from '../chat/index.ts';
import { MAX_OUTPUT_CHARS, type ConductorQueryFn, type FleetPort } from '../conductor/index.ts';
import { pluginsSection } from '../plugins/index.ts';
import type { RouteModule } from '../server/index.ts';
import type { Composition } from './compose.ts';
import { mindDenyPaths, plannerPort, projectSkillsPort, taskProjectOf, withTaskProjects } from './conductor.ts';
import { withoutHostCredentials } from './env.ts';
import { fleetTaskList } from './fleet-port.ts';
import { retryAsMind } from './fleet-service.ts';

export interface ChatWiring {
  /** Ajustes vigentes (c14: `SettingsStore`); por defecto `DEFAULT_SETTINGS`. */
  settings?: () => Settings;
  /** Servidores MCP fijos para la mente (pruebas). Sin esto, los plugins de `comp.plugins`, leídos en cada mensaje. */
  mcpServersFor?: (agentId: string) => Readonly<Record<string, McpServerConfig>>;
  /** `query` del SDK (pruebas). */
  query?: ConductorQueryFn;
  idleMs?: number;
  drives?: () => readonly string[];
  /** Raíz de las carpetas internas de las conversaciones; por defecto `conversationsRoot(dataDir)`. */
  conversationsRoot?: string;
  /** Recibe el servicio armado (para `shutdown()` al detener el núcleo, o pruebas). */
  onReady?: (service: ChatService, attachments: AttachmentStore) => void;
}

/**
 * Flota de la composición sin armarla antes de tiempo: `status`/`list` leen la cola y la base; `delegate` arma la flota
 * (carga los adaptadores) la primera vez que se entrega una tarea. Cada estado lleva el proyecto de su tarea
 * (`withTaskProjects`): la cola es de todos los proyectos y la mente de un chat solo ve las del suyo.
 */
export function lazyFleetPort(comp: Pick<Composition, 'fleet'> & Partial<Pick<Composition, 'store'>>): FleetPort {
  const port: FleetPort = {
    delegate: async (task) => (await comp.fleet.port()).delegate(task),
    // Desde la base además de la cola: trae el motivo de un fallo y sirve tras reiniciar el núcleo.
    status: (taskId) => comp.fleet.status(taskId),
    // La cola nace vacía en cada arranque: la base trae las tareas que no tiene (fallidas, integradas, del Tablero).
    list: () => fleetTaskList(comp.fleet.queue.list(), comp.store?.listTasks() ?? []),
    retry: (taskId) => retryAsMind(comp.fleet, taskId),
  };
  return withTaskProjects(port, taskProjectOf(comp));
}

/**
 * Plugins de la composición para la mente (Claude), leídos en cada mensaje (`ChatService` decide con ellos si la
 * sesión viva sirve) y su estado de ahora para la guardia. Las reglas (notas del permiso e `instructions` de cada
 * servidor, las mismas que recibe la flota) salen del mapa neutro, antes de `claudeMcpOptions`, que no las lleva. Los
 * valores secretos (token de Canva) van por variables de entorno del proceso del SDK (`${VAR}` en la configuración),
 * nunca en los argumentos.
 */
function mindPlugins(comp: Composition): Required<Pick<MindPort, 'plugins' | 'pluginLive'>> {
  return {
    async plugins(agentId: string): Promise<MindPlugins> {
      try {
        const neutral = await comp.plugins.forMind(agentId);
        return { ...claudeMcpOptions(neutral.servers), rules: pluginsSection(neutral) };
      } catch {
        return { mcpServers: {}, env: {} };
      }
    },
    pluginLive: (agentId, server) => comp.plugins.delivers(agentId, 'claude-sdk', server),
  };
}

export function chatRouteModule(comp: Composition, wiring: ChatWiring = {}): RouteModule {
  return (ctx) => {
    const db = ctx.store.database;
    const attachments = new AttachmentStore({ db, dir: join(comp.config.dataDir, 'attachments'), now: ctx.now });
    const skillsRoot = comp.skills.installRoot;
    const service = new ChatService({
      db,
      store: ctx.store,
      hub: ctx.hub,
      settings: wiring.settings ?? (() => DEFAULT_SETTINGS),
      mind: {
        agents: () => comp.registry.list().map((a) => a.config),
        env: (agentId) => comp.env.load(agentId),
        ...(wiring.mcpServersFor ? {} : mindPlugins(comp)),
        baseEnv: () => withoutHostCredentials(comp.hostEnv()),
        budgetLeftUsd: (agentId) => {
          const budget = comp.registry.get(agentId)?.config.budgetUsd;
          return budget === undefined ? undefined : budget - comp.billedSpentUsd(agentId);
        },
        liveSpend: (agentId) => comp.liveSpend.open(agentId),
      },
      ports: {
        planner: plannerPort(comp),
        fleet: lazyFleetPort(comp),
        quotas: { all: () => ctx.store.latestQuotas().map((q) => q.snapshot) },
        memory: comp.memory,
        // Solo las skills comunes del hub: las de `<carpeta del núcleo>/.agents/skills` son de otro proyecto.
        skills: projectSkillsPort(comp.skills),
      },
      // El detalle de cada herramienta, con el mismo tope que reciben de ellas la mente y sus subagentes.
      translator: (init) => new ClaudeSdkTranslator({ ...init, detailMax: MAX_OUTPUT_CHARS }),
      attachments,
      ...(wiring.mcpServersFor ? { mcpServersFor: wiring.mcpServersFor } : {}),
      readRoots: existsSync(skillsRoot) ? [skillsRoot] : [],
      conversationsRoot: wiring.conversationsRoot ?? conversationsRoot(comp.config.dataDir),
      // Bóveda de claves, base del núcleo y memoria de Obsidian (la de todos los proyectos; también en bypass).
      denyPaths: mindDenyPaths(comp),
      ...(wiring.drives ? { drives: wiring.drives } : {}),
      ...(wiring.query ? { query: wiring.query } : {}),
      ...(wiring.idleMs !== undefined ? { idleMs: wiring.idleMs } : {}),
      now: ctx.now,
      ...(ctx.log ? { log: ctx.log } : {}),
    });
    registerChatRoutes(ctx, { service, attachments });
    ctx.onStarted(() => service.recover());
    wiring.onReady?.(service, attachments);
  };
}
