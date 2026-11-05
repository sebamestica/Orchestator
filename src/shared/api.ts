/**
 * Contratos de F5 (interfaz): ajustes, chats con la mente, adjuntos, carpetas, plugins y plan obligatorio.
 * Los usan el núcleo (src/core/server) y la interfaz (src/ui). Fuente de verdad: este archivo (lo cambia solo A0).
 * Plan: docs/plan/F5-INTERFAZ.md.
 */
import { z } from 'zod';
import { idSchema } from './agents.ts';
import { taskBriefSchema } from './tasks.ts';

const isoSchema = z.iso.datetime({ offset: true });
/** Id opaco generado por el núcleo (uuid u otro): no sigue `idSchema`. */
export const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,100}$/);

// ── Modo de la mente (Shift+Tab) ─────────────────────────────────────────────────────────────

/**
 * - `plan`: la mente lee, investiga y propone tareas; nada se ejecuta sin que el usuario apruebe.
 * - `auto`: la mente aprueba y delega sola sus tareas; integra en la rama de integración tras el gate.
 *   Pasar a `main` sigue pidiendo aprobación.
 * - `bypass`: la mente trabaja sola, como un Claude Code autónomo con la flota a mano. Edita, crea archivos y ejecuta
 *   comandos ella misma en la carpeta del proyecto y en las carpetas extra del chat; los comandos pasan por la
 *   política de shell de los workers. No pregunta ni muestra planes: delega cuando conviene, elige lo razonable y
 *   persiste. Además lee fuera de la carpeta del proyecto, y la flota pasa a `main` sin preguntar cuando el gate pasa.
 * - En todos los modos siguen bloqueados el push, el despliegue, los pagos, borrar ramas y reescribir la historia.
 */
export const mindModeSchema = z.enum(['plan', 'auto', 'bypass']);
export type MindMode = z.infer<typeof mindModeSchema>;
/** Orden del ciclo con Shift+Tab. */
export const MIND_MODE_CYCLE: readonly MindMode[] = ['auto', 'plan', 'bypass'];
export function nextMindMode(mode: MindMode): MindMode {
  const i = MIND_MODE_CYCLE.indexOf(mode);
  return MIND_MODE_CYCLE[(i + 1) % MIND_MODE_CYCLE.length] ?? 'plan';
}

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

// ── Ajustes (GET/PATCH /settings) ────────────────────────────────────────────────────────────

export const themeSchema = z.enum(['system', 'dark', 'light']);

export const settingsSchema = z.strictObject({
  mind: z.strictObject({
    /** Agente que hace de mente (orquestador). `null`: el primer agente `claude-sdk` habilitado. */
    agentId: idSchema.nullable(),
    /** Modelo de la mente; sin él, el del agente o el predeterminado del orquestador. */
    model: z.string().min(1).max(100).optional(),
    effort: effortSchema,
  }),
  /** Agentes que la mente puede usar como subagentes de la flota. Vacío: todos los habilitados. */
  workers: z.array(idSchema).max(50),
  /** Modo con el que arranca un chat nuevo. */
  defaultMode: mindModeSchema,
  /** Umbral de cupo (0–1) para Codex y agy. */
  quotaFloor: z.number().min(0).max(1),
  /** Agentes ejecutando a la vez (sin contar la mente). */
  concurrency: z.number().int().min(1).max(8),
  appearance: z.strictObject({
    theme: themeSchema,
    /** Sin desenfoque de vidrio ni animaciones largas (menos GPU). */
    reducedEffects: z.boolean(),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  mind: { agentId: null, effort: 'medium' },
  workers: [],
  defaultMode: 'plan',
  quotaFloor: 0.2,
  concurrency: 3,
  appearance: { theme: 'dark', reducedEffects: false },
};

/** Cambio parcial de ajustes (un nivel de profundidad). `mind.model: null` borra el modelo. */
export const settingsPatchSchema = z.strictObject({
  mind: z
    .strictObject({
      agentId: idSchema.nullable().optional(),
      model: z.string().min(1).max(100).nullable().optional(),
      effort: effortSchema.optional(),
    })
    .optional(),
  workers: z.array(idSchema).max(50).optional(),
  defaultMode: mindModeSchema.optional(),
  quotaFloor: z.number().min(0).max(1).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  appearance: z.strictObject({ theme: themeSchema.optional(), reducedEffects: z.boolean().optional() }).optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Qué puede hacer cada agente como mente (lo calcula el núcleo). */
export const mindSupportSchema = z.enum(['full', 'experimental', 'none']);
export const mindCandidateSchema = z.strictObject({
  agentId: idSchema,
  displayName: z.string(),
  kind: z.string(),
  support: mindSupportSchema,
  /** Motivo cuando `support` no es `full`. */
  note: z.string().optional(),
  models: z.array(z.string()),
});
export type MindCandidate = z.infer<typeof mindCandidateSchema>;

// ── Adjuntos (POST /attachments) ─────────────────────────────────────────────────────────────

/** Tope de un adjunto subido por la interfaz (imagen pegada o archivo soltado). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const attachmentSchema = z.strictObject({
  id: opaqueIdSchema,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  /** Ruta absoluta en el equipo (copia en la carpeta de datos, o el archivo original si vino por ruta). */
  path: z.string().min(1),
  kind: z.enum(['image', 'text', 'file']),
  /** `upload`: bytes subidos (web o pegado); `path`: archivo local referido por ruta (Electron). */
  source: z.enum(['upload', 'path']),
  createdAt: isoSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Alta por ruta (Electron conoce la ruta real del archivo soltado). La subida de bytes va como
 * `POST /attachments?name=<archivo>` con el cuerpo crudo y su `Content-Type`.
 */
export const attachmentByPathBody = z.strictObject({ path: z.string().min(1).max(4096) });

// ── Chats con la mente (/chats) ──────────────────────────────────────────────────────────────

export const chatStateSchema = z.enum(['idle', 'running', 'error', 'closed']);

export const chatSchema = z.strictObject({
  id: opaqueIdSchema,
  /** `null`: agente suelto, sin proyecto (no delega a la flota). */
  projectId: idSchema.nullable(),
  title: z.string().max(200),
  /** Carpeta de trabajo de la mente. */
  cwd: z.string().min(1),
  /** Carpetas extra que la mente puede leer («salir de la carpeta»). */
  extraRoots: z.array(z.string().min(1)).max(20),
  mode: mindModeSchema,
  mindAgentId: idSchema,
  /** `AgentEvent.sessionId` de la conversación: en `/ws` llegan sus eventos y se piden con `replay`. */
  sessionId: z.string().min(1),
  state: chatStateSchema,
  costUsd: z.number().nonnegative(),
  createdAt: isoSchema,
  updatedAt: isoSchema,
  /**
   * Subagentes de la mente que siguen trabajando en segundo plano (p. ej. investigadores), aunque el turno ya haya
   * terminado. Solo en memoria: falta o es 0 si no hay ninguno.
   */
  backgroundTasks: z.number().int().nonnegative().optional(),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatMessageSchema = z.strictObject({
  id: opaqueIdSchema,
  chatId: opaqueIdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  attachments: z.array(attachmentSchema),
  /** Modo vigente cuando se envió. */
  mode: mindModeSchema,
  at: isoSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const createChatBody = z.strictObject({
  projectId: idSchema.nullable(),
  /** Por defecto, `repoPath` del proyecto; obligatoria para un agente suelto. */
  cwd: z.string().min(1).max(4096).optional(),
  extraRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
  mode: mindModeSchema.optional(),
  title: z.string().max(200).optional(),
});
export type CreateChatBody = z.infer<typeof createChatBody>;

export const patchChatBody = z.strictObject({
  mode: mindModeSchema.optional(),
  title: z.string().max(200).optional(),
  extraRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
});
export type PatchChatBody = z.infer<typeof patchChatBody>;

export const sendMessageBody = z
  .strictObject({
    text: z.string().max(100_000),
    attachmentIds: z.array(opaqueIdSchema).max(20).default([]),
  })
  .refine((b) => b.text.trim().length > 0 || b.attachmentIds.length > 0, { message: 'Mensaje vacío' });
export type SendMessageBody = z.input<typeof sendMessageBody>;

export const proposalApprovalSchema = z.enum(['proposed', 'approved', 'rejected', 'delegated']);
export const proposalSchema = z.strictObject({
  task: taskBriefSchema,
  approval: proposalApprovalSchema,
  proposedAt: isoSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;

// ── Destino de los cambios del chat (GET /chats/:id/target, issue 2) ─────────────────────────

/**
 * Dónde quedan los cambios de un chat. `local` salvo que el usuario haya indicado en el plan un repositorio donde
 * subirlos (`crear_tareas.destino`): entonces `remote`. Berland no sube nada; `remote` solo anota el destino.
 * `url` siempre va saneada: sin usuario, contraseña, token, consulta ni fragmento; SSH como `host/ruta`.
 */
export const changesTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local'),
    /** Carpeta donde quedan los cambios: la del proyecto o, sin proyecto, la del chat. */
    path: z.string().min(1),
    /** `none`: la carpeta no es git; `local`: git sin remoto; `remote`: git con remoto (igual no se sube). */
    git: z.enum(['none', 'local', 'remote']),
    /** El proyecto trabaja con worktrees y ramas `orq/…` (tiene `workspace`); sin él, directo en la carpeta. */
    worktrees: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('remote'),
    /** Carpeta del proyecto. */
    path: z.string().min(1),
    /** `name`: el remoto de la carpeta que corresponde (`null` si la URL no es de ninguno). `url`: vacía si solo se dio un nombre que no existe. */
    remote: z.strictObject({ name: z.string().nullable(), url: z.string() }),
    /** Rama de destino: la indicada en el plan o la actual de la carpeta. */
    branch: z.string().nullable(),
    /** El remoto está en `git remote` de la carpeta. */
    configured: z.boolean(),
  }),
]);
export type ChangesTarget = z.infer<typeof changesTargetSchema>;

/** Respuesta de `GET /chats/:id/target`. */
export const chatTargetResponse = z.strictObject({ target: changesTargetSchema });
export type ChatTargetResponse = z.infer<typeof chatTargetResponse>;

/** Mensaje en vivo (`/ws`) cuando cambia el destino de un chat. */
export const chatTargetMessageSchema = z.strictObject({ type: z.literal('chat_target'), chatId: z.string(), target: changesTargetSchema });
export type ChatTargetMessage = z.infer<typeof chatTargetMessageSchema>;

// ── Tarea manual (POST /tasks/manual) ────────────────────────────────────────────────────────

/** Tarea que el usuario da directamente (casos puntuales): el núcleo completa el resto del encargo. */
export const manualTaskBody = z.strictObject({
  projectId: idSchema,
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(20_000),
  ownedPaths: z.array(z.string().min(1)).min(1).max(100),
  acceptance: z.array(z.string().min(1)).max(50).default([]),
  agentId: idSchema.optional(),
  /** Si es `true` se aprueba al crearla. */
  approve: z.boolean().default(true),
});
export type ManualTaskBody = z.input<typeof manualTaskBody>;

// ── Plan de implementación obligatorio ───────────────────────────────────────────────────────

/** Archivos del plan dentro de cada worktree (los escribe la flota; el agente los relee si pierde el hilo). */
export const PLAN_FILES = {
  /** Plan general del que sale la tarea (copia de solo lectura para el agente). */
  plan: '.orq/PLAN.md',
  /** Plan de implementación de la tarea: lo escribe el agente antes de tocar código y marca sus pasos. */
  taskPlan: '.orq/PLAN-TAREA.md',
  brief: '.orq/BRIEF.md',
  handoff: '.orq/HANDOFF.md',
} as const;

// ── Carpetas y proyectos desde carpeta ───────────────────────────────────────────────────────

export const fsEntrySchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  isGitRepo: z.boolean(),
});
export const fsListResponse = z.strictObject({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(fsEntrySchema),
});
export type FsListResponse = z.infer<typeof fsListResponse>;

/** Registrar un proyecto apuntando a una carpeta: el núcleo deduce id, nombre, workspace y gate. */
export const projectFromFolderBody = z.strictObject({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(120).optional(),
  id: idSchema.optional(),
});
/** Lo que el núcleo deduce de una carpeta antes de registrarla (`POST /projects/inspect`). */
export const folderInspectionSchema = z.strictObject({
  path: z.string(),
  suggestedId: idSchema,
  suggestedName: z.string(),
  isGitRepo: z.boolean(),
  /** Gate propuesto (p. ej. `npm run -s check`), o `null` si no se encontró uno. */
  gate: z.array(z.strictObject({ command: z.string(), args: z.array(z.string()) })).nullable(),
  links: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type FolderInspection = z.infer<typeof folderInspectionSchema>;

// ── Plugins (/plugins) ───────────────────────────────────────────────────────────────────────

export const pluginIdSchema = z.enum(['chrome', 'canva']);
export type PluginId = z.infer<typeof pluginIdSchema>;

export const pluginStatusSchema = z.enum(['disconnected', 'connecting', 'connected', 'error']);
export const pluginSchema = z.strictObject({
  id: pluginIdSchema,
  name: z.string(),
  description: z.string(),
  status: pluginStatusSchema,
  /** Detalle visible (cuenta conectada, perfil de Chrome, motivo del error…). Nunca un token. */
  detail: z.string().optional(),
  /** Agentes a los que se entrega el plugin cuando está conectado. Vacío: a todos los compatibles. */
  agents: z.array(idSchema),
  /** Pasos que el usuario tiene que hacer a mano (p. ej. activar la depuración remota de Chrome). */
  steps: z.array(z.string()),
  /** URL que la interfaz abre en el navegador para iniciar sesión (OAuth), si la conexión la necesita. */
  authUrl: z.url().optional(),
  updatedAt: isoSchema,
});
export type Plugin = z.infer<typeof pluginSchema>;

export const chromeProfileSchema = z.enum(['personal', 'agente']);
export const connectPluginBody = z.strictObject({
  /** Solo Chrome: `personal` = tu Chrome con tus sesiones; `agente` = perfil propio de los agentes. */
  profile: chromeProfileSchema.optional(),
  agents: z.array(idSchema).max(50).optional(),
});
export type ConnectPluginBody = z.infer<typeof connectPluginBody>;

// ── Puente de escritorio (preload de Electron → window.orq) ─────────────────────────────────

/** Lo que Electron expone en `window.orq`. En la web no existe y la interfaz usa la API del núcleo. */
export interface DesktopBridge {
  readonly platform: 'win32' | 'darwin' | 'linux';
  /** URL del núcleo y token de la sesión (el token nunca se guarda en disco ni en localStorage). */
  core(): Promise<{ url: string; wsUrl: string; token: string }>;
  pickFolder(): Promise<string | null>;
  /** Ruta real de un `File` soltado desde el escritorio (`webUtils.getPathForFile`). */
  pathForFile(file: File): string | null;
  openExternal(url: string): Promise<void>;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
}
