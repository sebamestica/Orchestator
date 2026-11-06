/**
 * Módulo de rutas de c14 (F5): ajustes, candidatos a mente, carpetas, proyecto desde carpeta, tarea manual e interfaz
 * estática. Se cablea con una línea en `route-modules.ts`. Plan: docs/plan/F5-INTERFAZ.md §3.
 */
import { resolve, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  folderInspectionSchema,
  fsListResponse,
  mindCandidateSchema,
  projectFromFolderBody,
  redactSecrets,
  settingsPatchSchema,
  settingsSchema,
  taskBriefSchema,
  type Settings,
  type TaskBrief,
} from '../../shared/index.ts';
import { createFolderPicker, FolderError, gateForWorkspace, inspectFolder, listFolder, listRoots, type FsEnv } from '../fs/folders.ts';
import { ApiError, apiSchemas, type RouteModule, type RouteModuleContext } from '../server/index.ts';
import { staticUi } from '../server/static.ts';
import { mindCandidates, mindSupport, settingsStoreFor, type SettingsStore } from '../settings/index.ts';
import { projectInputSchema, type ProjectInput } from '../store/index.ts';
import { DEFAULT_INTEGRATION_BRANCH } from '../workspace/index.ts';
import type { Composition } from './compose.ts';

// ------------------------------------------------------------------ esquemas de las rutas

export const settingsResponse = z.strictObject({ settings: settingsSchema });
export const mindCandidatesResponse = z.strictObject({ candidates: z.array(mindCandidateSchema) });
export const fsListQuery = z.strictObject({
  /** Carpeta a listar (absoluta). Sin ella (o vacía): las carpetas habituales y las unidades. */
  path: z.string().max(4096).optional(),
});
export const pickFolderResponse = z.strictObject({ path: z.string().nullable() });
export const inspectFolderBody = z.strictObject({ path: z.string().min(1).max(4096) });

/** Aceptación de una tarea manual cuando el usuario no da ninguna. */
export const MANUAL_DEFAULT_ACCEPTANCE = 'La verificación del proyecto (gate) pasa';
/** Interfaz compilada por defecto: `dist/ui` del repositorio (`ORQ_UI_DIR` la reemplaza). */
export const DEFAULT_UI_DIR = fileURLToPath(new URL('../../../dist/ui', import.meta.url));

export interface F5ServerOptions {
  /** Por defecto la instancia compartida de la base (`settingsStoreFor(store.database)`). */
  settings?: SettingsStore;
  /** Diálogo de carpetas (`POST /fs/pick-folder`). Sin él, la ruta responde 501. */
  pickFolder?: () => Promise<string | null>;
  /** Carpeta de la interfaz compilada; sin ella no se sirve la interfaz (las rutas de la API siguen igual). */
  uiDir?: string;
  /** Plataforma, perfil y entorno para el explorador de carpetas (pruebas). */
  fsEnv?: FsEnv;
}

/** Errores del módulo de carpetas → errores de la API (los mensajes no repiten la ruta pedida). */
async function fsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof FolderError)) throw err;
    switch (err.code) {
      case 'invalid':
        throw new ApiError(400, 'invalid_request', err.message);
      case 'not_found':
        throw new ApiError(404, 'not_found', err.message);
      case 'unsupported':
        throw new ApiError(501, 'not_configured', err.message);
      case 'failed':
        throw new ApiError(500, 'internal', err.message);
    }
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return redactSecrets(`${where}${issue?.message ?? 'valor no válido'}`).slice(0, 300);
}

/** Raíz de worktrees de un proyecto registrado desde la interfaz: `C:\dev\.worktrees\<id>-orq`. */
export function folderWorktreesRoot(projectId: string, repoPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return win32.join('C:\\dev\\.worktrees', `${projectId}-orq`);
  return posix.join(posix.dirname(repoPath), '.worktrees', `${projectId}-orq`);
}

/** Las rutas de c14 sobre el contexto del servidor (las pruebas y la documentación lo arman sin composición). */
export function createF5ServerRoutes(opts: F5ServerOptions = {}): RouteModule {
  return (ctx: RouteModuleContext) => {
    const { r, store, registry, hub } = ctx;
    const settings = opts.settings ?? settingsStoreFor(store.database);
    const fsEnv = opts.fsEnv ?? {};
    const platform = fsEnv.platform ?? process.platform;
    if (opts.uiDir) ctx.beforeAuth(staticUi({ dir: opts.uiDir }));

    const requireProject = (id: string) => {
      const p = store.getProject(id);
      if (!p) throw new ApiError(404, 'not_found', `No existe el proyecto ${id}`);
      return p;
    };

    // ------------------------------------------------------------ ajustes
    r.add(
      { method: 'get', path: '/settings', tag: 'Ajustes', summary: 'Ajustes de la interfaz: mente, subagentes, modo, cupo, concurrencia y apariencia', response: settingsResponse },
      () => ({ settings: settings.get() }),
    );
    r.add(
      {
        method: 'patch',
        path: '/settings',
        tag: 'Ajustes',
        summary: 'Cambia ajustes (un nivel de profundidad) y los difunde por /ws',
        description:
          'Solo los campos enviados; `mind` y `appearance` se mezclan campo a campo y `mind.model: null` borra el modelo. `workers` vacío: todos los agentes habilitados son subagentes. La mente debe ser un agente registrado que pueda serlo (`GET /mind/candidates`, `support` distinto de `none`). Cada cambio se transmite por `/ws` como `{type:"settings"}` y la flota aplica al momento la concurrencia, los subagentes y el umbral de cupo.',
        body: settingsPatchSchema,
        response: settingsResponse,
        errors: [400, 415],
        example: { mind: { effort: 'high' }, workers: ['claude-mi-clave', 'codex'], concurrency: 2, quotaFloor: 0.25 },
      },
      ({ body }) => {
        const mindId = body.mind?.agentId;
        if (mindId) {
          const agent = registry.get(mindId);
          if (!agent) throw new ApiError(400, 'invalid_request', `La mente debe ser un agente registrado: no existe ${mindId}`);
          const { support, note } = mindSupport(agent);
          if (support === 'none') throw new ApiError(400, 'invalid_request', `${mindId} no puede ser la mente: ${note ?? 'no compatible'}`);
        }
        const saved: Settings = settings.update(body);
        hub.publish({ type: 'settings', settings: saved });
        return { settings: saved };
      },
    );
    r.add(
      {
        method: 'get',
        path: '/mind/candidates',
        tag: 'Ajustes',
        summary: 'Agentes que pueden hacer de mente, con sus modelos',
        description:
          'Claude (`claude-sdk`) habilitado: `full`. Codex y agy: `experimental` (necesitan el puente MCP de F5.2). Modelos por API y agentes deshabilitados: `none`. Los modelos salen de la última prueba del agente.',
        response: mindCandidatesResponse,
      },
      () => ({ candidates: mindCandidates(registry.list()) }),
    );

    // ------------------------------------------------------------ carpetas
    r.add(
      {
        method: 'get',
        path: '/fs/list',
        tag: 'Carpetas',
        summary: 'Lista una carpeta del equipo (o las carpetas habituales y las unidades)',
        description: `Carpetas primero, sin archivos de sistema, con \`isGitRepo\` (tiene \`.git\`) y como mucho 2000 entradas. Sin \`path\`: \`C:\\dev\`, el Escritorio, el perfil y las unidades que existen (\`path: ""\`).`,
        query: fsListQuery,
        response: fsListResponse,
        errors: [400, 404],
        queryExample: { path: 'C:\\dev' },
      },
      ({ query }) => fsCall(() => (query.path?.trim() ? listFolder(query.path, fsEnv) : listRoots(fsEnv))),
    );
    r.add(
      {
        method: 'post',
        path: '/fs/pick-folder',
        tag: 'Carpetas',
        summary: 'Abre el diálogo de carpetas de Windows y devuelve la elegida',
        description:
          'Para la interfaz web (Electron usa el suyo). Espera a que el usuario elija o cancele (`path: null`); con un diálogo ya abierto, la petición espera esa misma respuesta. 501 fuera de Windows.',
        response: pickFolderResponse,
        errors: [501],
      },
      async () => {
        const pick = opts.pickFolder;
        if (!pick) throw new ApiError(501, 'not_configured', 'El diálogo de carpetas no está configurado en este arranque');
        return { path: await fsCall(pick) };
      },
    );

    // ------------------------------------------------- proyecto desde carpeta
    r.add(
      {
        method: 'post',
        path: '/projects/inspect',
        tag: 'Proyectos',
        summary: 'Deduce id, nombre, gate y enlaces de una carpeta antes de registrarla',
        description:
          'Gate: el primer script de `package.json` entre `check`, `gate` y `test` (`npm run -s <script>`), o pytest (`python -m pytest -q`), o `null`. `links`: `node_modules` si existe. Avisa si no es git o si no hay gate (entonces se trabajará en local) y si la carpeta ya es un proyecto.',
        body: inspectFolderBody,
        response: folderInspectionSchema,
        errors: [400, 404, 415],
        example: { path: 'C:\\dev\\Vetworld' },
      },
      ({ body }) => fsCall(async () => (await inspectFolder(body.path, { ...fsEnv, projects: store.listProjects() })).inspection),
    );
    r.add(
      {
        method: 'post',
        path: '/projects/from-folder',
        tag: 'Proyectos',
        summary: 'Registra un proyecto apuntando a una carpeta',
        description:
          'Con git y gate deducido, con `workspace`: worktrees en `C:\\dev\\.worktrees\\<id>-orq`, rama base la actual (o `main`), integración en `orq/integracion`, enlaces y gate (30 min). Sin git, sin commits o sin gate se registra sin `workspace`: la flota trabaja en **modo local**, directamente en la carpeta (sin worktrees, ramas ni commits; una tarea a la vez; el gate se corre si aparece uno). 409 si el id ya existe o la carpeta ya es un proyecto.',
        body: projectFromFolderBody,
        response: apiSchemas.projectResponse,
        status: 201,
        errors: [400, 404, 409, 415],
        example: { path: 'C:\\dev\\Vetworld', name: 'Vetworld' },
      },
      async ({ body }) => {
        const report = await fsCall(() => inspectFolder(body.path, { ...fsEnv, projects: store.listProjects() }));
        const { inspection } = report;
        if (report.registeredAs) throw new ApiError(409, 'conflict', `La carpeta ya está registrada como el proyecto ${report.registeredAs}`);
        const id = body.id ?? inspection.suggestedId;
        if (store.getProject(id)) throw new ApiError(409, 'conflict', `Ya existe el proyecto ${id}`);
        const name = (body.name ?? inspection.suggestedName).slice(0, 120);
        const input: ProjectInput = { id, name, repoPath: inspection.path };
        // Worktrees solo con git, al menos un commit y gate; si falta algo, modo local (directo en la carpeta).
        if (inspection.isGitRepo && report.hasCommits && inspection.gate) {
          input.workspace = {
            worktreesRoot: folderWorktreesRoot(id, inspection.path, platform),
            baseBranch: report.branch ?? 'main',
            integrationBranch: DEFAULT_INTEGRATION_BRANCH,
            links: inspection.links,
            gate: gateForWorkspace(inspection.gate),
          };
        }
        const parsed = projectInputSchema.safeParse(input);
        if (!parsed.success) throw new ApiError(400, 'invalid_request', `No se pudo registrar la carpeta: ${firstIssue(parsed.error)}`);
        return { project: store.putProject(input) };
      },
    );

    // --------------------------------------------------------- tarea manual
    r.add(
      {
        method: 'post',
        path: '/tasks/manual',
        tag: 'Planes y tareas',
        summary: 'Crea una tarea a mano (y la aprueba, salvo `approve: false`)',
        description: `El núcleo completa el encargo: id \`manual-<fecha>-<6 hex>\`, sin dependencias, dificultad \`medium\`, el agente elegido como sugerido y, si no hay aceptación, «${MANUAL_DEFAULT_ACCEPTANCE}». Con \`approve\` (por defecto) se aprueba igual que \`POST /tasks/:id/approve\`.`,
        body: apiSchemas.manualTaskBody,
        response: apiSchemas.taskResponse,
        status: 201,
        errors: [400, 404, 409, 413, 415],
        example: {
          projectId: 'vetworld',
          title: 'Corregir la fecha de las citas',
          objective: 'Las citas del lunes se muestran con un día de desfase: corrige la zona horaria al guardarlas.',
          ownedPaths: ['src/citas/**'],
          acceptance: ['Las pruebas de citas pasan'],
          approve: false,
        },
      },
      async ({ body }) => {
        requireProject(body.projectId);
        if (body.agentId) registry.require(body.agentId);
        let id = ctx.newId('manual');
        for (let i = 0; i < 5 && store.getTask(id); i++) id = ctx.newId('manual');
        if (store.getTask(id)) throw new ApiError(409, 'conflict', 'No se pudo generar un id libre para la tarea');
        const brief: TaskBrief = taskBriefSchema.parse({
          id,
          projectId: body.projectId,
          title: body.title,
          objective: body.objective,
          ownedPaths: body.ownedPaths,
          dependsOn: [],
          acceptance: body.acceptance.length > 0 ? body.acceptance : [MANUAL_DEFAULT_ACCEPTANCE],
          difficulty: 'medium',
          ...(body.agentId ? { suggestedAgent: body.agentId } : {}),
          contextRefs: [],
          skillRefs: [],
        });
        const created = store.putTask(brief);
        hub.publishTask(created);
        return { task: body.approve ? await ctx.approveTask(created, body.agentId) : created };
      },
    );
  };
}

const uiEnvSchema = z.object({ ORQ_UI_DIR: z.string().trim().min(1).optional() });

/** Carpeta de la interfaz: `ORQ_UI_DIR` o `dist/ui` del repositorio. */
export function resolveUiDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const parsed = uiEnvSchema.safeParse({ ORQ_UI_DIR: env.ORQ_UI_DIR || undefined });
  const dir = parsed.success ? parsed.data.ORQ_UI_DIR : undefined;
  return dir ? resolve(dir) : DEFAULT_UI_DIR;
}

/**
 * Fábrica de c14 para `ROUTE_MODULE_FACTORIES`: los ajustes compartidos de la base, la flota atada a ellos
 * (concurrencia, subagentes y umbral de cupo), el diálogo de Windows con el PowerShell de la configuración y la
 * interfaz de `dist/ui`.
 */
export function f5Servidor(comp: Composition): RouteModule {
  const log = comp.deps.log ?? (() => undefined);
  const settings = settingsStoreFor(comp.store.database, {
    onInvalidRow: (key) => log(`ajustes: el valor guardado de ${key} no es válido; se usa el predeterminado`),
  });
  comp.fleet.useSettings(() => settings.get());
  settings.onChange(() => comp.fleet.settingsChanged());
  return createF5ServerRoutes({
    settings,
    pickFolder: createFolderPicker({ powershellPath: comp.config.powershellPath }),
    uiDir: resolveUiDir(comp.deps.env),
  });
}
