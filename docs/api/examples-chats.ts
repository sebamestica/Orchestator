/**
 * Datos de ejemplo de chats con la mente, adjuntos y plugins (F5: c15 y c16). Como los de `examples.ts`, cada uno se
 * valida contra el esquema de respuesta del servidor al generar (ver build.ts).
 */
import type { Attachment, ChangesTarget, Chat, ChatMessage, Plugin, Proposal } from '../../src/shared/index.ts';
import { DATA_DIR, ids, task1, task2 } from './examples.ts';

const T_CHAT = '2026-11-02T10:00:00.000Z';
const T_SENT = '2026-11-02T10:01:30.000Z';
const T_REPLY = '2026-11-02T10:02:10.000Z';
const T_APPROVE = '2026-11-02T10:05:00.000Z';

export const chatIds = {
  chat: 'chat-8f3a2c1d',
  attachment: 'adj-5b7e9d2a',
  plugin: 'chrome',
  queued: 'msg-9c8d7e6f',
} as const;

export const chat: Chat = {
  id: chatIds.chat,
  projectId: ids.project,
  title: 'Separar la API y la interfaz del tablero',
  cwd: 'C:\\dev\\Vetworld',
  extraRoots: [],
  mode: 'plan',
  mindAgentId: ids.agent,
  sessionId: `chat-${chatIds.chat}`,
  state: 'idle',
  costUsd: 0.042,
  createdAt: T_CHAT,
  updatedAt: T_REPLY,
};
export const chatAuto: Chat = { ...chat, mode: 'auto', updatedAt: T_APPROVE };
export const chatClosed: Chat = { ...chat, state: 'closed', updatedAt: T_APPROVE };

export const attachment: Attachment = {
  id: chatIds.attachment,
  name: 'captura.png',
  mime: 'image/png',
  size: 48213,
  path: `${DATA_DIR}\\attachments\\${chatIds.attachment}-captura.png`,
  kind: 'image',
  source: 'upload',
  createdAt: T_SENT,
};
export const attachmentByPath: Attachment = {
  id: 'adj-0c4e6f81',
  name: 'notas.md',
  mime: 'text/markdown',
  size: 2310,
  path: 'C:\\Users\\yo\\Desktop\\notas.md',
  kind: 'text',
  source: 'path',
  createdAt: T_SENT,
};

export const userMessage: ChatMessage = {
  id: 'msg-1a2b3c4d',
  chatId: chatIds.chat,
  role: 'user',
  text: 'Separa la API y la interfaz del tablero',
  attachments: [attachment],
  mode: 'plan',
  at: T_SENT,
};
export const assistantMessage: ChatMessage = {
  id: 'msg-5e6f7a8b',
  chatId: chatIds.chat,
  role: 'assistant',
  text: 'Propongo dos tareas: validar el formulario de citas y sus pruebas. Revísalas y apruébalas.',
  attachments: [],
  mode: 'plan',
  at: T_REPLY,
};

const proposal1: Proposal = { task: task1, approval: 'proposed', proposedAt: T_REPLY };
const proposal2: Proposal = { task: task2, approval: 'proposed', proposedAt: T_REPLY };
export const proposals: Proposal[] = [proposal1, proposal2];
export const approvedOne = { proposals: [{ ...proposal1, approval: 'delegated' }, proposal2], delivered: [ids.task], failed: [] };
export const approvedAll = {
  proposals: [{ ...proposal1, approval: 'delegated' }, { ...proposal2, approval: 'delegated' }],
  delivered: [ids.task, ids.task2],
  failed: [],
};
export const rejectedOne: Proposal[] = [{ ...proposal1, approval: 'rejected' }, proposal2];

export const chatTarget: ChangesTarget = { kind: 'local', path: 'C:\\dev\\Vetworld', git: 'remote', worktrees: true };

const T_PLUGIN = '2026-11-02T09:30:00.000Z';
export const chromePlugin: Plugin = {
  id: 'chrome',
  name: 'Chrome',
  description:
    'Tu Chrome personal, con tus sesiones y tu perfil, para los agentes (chrome-devtools-mcp). Es su único navegador: nunca abren otro. Uno a la vez: si otro agente lo está usando, el siguiente espera.',
  status: 'connected',
  detail: 'Chrome personal conectado (29 herramientas) · Depuración remota activa · Libre ahora',
  agents: [],
  steps: [],
  updatedAt: T_PLUGIN,
};
export const chromeDisconnected: Plugin = {
  ...chromePlugin,
  status: 'disconnected',
  detail: 'Desconectado: los agentes no reciben navegador (ni otro Chrome).',
  updatedAt: T_APPROVE,
};
export const canvaPlugin: Plugin = {
  id: 'canva',
  name: 'Canva',
  description: 'Tus diseños de Canva por el MCP oficial (mcp.canva.com), con tu cuenta (OAuth).',
  status: 'disconnected',
  agents: [],
  steps: ['Pulsa Conectar: se abre la página de Canva para iniciar sesión.', 'Acepta los permisos; al volver verás «Canva conectado» y podrás cerrar la pestaña.'],
  updatedAt: T_PLUGIN,
};
