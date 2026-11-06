import { Button, Chip, Label, ListBox, ListBoxItem, Select } from '@heroui/react';
import { Kanban, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { lastActivity } from '../../api/tasks.ts';
import type { TaskRecord } from '../../api/types.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { navigate } from '../../app/routes.ts';
import { useApp } from '../../store/app.ts';
import { ManualTaskDialog } from './ManualTaskDialog.tsx';
import { TaskCard } from './TaskCard.tsx';
import { TaskDetailModal } from './TaskDetailModal.tsx';
import { BOARD_COLUMNS, taskMatchesColumn } from './types.ts';

export interface BoardViewProps {
  projectId?: string;
  /** Llega con `#/tablero?nueva`: abre el diálogo de tarea a mano al entrar. */
  openManual?: boolean;
}

const MAX_TASKS_PER_COLUMN = 100;

/** Lo último que se movió va arriba, así el tope de la columna recorta lo más viejo y no lo más nuevo. */
function newestActivityFirst(a: TaskRecord, b: TaskRecord): number {
  return Date.parse(lastActivity(b)) - Date.parse(lastActivity(a));
}

export default function BoardView({ projectId: fixedProjectId, openManual = false }: BoardViewProps) {
  const rawTasks = useApp((s) => s.tasks);
  const projects = useApp((s) => s.projects);
  const agents = useApp((s) => s.agents);
  const refreshTasks = useApp((s) => s.refreshTasks);

  // Filtro libre del Tablero general. No se siembra con la prop: si lo hiciera, al pasar de #/tablero/<id> a
  // #/tablero (misma instancia) el general quedaría filtrado por el proyecto anterior.
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [tasksList, setTasksList] = useState<TaskRecord[]>(() => Object.values(rawTasks));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);

  // La orden `?nueva` se consume al abrir: se quita de la barra para que recargar o ir atrás no reabra el diálogo.
  // Va en un efecto (no solo en el estado inicial) porque pasar de `#/tablero` a `#/tablero?nueva` no remonta la vista.
  useEffect(() => {
    if (!openManual) return;
    setManualDialogOpen(true);
    navigate({ name: 'board', ...(fixedProjectId ? { projectId: fixedProjectId } : {}) }, { replace: true });
  }, [openManual, fixedProjectId]);

  // Agrupar actualizaciones en vivo por cuadro (requestAnimationFrame) para no sobrecargar la CPU.
  useEffect(() => {
    let handle: number;
    if (typeof requestAnimationFrame === 'function') {
      handle = requestAnimationFrame(() => {
        setTasksList(Object.values(rawTasks));
      });
      return () => cancelAnimationFrame(handle);
    }
    setTasksList(Object.values(rawTasks));
    return undefined;
  }, [rawTasks]);

  const effectiveProjectId = fixedProjectId ?? selectedProjectId;

  const filteredTasks = useMemo(() => {
    if (effectiveProjectId === 'all') return tasksList;
    return tasksList.filter((t) => t.task.projectId === effectiveProjectId);
  }, [tasksList, effectiveProjectId]);

  const columns = useMemo(
    () =>
      BOARD_COLUMNS.map((col) => ({
        col,
        tasks: filteredTasks.filter((t) => taskMatchesColumn(t, col)).sort(newestActivityFirst),
      })),
    [filteredTasks],
  );

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasksList.find((t) => t.task.id === selectedTaskId) ?? null;
  }, [tasksList, selectedTaskId]);

  const agentNamesMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      map.set(a.config.id, a.config.displayName);
    }
    return map;
  }, [agents]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--canvas)]">
      {/* Encabezado del Tablero */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-foreground/[0.06] bg-[var(--surface)] px-6 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Kanban className="size-5 text-muted" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Tablero</h1>
          </div>

          {/* Filtro por proyecto */}
          <div className="w-56">
            <Select
              aria-label="Filtrar por proyecto"
              selectedKey={effectiveProjectId}
              isDisabled={Boolean(fixedProjectId)}
              onSelectionChange={(key) => {
                if (key !== null) setSelectedProjectId(String(key));
              }}
              fullWidth
            >
              <Label className="sr-only">Filtrar por proyecto</Label>
              <Select.Trigger aria-label="Elegir proyecto para filtrar">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="p-1">
                  <ListBoxItem id="all" textValue="Todos los proyectos">
                    Todos los proyectos
                  </ListBoxItem>
                  {projects.map((p) => (
                    <ListBoxItem key={p.id} id={p.id} textValue={p.name}>
                      {p.name}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
        </div>

        <div>
          <Button
            variant="primary"
            size="sm"
            onPress={() => setManualDialogOpen(true)}
            aria-label="Abrir diálogo de tarea a mano"
          >
            <Plus className="size-4 mr-1.5" aria-hidden="true" />
            Tarea a mano
          </Button>
        </div>
      </header>

      {/* Contenido principal: columnas o estado vacío */}
      {filteredTasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={Kanban}
            title="No hay tareas"
            description={
              effectiveProjectId === 'all'
                ? 'No hay ninguna tarea registrada en el tablero.'
                : 'No se encontraron tareas para el proyecto seleccionado.'
            }
            action={
              <Button
                variant="primary"
                size="sm"
                onPress={() => setManualDialogOpen(true)}
                aria-label="Crear primera tarea a mano"
              >
                <Plus className="size-4 mr-1.5" aria-hidden="true" />
                Tarea a mano
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto p-6 items-start min-h-0">
          {columns.map(({ col, tasks: columnTasks }) => {
            const count = columnTasks.length;
            const visibleTasks = columnTasks.slice(0, MAX_TASKS_PER_COLUMN);
            const hiddenCount = count - visibleTasks.length;

            return (
              <section
                key={col.key}
                aria-label={`Columna ${col.title}`}
                className="flex flex-col flex-shrink-0 w-72 rounded-2xl border border-foreground/[0.06] bg-[var(--dashboard-surface)] p-3 max-h-full shadow-sm"
              >
                {/* Cabecera de columna */}
                <div className="flex items-center justify-between mb-3 px-1">
                  <h2 className="text-xs font-semibold tracking-wider uppercase text-muted">
                    {col.title}
                  </h2>
                  <Chip
                    size="sm"
                    variant="soft"
                    className="h-5 px-1.5 text-[11px] font-mono text-muted"
                  >
                    {count}
                  </Chip>
                </div>

                {/* Tarjetas de columna */}
                <div className="flex flex-col gap-2.5 overflow-y-auto max-h-[calc(100vh-14rem)] pr-0.5">
                  {visibleTasks.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-foreground/[0.08] p-4 text-center text-xs text-muted">
                      Sin tareas
                    </div>
                  ) : (
                    visibleTasks.map((t) => {
                      const agentId = t.agentId || t.task.suggestedAgent;
                      const agentName = agentId ? agentNamesMap.get(agentId) : undefined;
                      return (
                        <TaskCard
                          key={t.task.id}
                          task={t}
                          agentName={agentName}
                          onClick={() => setSelectedTaskId(t.task.id)}
                        />
                      );
                    })
                  )}
                  {hiddenCount > 0 && (
                    <div className="text-center text-[11px] text-muted py-1.5">
                      +{hiddenCount} tareas más
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Modal de detalle de tarea: una instancia por tarea abierta (agente elegido, aviso y envío no pasan a otra). */}
      {selectedTask && (
        <TaskDetailModal
          key={selectedTask.task.id}
          task={selectedTask}
          isOpen
          onClose={() => setSelectedTaskId(null)}
          agents={agents}
          onTaskUpdated={() => {
            void refreshTasks();
          }}
        />
      )}

      {/* Diálogo de tarea manual */}
      <ManualTaskDialog
        isOpen={manualDialogOpen}
        onClose={() => setManualDialogOpen(false)}
        projects={projects}
        agents={agents}
        defaultProjectId={fixedProjectId || (selectedProjectId !== 'all' ? selectedProjectId : undefined)}
        onCreated={() => {
          void refreshTasks();
        }}
      />
    </div>
  );
}
