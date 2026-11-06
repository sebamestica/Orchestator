/**
 * Contratos de F5 (interfaz): ajustes, chats con la mente, adjuntos, carpetas, plugins, uso y gasto, y plan obligatorio.
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
 * - `chat`: la mente no orquesta: conversa como un asistente de programación (como Claude Code) en la carpeta del chat,
 *   con o sin proyecto. Responde, explica y hace los cambios ella misma (lee, edita, crea archivos y ejecuta comandos
 *   en la carpeta y en las carpetas extra, con la misma guardia que bypass). No crea tareas ni delega a la flota.
 * - En todos los modos siguen bloqueados el push, el despliegue, los pagos, borrar ramas y reescribir la historia.
 */
export const mindModeSchema = z.enum(['plan', 'auto', 'bypass', 'chat']);
export type MindMode = z.infer<typeof mindModeSchema>;
/** Orden del ciclo con Shift+Tab. */
export const MIND_MODE_CYCLE: readonly MindMode[] = ['auto', 'plan', 'bypass', 'chat'];
export function nextMindMode(mode: MindMode): MindMode {
  const i = MIND_MODE_CYCLE.indexOf(mode);
  return MIND_MODE_CYCLE[(i + 1) % MIND_MODE_CYCLE.length] ?? 'plan';
}

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

// ── Ajustes (GET/PATCH /settings) ────────────────────────────────────────────────────────────

export const themeSchema = z.enum(['system', 'dark', 'light']);

/**
 * Topes de gasto de la mente (US$); `null` quita el tope. Van en su propia clave de primer nivel: una fila `mind` ya
 * guardada sigue validando y conserva mente, modelo y esfuerzo.
 */
export const mindLimitsSchema = z.strictObject({
  /** Lo que puede gastar un mensaje del usuario, con sus subagentes y los turnos que la mente siga sola tras él. */
  turnUsd: z.number().positive().max(100_000).nullable(),
  /** Lo que puede gastar la mente (con sus subagentes) en el día, sumando todos los chats. */
  dayUsd: z.number().positive().max(100_000).nullable(),
  /** Turnos seguidos que la mente abre sola (sin mensaje del usuario) antes de cortarse. */
  maxAutonomousTurns: z.number().int().min(1).max(100).nullable(),
});
export type MindLimits = z.infer<typeof mindLimitsSchema>;
export const DEFAULT_MIND_LIMITS: MindLimits = { turnUsd: 5, dayUsd: 50, maxAutonomousTurns: 5 };

export const settingsSchema = z.strictObject({
  mind: z.strictObject({
    /** Agente que hace de mente (orquestador). `null`: el primer agente `claude-sdk` habilitado. */
    agentId: idSchema.nullable(),
    /** Modelo de la mente; sin él, el del agente o el predeterminado del orquestador. */
    model: z.string().min(1).max(100).optional(),
    effort: effortSchema,
  }),
  mindLimits: mindLimitsSchema,
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
  mindLimits: DEFAULT_MIND_LIMITS,
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
  /** `null` en un campo quita ese tope. */
  mindLimits: z
    .strictObject({
      turnUsd: mindLimitsSchema.shape.turnUsd.optional(),
      dayUsd: mindLimitsSchema.shape.dayUsd.optional(),
      maxAutonomousTurns: mindLimitsSchema.shape.maxAutonomousTurns.optional(),
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

/** Mensaje del usuario que espera a que termine el turno en curso para enviarse (aún no está en el hilo). */
export const queuedChatMessageSchema = z.strictObject({
  id: opaqueIdSchema,
  text: z.string(),
  attachments: z.array(attachmentSchema),
  at: isoSchema,
});
export type QueuedChatMessage = z.infer<typeof queuedChatMessageSchema>;

export const chatSchema = z.strictObject({
  id: opaqueIdSchema,
  /** `null`: conversación sin proyecto (no delega a la flota). */
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
  /**
   * Mensajes que esperan a que termine el turno en curso (`delivery: 'after-turn'`), en el orden en que se enviarán.
   * Solo en memoria: falta si no hay ninguno.
   */
  queued: z.array(queuedChatMessageSchema).optional(),
  /**
   * La carpeta de trabajo es interna de Berland: una conversación sin proyecto que no eligió carpeta. La interfaz no la
   * muestra. Se calcula al leer; no se guarda.
   */
  internalFolder: z.literal(true).optional(),
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

/**
 * Cuándo entregar un mensaje si la mente está en un turno: `now` entra al turno en curso; `after-turn` espera en la
 * cola del chat a que el turno termine. Sin turno en curso, los dos se envían como siempre.
 */
export const messageDeliverySchema = z.enum(['now', 'after-turn']);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

export const createChatBody = z.strictObject({
  projectId: idSchema.nullable(),
  /** Por defecto, `repoPath` del proyecto; sin proyecto y sin `cwd`, una carpeta interna propia del chat. */
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
    effort: effortSchema.optional(),
    /** Con un turno en curso: sin `delivery`, 409 (como siempre); con él, el mensaje entra al turno o espera en cola. */
    delivery: messageDeliverySchema.optional(),
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

// ── Uso y gasto (GET /usage/summary, GET/PATCH /usage/rates; issue 5) ────────────────────────

const usageDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const tokenCountSchema = z.number().int().nonnegative();

/** `api`: se paga por la clave de API (con costo). `subscription`: Codex y agy, por cupo y sin costo. */
export const usageBillingSchema = z.enum(['api', 'subscription']);
export type UsageBilling = z.infer<typeof usageBillingSchema>;

/** Quién gastó: la mente, el autor o el revisor de una tarea, el planificador u otros (sin tarea ni chat). */
export const usageRoleSchema = z.enum(['mind', 'author', 'reviewer', 'planner', 'other']);
export type UsageRole = z.infer<typeof usageRoleSchema>;

/** Periodos fijos: hoy, hoy y los 6 días anteriores, y el mes calendario (del día 1 a hoy). */
export const usagePeriodSchema = z.enum(['today', 'week', 'month']);
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;

/** Tope del multiplicador de tarifa por modelo. */
export const MAX_USAGE_MULTIPLIER = 10;
/** Días como máximo de un rango de `GET /usage/summary`. */
export const MAX_USAGE_RANGE_DAYS = 366;

/** Suma de uso. Los tokens van separados: entrada nueva + caché escrita + caché leída + salida = total. */
export const usageBucketSchema = z.strictObject({
  /** Entrada nueva (sin lo leído ni lo escrito en caché). */
  inputTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  /** Parte de la salida que fue razonamiento (si el proveedor la informa). */
  reasoningTokens: tokenCountSchema,
  totalTokens: tokenCountSchema,
  /** Estimado con precios públicos (el costo que informó el SDK o el adaptador). 0 en suscripción. */
  costUsd: z.number().nonnegative(),
  /** `costUsd` × el multiplicador de tu tarifa de cada modelo. */
  costWithRateUsd: z.number().nonnegative(),
  /** Registros de uso sumados. */
  entries: tokenCountSchema,
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

export const usageSplitSchema = z.strictObject({ api: usageBucketSchema, subscription: usageBucketSchema });
export type UsageSplit = z.infer<typeof usageSplitSchema>;

export const usagePeriodTotalsSchema = z.strictObject({ from: usageDaySchema, to: usageDaySchema, api: usageBucketSchema, subscription: usageBucketSchema });

export const usageModelRowSchema = z.strictObject({
  ...usageBucketSchema.shape,
  billing: usageBillingSchema,
  /** `null`: el evento no informó el modelo. */
  model: z.string().nullable(),
  agentIds: z.array(z.string()),
  /** Multiplicador de tu tarifa (1 si no se cambió; siempre 1 en suscripción). */
  multiplier: z.number().positive(),
  /** Registros de API sin costo informado (suman 0). */
  withoutCost: tokenCountSchema,
});
export type UsageModelRow = z.infer<typeof usageModelRowSchema>;

export const usageDayRowSchema = z.strictObject({ day: usageDaySchema, api: usageBucketSchema, subscription: usageBucketSchema });
export const usageRoleRowSchema = z.strictObject({ role: usageRoleSchema, api: usageBucketSchema, subscription: usageBucketSchema });
export const usageProjectRowSchema = z.strictObject({
  /** `null`: sin proyecto (conversación, planificador o sesión sin tarea). */
  projectId: z.string().nullable(),
  name: z.string().nullable(),
  api: usageBucketSchema,
  subscription: usageBucketSchema,
});

/** Un agente de suscripción (Codex, agy): tokens del rango y su cupo, sin costo. */
export const usageSubscriptionRowSchema = z.strictObject({
  ...usageBucketSchema.shape,
  agentId: z.string(),
  displayName: z.string(),
  /** `null`: el agente ya no está registrado. */
  kind: z.string().nullable(),
  models: z.array(z.string()),
  /** Cupo restante más bajo de la última foto (0–1); `null` si no hay foto o no informa fracción. */
  quotaRemaining: z.number().min(0).max(1).nullable(),
  quotaTakenAt: isoSchema.nullable(),
  quotaStale: z.boolean(),
});
export type UsageSubscriptionRow = z.infer<typeof usageSubscriptionRowSchema>;

/** Calidad de los datos del rango (para las notas de la sección). */
export const usageCoverageSchema = z.strictObject({
  /** Registros de API anteriores al issue 5: no separan la caché escrita (va dentro de la entrada nueva). */
  withoutCacheWrite: tokenCountSchema,
  /** Registros de API sin costo informado. */
  withoutCost: tokenCountSchema,
  /** Registros de sesiones sin tarea, chat ni planificador (rol «otros»). */
  unlinked: tokenCountSchema,
});

/** `period` o `from`/`to` (días AAAA-MM-DD incluidos, en `tz`). Sin nada: el mes calendario. */
export const usageSummaryQuery = z.strictObject({
  period: usagePeriodSchema.optional(),
  from: usageDaySchema.optional(),
  to: usageDaySchema.optional(),
  /** Zona horaria IANA de los días (por defecto, la del núcleo). */
  tz: z.string().min(1).max(64).optional(),
});
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuery>;

export const usageSummaryResponse = z.strictObject({
  currency: z.literal('USD'),
  timeZone: z.string(),
  today: usageDaySchema,
  /** Periodo fijo pedido; `null` si se pidió un rango con `from`/`to`. */
  period: usagePeriodSchema.nullable(),
  from: usageDaySchema,
  to: usageDaySchema,
  /** Los tres periodos fijos, siempre relativos a `today`. */
  periods: z.strictObject({ today: usagePeriodTotalsSchema, week: usagePeriodTotalsSchema, month: usagePeriodTotalsSchema }),
  /** Totales del rango `from`–`to`. */
  totals: usageSplitSchema,
  byModel: z.array(usageModelRowSchema),
  /** Un elemento por día del rango, también los días sin uso. */
  byDay: z.array(usageDayRowSchema),
  byRole: z.array(usageRoleRowSchema),
  byProject: z.array(usageProjectRowSchema),
  subscriptions: z.array(usageSubscriptionRowSchema),
  coverage: usageCoverageSchema,
});
export type UsageSummary = z.infer<typeof usageSummaryResponse>;

const usageModelKeySchema = z.string().min(1).max(100);
const usageMultiplierSchema = z.number().positive().max(MAX_USAGE_MULTIPLIER);

/** Multiplicador de tu tarifa para un modelo (los modelos sin fila usan 1: precios públicos). */
export const usageRateSchema = z.strictObject({ model: z.string().min(1).max(100), multiplier: usageMultiplierSchema, updatedAt: isoSchema });
export type UsageRate = z.infer<typeof usageRateSchema>;
export const usageRatesResponse = z.strictObject({ rates: z.array(usageRateSchema) });
export type UsageRatesResponse = z.infer<typeof usageRatesResponse>;

/** Cambia multiplicadores por modelo; `null` borra el del modelo (vuelve a 1). */
export const patchUsageRatesBody = z.strictObject({
  rates: z
    .record(usageModelKeySchema, usageMultiplierSchema.nullable())
    .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 100, { message: 'De 1 a 100 modelos por cambio' }),
});
export type PatchUsageRatesBody = z.infer<typeof patchUsageRatesBody>;

// ── Almacenamiento (GET /storage y vaciado; issue 13) ────────────────────────────────────────

const byteCountSchema = z.number().int().nonnegative();

/** Cantidad de elementos y lo que ocupan en disco. */
export const storageAmountSchema = z.strictObject({ count: byteCountSchema, bytes: byteCountSchema });
export type StorageAmount = z.infer<typeof storageAmountSchema>;

/** Antigüedad mínima de lo que se vacía sin estar en uso (un adjunto sin enviar, una carpeta recién creada). */
export const STORAGE_GRACE_MS = 60 * 60 * 1000;
/** Tope de días de «chats de más de N días». */
export const MAX_STORAGE_OLDER_DAYS = 3650;

/** Copias de imágenes y archivos subidos (`<dataDir>/attachments`). Los registrados por ruta son tuyos: no cuentan. */
export const storageAttachmentsSchema = z.strictObject({
  dir: z.string(),
  total: storageAmountSchema,
  images: storageAmountSchema,
  others: storageAmountSchema,
  /** Sin ningún mensaje que las use (de chats borrados o nunca enviadas) y archivos sueltos sin registro. */
  orphans: storageAmountSchema,
  /** Adjuntos registrados por ruta: archivos tuyos que Berland no copia ni borra. */
  linkedFiles: byteCountSchema,
});

/** Chats con la mente dentro de la base: mensajes, propuestas, eventos y sesiones (también las de sus subagentes). */
export const storageChatsSchema = z.strictObject({
  chats: byteCountSchema,
  /** Chats que están respondiendo o con subagentes trabajando: no se borran. */
  busy: byteCountSchema,
  messages: byteCountSchema,
  events: byteCountSchema,
  sessions: byteCountSchema,
  /** Bytes aproximados de esas filas en la base (sin el historial de uso, que se conserva). */
  bytes: byteCountSchema,
  /** Restos de chats ya borrados: filas (mensajes, propuestas, eventos y sesiones) sin chat. */
  leftovers: storageAmountSchema,
  /** Última actividad del chat más antiguo; `null` sin chats. */
  oldestUpdatedAt: isoSchema.nullable(),
});

/** Carpetas internas de las conversaciones sin proyecto (`berland-conversaciones`, una por chat). */
export const storageConversationsSchema = z.strictObject({
  root: z.string(),
  exists: z.boolean(),
  /** `count`: carpetas. */
  total: storageAmountSchema,
  /** Carpetas cuyo chat ya no existe. */
  orphans: storageAmountSchema,
  /** El recorrido se cortó por tamaño: las cifras son un mínimo. */
  truncated: z.boolean(),
});

/** El archivo SQLite del núcleo. */
export const storageDatabaseSchema = z.strictObject({
  path: z.string(),
  fileBytes: byteCountSchema,
  walBytes: byteCountSchema,
  shmBytes: byteCountSchema,
  totalBytes: byteCountSchema,
  /** Páginas libres dentro del archivo: se recuperan al compactar. */
  freeBytes: byteCountSchema,
  /** Lo que ocupan los chats dentro de la base (aprox.; igual a `chats.bytes` + `chats.leftovers.bytes`). */
  chatBytes: byteCountSchema,
  /** Lo demás: historial de tareas de la flota, uso, ajustes… (no se vacía desde aquí). */
  otherBytes: byteCountSchema,
});

export const storageSummarySchema = z.strictObject({
  measuredAt: isoSchema,
  /** Lo que ocupa Berland en disco: adjuntos + carpetas de conversaciones + base. Los proyectos no cuentan. */
  totalBytes: byteCountSchema,
  attachments: storageAttachmentsSchema,
  chats: storageChatsSchema,
  conversations: storageConversationsSchema,
  database: storageDatabaseSchema,
});
export type StorageSummary = z.infer<typeof storageSummarySchema>;
export const storageResponse = z.strictObject({ storage: storageSummarySchema });

/** `orphans`: solo lo que ningún mensaje usa; `all`: todas las copias subidas (no las de chats en curso). */
export const storageCleanAttachmentsBody = z.strictObject({ scope: z.enum(['orphans', 'all']) });
export type StorageCleanAttachmentsBody = z.infer<typeof storageCleanAttachmentsBody>;

/**
 * `leftovers`: restos de chats ya borrados; `older`: chats sin actividad en `olderThanDays` días; `all`: todos los
 * chats. Nunca los que están respondiendo o con subagentes. `compact` (por defecto `true`): compacta la base al final.
 */
export const storageCleanChatsBody = z
  .strictObject({
    scope: z.enum(['leftovers', 'older', 'all']),
    olderThanDays: z.number().int().min(1).max(MAX_STORAGE_OLDER_DAYS).optional(),
    compact: z.boolean().optional(),
  })
  .refine((b) => b.scope !== 'older' || b.olderThanDays !== undefined, { message: 'Con scope «older» falta olderThanDays', path: ['olderThanDays'] });
export type StorageCleanChatsBody = z.infer<typeof storageCleanChatsBody>;

/** Solo las carpetas cuyo chat ya no existe (las de un chat vivo se borran con el chat). */
export const storageCleanConversationsBody = z.strictObject({ scope: z.literal('orphans') });
export type StorageCleanConversationsBody = z.infer<typeof storageCleanConversationsBody>;

export const storageTargetSchema = z.enum(['attachments', 'chats', 'conversations', 'database']);
export type StorageTarget = z.infer<typeof storageTargetSchema>;

export const storageCleanResultSchema = z.strictObject({
  target: storageTargetSchema,
  deleted: z.strictObject({
    chats: byteCountSchema,
    messages: byteCountSchema,
    events: byteCountSchema,
    sessions: byteCountSchema,
    /** Adjuntos (filas) borrados. */
    attachments: byteCountSchema,
    /** Archivos borrados del disco. */
    files: byteCountSchema,
    folders: byteCountSchema,
  }),
  /** Bytes liberados en disco (medidos antes y después). */
  freedBytes: byteCountSchema,
  /** Lo que no se borró y por qué (p. ej. un chat que está respondiendo). */
  skipped: z.array(z.strictObject({ id: z.string(), reason: z.string() })).max(200),
  /** Se compactó la base (checkpoint del WAL + VACUUM). */
  compacted: z.boolean(),
  warnings: z.array(z.string()).max(20),
});
export type StorageCleanResult = z.infer<typeof storageCleanResultSchema>;
export const storageCleanResponse = z.strictObject({ result: storageCleanResultSchema, storage: storageSummarySchema });
export type StorageCleanResponse = z.infer<typeof storageCleanResponse>;

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
