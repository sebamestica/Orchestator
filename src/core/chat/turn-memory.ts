/**
 * Lo que la mente cambia ella misma en un turno (modo chat, o bypass con proyecto) como sesión de la memoria del
 * proyecto, para que la flota y los chats siguientes sepan qué tocó: los archivos de los `file_change` de la sesión
 * principal y de sus subagentes, si corrió comandos y el consumo del turno.
 */
import type { AgentEvent, SessionSummary } from '../../shared/index.ts';
import { CONDUCTOR_AGENT_ID } from '../conductor/index.ts';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SUMMARY_CHARS = 2_000;
const TITLE_CHARS = 200;
/** Ruta fuera del proyecto (carpetas extra del chat): el traductor la deja absoluta. */
const ABSOLUTE = /^(?:[a-zA-Z]:)?[\\/]/;

export const SHELL_NOTE = 'Además corrió comandos: los archivos que tocaron no se detectan.';
export const WORKTREES_NOTE = 'Los cambios quedaron sin commit en la carpeta del proyecto: no están en la rama de integración.';

export class TurnChanges {
  readonly files = new Set<string>();
  ranShell = false;
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;

  /** Suma un evento del turno (ya convertido en diferencias de uso). */
  note(event: AgentEvent): void {
    if (event.type === 'file_change') {
      if (!ABSOLUTE.test(event.payload.path)) this.files.add(event.payload.path);
    } else if (event.type === 'tool_call') {
      if (SHELL_TOOLS.has(event.payload.name)) this.ranShell = true;
    } else if (event.type === 'usage') {
      this.inputTokens += event.payload.inputTokens;
      this.outputTokens += event.payload.outputTokens;
      this.costUsd += event.payload.costUsd ?? 0;
    }
  }

  /** Sin archivos ni comandos: nada que anotar. */
  get empty(): boolean {
    return this.files.size === 0 && !this.ranShell;
  }
}

export interface TurnSessionInput {
  projectId: string;
  chatId: string;
  title: string;
  ok: boolean;
  /** Respuesta final del turno, ya tachada. */
  reply: string;
  /** El proyecto trabaja en worktrees: los cambios de la mente no están en la rama de integración. */
  worktrees: boolean;
  at: string;
}

export function turnSession(changes: TurnChanges, input: TurnSessionInput): SessionSummary {
  const notes = [changes.ranShell ? SHELL_NOTE : '', input.worktrees ? WORKTREES_NOTE : ''].filter(Boolean).join('\n');
  const room = Math.max(0, SUMMARY_CHARS - notes.length - 2);
  const summary = [input.reply.trim().slice(0, room), notes].filter(Boolean).join('\n\n');
  return {
    projectId: input.projectId,
    taskId: `chat-${input.chatId}`,
    agentId: CONDUCTOR_AGENT_ID,
    title: (input.title.trim() || 'Cambios de la mente').slice(0, TITLE_CHARS),
    outcome: input.ok ? 'ok' : 'failed',
    summary,
    filesChanged: [...changes.files],
    inputTokens: changes.inputTokens,
    outputTokens: changes.outputTokens,
    ...(changes.costUsd > 0 ? { costUsd: Math.round(changes.costUsd * 1e9) / 1e9 } : {}),
    at: input.at,
  };
}
