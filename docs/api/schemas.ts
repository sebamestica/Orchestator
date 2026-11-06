/**
 * Componentes de OpenAPI y descripciones de la documentación.
 *
 * Los esquemas son los del servidor (`apiSchemas` de src/core/server/schemas.ts, que a su vez usan los
 * contratos de src/shared). Aquí solo se les da un id de componente y descripciones; nada se copia,
 * salvo `wsServerMessageSchema`, porque `HubMessage` es solo un tipo TypeScript en el servidor (se
 * comprueba en compilación que ambos coinciden).
 */
import { z } from 'zod';
import {
  approvalResponse,
  attachmentResponse,
  chatResponse,
  chatsResponse,
  messageResponse,
  messagesResponse,
  proposalsResponse,
} from '../../src/core/chat/index.ts';
import { pluginResponse, pluginsResponse } from '../../src/core/plugins/index.ts';
import { addAgentFromKeySchema, agentInputSchema } from '../../src/core/registry/index.ts';
import { apiSchemas as s, clientMessageSchema, type HubMessage } from '../../src/core/server/index.ts';
import {
  attachmentSchema,
  agentConfigSchema,
  agentEventSchema,
  changesTargetSchema,
  chatMessageSchema,
  chatSchema,
  pluginSchema,
  proposalSchema,
  settingsSchema,
  agentKindSchema,
  errorCodeSchema,
  idSchema,
  probeResultSchema,
  providerSchema,
  quotaBucketSchema,
  quotaMethodSchema,
  quotaSnapshotSchema,
  sessionStateSchema,
  taskBriefSchema,
  taskStateSchema,
  usageSchema,
  patchUsageRatesBody,
  usageBucketSchema,
  usageRateSchema,
  usageRatesResponse,
  usageSummaryResponse,
} from '../../src/shared/index.ts';

// -------------------------------------------------------------------------- WebSocket

/** Mensajes del servidor por `/ws`: forma Zod del tipo `HubMessage` (src/core/server/hub.ts). */
export const wsServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), serverTime: z.iso.datetime(), version: z.string() }),
  z.strictObject({ type: z.literal('event'), event: agentEventSchema }),
  z.strictObject({ type: z.literal('quota'), quota: s.quotaRecordSchema }),
  z.strictObject({ type: z.literal('task'), task: s.taskRecordSchema }),
  z.strictObject({ type: z.literal('agent'), agent: s.agentRecordSchema }),
  z.strictObject({ type: z.literal('agent_deleted'), agentId: z.string() }),
  z.strictObject({
    type: z.literal('replay'),
    sessionId: z.string(),
    events: z.array(agentEventSchema),
    lastSeq: z.number().int().min(-1),
    hasMore: z.boolean(),
  }),
  z.strictObject({ type: z.literal('pong') }),
  z.strictObject({ type: z.literal('error'), error: z.strictObject({ code: z.string(), message: z.string() }) }),
  z.strictObject({ type: z.literal('settings'), settings: settingsSchema }),
  z.strictObject({ type: z.literal('chat'), chat: chatSchema }),
  z.strictObject({ type: z.literal('chat_message'), message: chatMessageSchema }),
  z.strictObject({ type: z.literal('chat_deleted'), chatId: z.string() }),
  z.strictObject({ type: z.literal('proposals'), chatId: z.string(), proposals: z.array(proposalSchema) }),
  z.strictObject({ type: z.literal('plugin'), plugin: pluginSchema }),
  z.strictObject({ type: z.literal('chat_target'), chatId: z.string(), target: changesTargetSchema }),
]);
/** Mensajes del cliente por `/ws`: el esquema real del servidor. */
export const wsClientMessageSchema = clientMessageSchema;

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Falla al compilar si `HubMessage` cambia y `wsServerMessageSchema` no. */
export type WsServerMessageMatchesHub = Assert<Same<z.infer<typeof wsServerMessageSchema>, HubMessage>>;

// ------------------------------------------------------------------- componentes

export interface ComponentMeta {
  id: string;
}

/**
 * Componentes de respuesta (`io: "output"`: los campos con valor por defecto siempre vienen).
 * Cada esquema registrado se publica en `components.schemas` y se referencia con `$ref`.
 */
export const outputComponents = z.registry<ComponentMeta>();
/** Componentes de petición (`io: "input"`: los campos con valor por defecto son opcionales). */
export const inputComponents = z.registry<ComponentMeta>();

for (const [schema, id] of [
  [agentKindSchema, 'AgentKind'],
  [providerSchema, 'Provider'],
] as const) {
  outputComponents.add(schema, { id });
  inputComponents.add(schema, { id });
}

const outputs: readonly [z.ZodType, string][] = [
  // Contratos de src/shared
  [quotaMethodSchema, 'QuotaMethod'],
  [agentConfigSchema, 'AgentConfig'],
  [probeResultSchema, 'ProbeResult'],
  [sessionStateSchema, 'SessionState'],
  [errorCodeSchema, 'AgentErrorCode'],
  [usageSchema, 'Usage'],
  [agentEventSchema, 'AgentEvent'],
  [quotaBucketSchema, 'QuotaBucket'],
  [quotaSnapshotSchema, 'QuotaSnapshot'],
  [taskBriefSchema, 'TaskBrief'],
  [taskStateSchema, 'TaskState'],
  // Respuestas del servidor
  [s.errorResponse, 'ErrorResponse'],
  [s.healthResponse, 'HealthResponse'],
  [s.agentRecordSchema, 'AgentRecord'],
  [s.agentsResponse, 'AgentsResponse'],
  [s.agentResponse, 'AgentResponse'],
  [s.probeResponse, 'ProbeResponse'],
  [s.addAgentResponse, 'AddAgentResponse'],
  [s.detectedCliSchema, 'DetectedCli'],
  [s.detectResponse, 'DetectResponse'],
  [s.deletedResponse, 'DeletedResponse'],
  [s.quotaRecordSchema, 'QuotaRecord'],
  [s.quotasResponse, 'QuotasResponse'],
  [s.refreshQuotasResponse, 'RefreshQuotasResponse'],
  [s.projectRecordSchema, 'ProjectRecord'],
  [s.projectsResponse, 'ProjectsResponse'],
  [s.projectResponse, 'ProjectResponse'],
  [s.taskRecordSchema, 'TaskRecord'],
  [s.planRecordSchema, 'PlanRecord'],
  [s.planResponse, 'PlanResponse'],
  [s.tasksResponse, 'TasksResponse'],
  [s.taskResponse, 'TaskResponse'],
  [s.sessionRecordSchema, 'SessionRecord'],
  [s.sessionsResponse, 'SessionsResponse'],
  [s.sessionResponse, 'SessionResponse'],
  [s.eventsResponse, 'EventsResponse'],
  [s.usageRowSchema, 'UsageRow'],
  [s.usageResponse, 'UsageResponse'],
  [usageBucketSchema, 'UsageBucket'],
  [usageSummaryResponse, 'UsageSummary'],
  [usageRateSchema, 'UsageRate'],
  [usageRatesResponse, 'UsageRatesResponse'],
  [s.skillsResponse, 'SkillsResponse'],
  [s.skillResultResponse, 'SkillResultResponse'],
  [s.memoryContextResponse, 'MemoryContextResponse'],
  // Chats, adjuntos y plugins (F5)
  [chatSchema, 'Chat'],
  [chatMessageSchema, 'ChatMessage'],
  [proposalSchema, 'Proposal'],
  [attachmentSchema, 'Attachment'],
  [pluginSchema, 'Plugin'],
  [chatResponse, 'ChatResponse'],
  [chatsResponse, 'ChatsResponse'],
  [messageResponse, 'ChatMessageResponse'],
  [messagesResponse, 'ChatMessagesResponse'],
  [proposalsResponse, 'ProposalsResponse'],
  [approvalResponse, 'ProposalApprovalResponse'],
  [attachmentResponse, 'AttachmentResponse'],
  [pluginResponse, 'PluginResponse'],
  [pluginsResponse, 'PluginsResponse'],
  [wsServerMessageSchema, 'WsServerMessage'],
];
for (const [schema, id] of outputs) outputComponents.add(schema, { id });

const inputs: readonly [z.ZodType, string][] = [
  [s.taskBody, 'TaskBriefInput'],
  [addAgentFromKeySchema, 'AddAgentFromKeyRequest'],
  [agentInputSchema, 'AgentInput'],
  [s.addAgentBody, 'AddAgentRequest'],
  [s.patchAgentBody, 'PatchAgentRequest'],
  [s.refreshQuotasBody, 'RefreshQuotasRequest'],
  [s.projectBody, 'ProjectInput'],
  [s.planBody, 'PlanRequest'],
  [s.approveTaskBody, 'ApproveTaskRequest'],
  [s.cancelTaskBody, 'CancelTaskRequest'],
  [s.importSkillBody, 'ImportSkillRequest'],
  [patchUsageRatesBody, 'PatchUsageRatesRequest'],
  [wsClientMessageSchema, 'WsClientMessage'],
];
for (const [schema, id] of inputs) inputComponents.add(schema, { id });

/** Descripción de cada componente (los esquemas del servidor y de src/shared no llevan metadatos). */
export const componentDescriptions: Readonly<Record<string, string>> = {
  AgentKind: 'Tipo de agente (src/shared/agents.ts).',
  Provider: 'Proveedor del agente (src/shared/agents.ts).',
  QuotaMethod: 'Cómo se mide el cupo del agente (src/shared/agents.ts).',
  AgentConfig: 'Configuración persistida de un agente (src/shared/agents.ts). Nunca contiene la clave: solo `secretRef`, el id en la bóveda.',
  ProbeResult: 'Resultado de probar un agente: instalación, sesión, modelos y método de cupo (src/shared/agents.ts).',
  SessionState: 'Estado de una sesión de agente (src/shared/events.ts).',
  AgentErrorCode: 'Código de error de un evento `error` (src/shared/events.ts). Distinto de los códigos de error HTTP.',
  Usage: 'Consumo de tokens y costo (src/shared/events.ts).',
  AgentEvent: 'Evento normalizado de un agente (src/shared/events.ts); `type` decide la forma de `payload`.',
  QuotaBucket: 'Una ventana de cupo de un grupo de modelos (src/shared/quota.ts).',
  QuotaSnapshot: 'Foto del cupo de un agente (src/shared/quota.ts).',
  TaskBrief: 'Encargo de una tarea (src/shared/tasks.ts).',
  TaskBriefInput: 'Encargo de una tarea al crearla (src/shared/tasks.ts); `contextRefs` y `skillRefs` son opcionales.',
  TaskState: 'Estado de una tarea (src/shared/tasks.ts).',
  ErrorResponse: 'Error de la API: `{error:{code,message}}`, más `warnings` o `issues` en 422.',
  AgentRecord: 'Agente registrado: configuración, método de cupo y última prueba.',
  AddAgentFromKeyRequest: 'Alta con clave de API: se guarda en la bóveda, se prueba el agente y se registra su método de cupo.',
  AgentInput: 'Alta manual sin clave (CLIs detectados o configurados a mano).',
  AddAgentRequest: 'Con `apiKey` (va a la bóveda y se prueba) o configuración sin clave (CLI).',
  PatchAgentRequest: 'Cambios sobre un agente existente (al menos un campo). `null` borra un campo opcional.',
  QuotaRecord: 'Foto de cupo guardada.',
  UsageBucket: 'Suma de uso: entrada nueva, caché escrita, caché leída y salida (total = las cuatro), costo estimado con precios públicos y con tu tarifa, en USD.',
  UsageSummary: 'Resumen de uso y gasto (issue 5): periodos fijos (hoy, 7 días, mes calendario) y el rango pedido por modelo, día, rol y proyecto. Codex y agy van como suscripción, sin costo.',
  UsageRate: 'Multiplicador de tu tarifa para un modelo sobre los precios públicos (un modelo sin fila vale 1).',
  PatchUsageRatesRequest: 'Multiplicador por modelo (0–10); `null` lo borra y el modelo vuelve a 1.',
  Chat: 'Chat con la mente (src/shared/api.ts). Sus eventos llegan por `/ws` con `sessionId`.',
  ChatMessage: 'Mensaje de un chat, del usuario o de la mente (src/shared/api.ts).',
  Proposal: 'Tarea propuesta por la mente y su aprobación (src/shared/api.ts).',
  Attachment: 'Adjunto de un mensaje: copia subida o archivo local referido por ruta (src/shared/api.ts).',
  Plugin: 'Plugin de los agentes (Chrome o Canva) y su estado (src/shared/api.ts). Nunca trae un token.',
  ProposalApprovalResponse: 'Propuestas tras aprobar: `delivered`, las que la flota aceptó; `failed`, las aprobadas que no se entregaron.',
  WsServerMessage: 'Mensaje que el servidor envía por `/ws`.',
  WsClientMessage: 'Mensaje que el cliente envía por `/ws`.',
};

// ------------------------------------------------------- descripciones de campos

/**
 * Metadatos que lee `z.toJSONSchema` (en lugar del registro global). Solo se describen instancias
 * propias de un campo (`x.optional()`, cadenas encadenadas): describir un esquema compartido, como
 * `idSchema`, lo describiría en todas partes.
 */
export const docsMetadata = z.registry<{ description: string }>();

function describeField(schema: z.ZodType, description: string): void {
  if (schema === idSchema || outputComponents.has(schema) || inputComponents.has(schema)) {
    throw new Error(`No describas un esquema compartido: ${description}`);
  }
  docsMetadata.add(schema, { description });
}

const k = addAgentFromKeySchema.shape;
describeField(k.apiKey, 'Clave del proveedor. Va a la bóveda (DPAPI) y nunca vuelve en una respuesta.');
describeField(k.baseUrl, 'URL base del proveedor (obligatoria con `openai-compatible`).');
describeField(k.id, 'Si falta, se deriva de `displayName`.');
describeField(k.kind, 'Solo con `anthropic`: `claude-sdk` (agente con herramientas, por defecto) o `api` (chat).');
describeField(s.projectBody.shape.repoPath, 'Ruta local del repositorio (Windows).');
describeField(
  s.projectBody.shape.workspace,
  'Worktrees de la flota: la misma configuración de `compose({ workspaceProjects })` sin `id` ni `repoPath`. `gate` es obligatorio: sin él la flota no crea ni integra tareas del proyecto. Receta de Vetworld: docs/proyectos/vetworld.md.',
);
describeField(s.quotasQuery.shape.agentId, 'Solo la foto de este agente.');
describeField(s.refreshQuotasBody.shape.agentId, 'Solo este agente (aunque esté deshabilitado).');
describeField(s.planBody.shape.text, 'Plan en texto libre; el planificador (Claude) lo convierte en tareas.');
describeField(s.approveTaskBody.shape.agentId, 'Fija el agente que ejecutará la tarea.');
describeField(s.sessionsQuery.shape.parentSessionId, 'Subagentes de esta sesión.');
describeField(s.eventsQuery.shape.since, 'Último `seq` recibido: devuelve los eventos con `seq` mayor (−1 o ausente: desde el principio).');
describeField(s.eventsQuery.shape.limit, 'Máximo de eventos (500 por defecto).');
describeField(s.usageQuery.shape.groupBy, 'Lista separada por comas: `agent`, `day`, `session`, `model`. Sin agrupar: total general.');
describeField(s.usageQuery.shape.from, 'Día inicial (AAAA-MM-DD, zona horaria del núcleo).');
describeField(s.usageQuery.shape.to, 'Día final (AAAA-MM-DD, incluido).');
describeField(s.importSkillBody.shape.source, 'Carpeta o `.zip` local a poner en cuarentena.');
describeField(s.memoryQuery.shape.taskId, 'Extracto pertinente para esta tarea (si falta, contexto general del proyecto).');
describeField(s.memoryQuery.shape.budget, 'Presupuesto en caracteres (4000 por defecto).');
describeField(s.eventsResponse.shape.lastSeq, '`seq` del último evento devuelto (o el `since` pedido si no hay nuevos): úsalo en la siguiente llamada.');
describeField(s.errorResponse.shape.error.shape.message, 'Mensaje en español, tachado con `redactSecrets`; nunca repite datos de la entrada.');
describeField(s.skillsResponse.shape.skills, 'Lista de `SkillEntry` del hub de skills (src/core/skills/hub.ts), tachada.');
describeField(
  s.skillResultResponse.shape.result,
  'Resultado del hub de skills, tachado: informe de revisión `QuarantinedSkill` (import), entrada de `skills.lock.json` (approve) o id de cuarentena descartado (reject).',
);
