/**
 * Tipos de las respuestas del núcleo para la interfaz. Solo `import type` desde src/core: nada del
 * núcleo entra en el paquete de la interfaz (lo exige la regla de ESLint de src/ui).
 */
import type { z } from 'zod';
import type * as S from '../../core/server/schemas.ts';

export type AgentRecord = z.infer<typeof S.agentRecordSchema>;
export type ProjectRecord = z.infer<typeof S.projectRecordSchema>;
export type TaskRecord = z.infer<typeof S.taskRecordSchema>;
export type PlanRecord = z.infer<typeof S.planRecordSchema>;
export type SessionRecord = z.infer<typeof S.sessionRecordSchema>;
export type QuotaRecord = z.infer<typeof S.quotaRecordSchema>;
export type UsageRow = z.infer<typeof S.usageRowSchema>;
export type ProbeResponse = z.infer<typeof S.probeResponse>;
export type DetectResponse = z.infer<typeof S.detectResponse>;
export type EventsResponse = z.infer<typeof S.eventsResponse>;

export type {
  AgentEvent,
  Attachment,
  Chat,
  ChatMessage,
  DesktopBridge,
  FolderInspection,
  FsListResponse,
  MindCandidate,
  MindMode,
  Plugin,
  Proposal,
  Settings,
  SettingsPatch,
  TaskBrief,
  TaskState,
} from '../../shared/index.ts';
