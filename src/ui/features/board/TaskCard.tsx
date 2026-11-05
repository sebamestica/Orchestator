import { Button, Chip } from '@heroui/react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { lastActivity, retryTask, taskActionError } from '../../api/tasks.ts';
import type { TaskRecord } from '../../api/types.ts';
import { useApp } from '../../store/app.ts';
import { difficultyLabel, formatRelativeTime } from './types.ts';

interface TaskCardProps {
  task: TaskRecord;
  agentName?: string;
  onClick: () => void;
}

export function TaskCard({ task, agentName, onClick }: TaskCardProps) {
  const brief = task.task;
  const initial = (agentName || brief.suggestedAgent || task.agentId || '?').charAt(0).toUpperCase();
  const paths = brief.ownedPaths ?? [];
  const firstPaths = paths.slice(0, 2);
  const remainingPaths = paths.length - 2;
  const isHandedOff = task.state === 'handed_off';
  const isFailed = task.state === 'failed';
  const refreshTasks = useApp((s) => s.refreshTasks);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const activity = lastActivity(task);

  const handleRetry = async () => {
    try {
      setRetrying(true);
      setRetryError(null);
      await retryTask(brief.id);
      void refreshTasks();
    } catch (err) {
      setRetryError(taskActionError('al reintentar la tarea', err));
    } finally {
      setRetrying(false);
    }
  };

  const diffColor: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
    low: 'success',
    medium: 'warning',
    high: 'danger',
  };

  return (
    <div
      className={`group relative flex flex-col rounded-xl border bg-foreground/[0.045] text-left shadow-sm transition-colors duration-quick hover:bg-foreground/[0.08] ${
        isFailed ? 'border-danger/25 hover:border-danger/40' : 'border-foreground/[0.06] hover:border-foreground/[0.14]'
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`Tarea ${brief.id}: ${brief.title}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className="flex flex-col gap-2 rounded-xl p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground cursor-pointer"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-muted truncate">{brief.id}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isHandedOff && (
              <Chip size="sm" variant="soft" color="warning" className="text-[10px] font-medium h-5 px-1.5">
                Traspasada
              </Chip>
            )}
            <Chip
              size="sm"
              variant="soft"
              color={diffColor[brief.difficulty] ?? 'default'}
              className="text-[10px] font-medium h-5 px-1.5"
            >
              {difficultyLabel(brief.difficulty)}
            </Chip>
          </div>
        </div>

        <h3 className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug group-hover:text-foreground">
          {brief.title}
        </h3>

        {firstPaths.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {firstPaths.map((p) => (
              <span
                key={p}
                className="max-w-[130px] truncate rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-muted"
                title={p}
              >
                {p}
              </span>
            ))}
            {remainingPaths > 0 && (
              <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-muted">
                +{remainingPaths}
              </span>
            )}
          </div>
        )}

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-foreground/[0.04] pt-2 text-xs text-muted">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-medium text-foreground uppercase"
              aria-hidden="true"
            >
              {initial}
            </span>
            <span className="truncate text-[11px] text-muted max-w-[90px]">
              {agentName || 'Sin asignar'}
            </span>
          </div>
          <span
            className="shrink-0 text-[11px] text-muted"
            title={task.lastEventAt ? `Último evento de sus agentes: ${new Date(task.lastEventAt).toLocaleString()}` : undefined}
          >
            {formatRelativeTime(activity)}
          </span>
        </div>
      </div>

      {isFailed && (
        <div className="flex flex-col gap-2 border-t border-danger/15 px-3 pb-3 pt-2">
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-danger" title={task.detail ?? undefined}>
            <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-3 break-words">{task.detail || 'Falló sin motivo guardado.'}</span>
          </p>
          {retryError && (
            <p role="alert" className="text-[11px] leading-snug text-danger break-words">
              {retryError}
            </p>
          )}
          <Button
            variant="secondary"
            size="sm"
            isDisabled={retrying}
            onPress={() => void handleRetry()}
            aria-label={`Reintentar tarea ${brief.id}`}
            className="self-start"
          >
            <RefreshCw className="size-3.5 mr-1.5" aria-hidden="true" />
            {retrying ? 'Reintentando…' : 'Reintentar'}
          </Button>
        </div>
      )}
    </div>
  );
}
