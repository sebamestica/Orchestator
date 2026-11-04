import path from 'node:path';
import type { AgentEvent } from '../../../shared/index.ts';

type EventBody = AgentEvent extends infer E ? E extends AgentEvent ? Pick<E, 'type' | 'payload'> : never : never;

/** Expresa los cambios internos respecto al worktree; conserva las rutas externas y relativas. */
export function relativizeChange(event: EventBody, worktreePath: string): EventBody {
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(worktreePath) ? path.win32 : path;
  if (event.type !== 'file_change' || !paths.isAbsolute(event.payload.path)) return event;
  const rel = paths.relative(worktreePath, event.payload.path);
  if (!rel || rel.startsWith('..') || paths.isAbsolute(rel)) return event;
  return { ...event, payload: { ...event.payload, path: rel.split(paths.sep).join('/') } };
}
