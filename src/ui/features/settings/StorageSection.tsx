/**
 * Ajustes › Almacenamiento (issue 13): cuánto ocupa Berland en el disco y qué se puede vaciar. Una tarjeta por
 * categoría (imágenes y archivos subidos, chats, carpetas de conversaciones y la base), con el total arriba. Cada
 * «Vaciar» abre un diálogo que dice exactamente qué se borra, qué se conserva y que no se puede deshacer, y solo al
 * confirmar llama a `POST /storage/…`. Los proyectos no cuentan: son carpetas del usuario.
 */
import { Button, Modal, Spinner } from '@heroui/react';
import { Database, FolderOpen, Images, MessagesSquare, RefreshCw, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { storageCleanResponse, storageResponse, type StorageCleanResult, type StorageSummary } from '../../../shared/api.ts';
import { api } from '../../api/client.ts';
import { Panel } from '../../components/Card.tsx';
import { IconButton } from '../../components/IconButton.tsx';
import { errorText, Notice, Segmented } from './shared.tsx';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const count = new Intl.NumberFormat('es');

/** `0 B`, `512 B`, `1,5 KB`, `23 MB`, `1,2 GB` (base 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${UNITS[i]}`;
}

/** `1 chat`, `3 chats`. */
function plural(n: number, one: string, many: string): string {
  return `${count.format(n)} ${n === 1 ? one : many}`;
}

const OLDER_DAYS = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '180', label: '180 días' },
] as const;
type OlderDays = (typeof OLDER_DAYS)[number]['value'];

type ActionId = 'attachments-orphans' | 'attachments-all' | 'chats-leftovers' | 'chats-older' | 'chats-all' | 'conversations-orphans' | 'compact';

interface ActionSpec {
  title: string;
  confirmLabel: string;
  /** Qué se borra (una línea por cosa). */
  deletes: string[];
  /** Qué no se toca. */
  keeps: string[];
  /** Nota final (p. ej. que se compacta la base). */
  note?: string;
  destructive: boolean;
  path: string;
  body?: unknown;
}

const KEEP_ATTACHMENTS = ['Los adjuntos de chats que están respondiendo o con subagentes trabajando', 'Lo subido hace menos de 1 hora y aún sin enviar', 'Los archivos tuyos adjuntados por su ruta'];
const KEEP_CHATS = ['Los chats que están respondiendo o con subagentes trabajando', 'Las tareas ya entregadas a la flota (siguen en el tablero)', 'El historial de uso y gasto', 'Tus proyectos y sus carpetas'];

function actionFor(id: ActionId, s: StorageSummary, days: OlderDays): ActionSpec {
  const a = s.attachments;
  const c = s.chats;
  const v = s.conversations;
  switch (id) {
    case 'attachments-orphans':
      return {
        title: '¿Vaciar los adjuntos sin usar?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [`${plural(a.orphans.count, 'archivo', 'archivos')} (${formatBytes(a.orphans.bytes)}): copias de imágenes y archivos que ningún chat usa, de chats borrados o que nunca se enviaron`],
        keeps: ['Los adjuntos que usan tus chats', ...KEEP_ATTACHMENTS.slice(1)],
        path: '/storage/attachments/clean',
        body: { scope: 'orphans' },
      };
    case 'attachments-all':
      return {
        title: '¿Vaciar todas las imágenes y archivos subidos?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [
          `Las ${plural(a.total.count, 'copia subida', 'copias subidas')} (${formatBytes(a.total.bytes)}) de ${a.dir}`,
          'Los chats conservan su texto, pero sus imágenes y archivos dejan de verse',
        ],
        keeps: KEEP_ATTACHMENTS,
        path: '/storage/attachments/clean',
        body: { scope: 'all' },
      };
    case 'chats-leftovers':
      return {
        title: '¿Vaciar los restos de chats borrados?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [`${plural(c.leftovers.count, 'fila', 'filas')} (${formatBytes(c.leftovers.bytes)}): mensajes, eventos y sesiones de chats que ya borraste`],
        keeps: ['Tus chats', 'El historial de uso y gasto'],
        note: 'Al terminar se compacta la base para liberar el espacio.',
        path: '/storage/chats/clean',
        body: { scope: 'leftovers' },
      };
    case 'chats-older':
      return {
        title: '¿Vaciar los chats antiguos?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [
          `Los chats sin actividad en los últimos ${days} días, con sus mensajes, propuestas, eventos y sesiones (también las de sus subagentes)`,
          'Sus imágenes y archivos subidos y su carpeta de conversación, con lo que la mente creó en ella',
        ],
        keeps: KEEP_CHATS,
        note: 'Al terminar se compacta la base para liberar el espacio.',
        path: '/storage/chats/clean',
        body: { scope: 'older', olderThanDays: Number(days) },
      };
    case 'chats-all':
      return {
        title: '¿Vaciar todos los chats?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [
          `${plural(c.chats, 'chat', 'chats')} con sus ${plural(c.messages, 'mensaje', 'mensajes')}, propuestas, eventos y sesiones (también las de sus subagentes)`,
          'Sus imágenes y archivos subidos y sus carpetas de conversación, con lo que la mente creó en ellas',
        ],
        keeps: KEEP_CHATS,
        note: 'Al terminar se compacta la base para liberar el espacio.',
        path: '/storage/chats/clean',
        body: { scope: 'all' },
      };
    case 'conversations-orphans':
      return {
        title: '¿Vaciar las carpetas sin chat?',
        confirmLabel: 'Vaciar',
        destructive: true,
        deletes: [`${plural(v.orphans.count, 'carpeta', 'carpetas')} (${formatBytes(v.orphans.bytes)}) de ${v.root} cuyo chat ya no existe, con todo lo que tengan dentro`],
        keeps: ['Las carpetas de tus chats', 'Las creadas o cambiadas en la última hora', 'Tus proyectos, aunque estén dentro de esa carpeta', 'Lo que haya al otro lado de un acceso directo o enlace'],
        path: '/storage/conversations/clean',
        body: { scope: 'orphans' },
      };
    case 'compact':
      return {
        title: '¿Compactar la base?',
        confirmLabel: 'Compactar',
        destructive: false,
        deletes: [],
        keeps: [],
        note: `No borra datos: reescribe la base sin su espacio libre (${formatBytes(s.database.freeBytes)}) y vacía el registro de escritura (${formatBytes(s.database.walBytes)}). Con una base grande puede tardar unos segundos, y mientras tanto Berland no responde.`,
        path: '/storage/compact',
      };
  }
}

/** Resumen en una línea de lo que hizo una acción. */
export function resultText(r: StorageCleanResult): string {
  const d = r.deleted;
  const parts: string[] = [];
  if (r.target === 'chats') {
    if (d.chats) parts.push(`Se borraron ${plural(d.chats, 'chat', 'chats')}.`);
    else if (d.messages + d.events + d.sessions) parts.push(`Se borraron ${plural(d.messages + d.events + d.sessions, 'fila', 'filas')} de chats borrados.`);
    else parts.push('No había chats que borrar.');
  } else if (r.target === 'attachments') parts.push(d.files || d.attachments ? `Se borraron ${plural(Math.max(d.files, d.attachments), 'archivo', 'archivos')}.` : 'No había archivos que borrar.');
  else if (r.target === 'conversations') parts.push(d.folders ? `Se borraron ${plural(d.folders, 'carpeta', 'carpetas')}.` : 'No había carpetas que borrar.');
  else parts.push(r.compacted ? 'Base compactada.' : 'No se pudo compactar la base.');
  parts.push(`Se liberaron ${formatBytes(r.freedBytes)}.`);
  if (r.skipped.length) {
    const reasons = [...new Set(r.skipped.map((s) => s.reason))].slice(0, 3).join('; ');
    parts.push(`${plural(r.skipped.length, 'elemento quedó', 'elementos quedaron')} sin tocar (${reasons}).`);
  }
  return parts.join(' ');
}

type Load = { status: 'loading' } | { status: 'ready'; data: StorageSummary } | { status: 'error'; message: string };

export function StorageSection() {
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<ActionId | null>(null);
  const [days, setDays] = useState<OlderDays>('30');
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    api.get<unknown>('/storage').then(
      (r) => {
        if (!alive) return;
        const parsed = storageResponse.safeParse(r);
        setState(parsed.success ? { status: 'ready', data: parsed.data.storage } : { status: 'error', message: 'El núcleo devolvió el almacenamiento con un formato inesperado.' });
      },
      (err: unknown) => {
        if (alive) setState({ status: 'error', message: errorText(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [version]);

  const data = state.status === 'ready' ? state.data : null;
  const spec = data && open ? actionFor(open, data, days) : null;

  const ask = (id: ActionId) => {
    setDialogError(null);
    setOpen(id);
  };

  const confirm = async () => {
    if (!spec) return;
    setPending(true);
    setDialogError(null);
    try {
      const raw = await api.post<unknown>(spec.path, spec.body);
      const parsed = storageCleanResponse.safeParse(raw);
      if (!parsed.success) throw new Error('El núcleo respondió con un formato inesperado.');
      setState({ status: 'ready', data: parsed.data.storage });
      const r = parsed.data.result;
      setNotice({ tone: r.warnings.length ? 'error' : 'info', text: [resultText(r), ...r.warnings].join(' ') });
      setOpen(null);
    } catch (err) {
      setDialogError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {state.status === 'loading' ? (
        <span className="flex items-center gap-2 text-[0.8125rem] text-muted">
          <Spinner size="sm" /> Midiendo…
        </span>
      ) : null}
      {state.status === 'error' ? <Notice>{state.message}</Notice> : null}

      {data ? (
        <>
          <TotalPanel data={data} onReload={reload} />
          {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <AttachmentsCard data={data} onAsk={ask} disabled={pending} />
            <ChatsCard data={data} onAsk={ask} disabled={pending} />
            <ConversationsCard data={data} onAsk={ask} disabled={pending} />
            <DatabaseCard data={data} onAsk={ask} disabled={pending} />
          </div>
        </>
      ) : null}

      <CleanDialog
        spec={spec}
        isPending={pending}
        error={dialogError}
        onClose={() => {
          if (!pending) setOpen(null);
        }}
        onConfirm={() => void confirm()}
        extra={
          open === 'chats-older' ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] text-foreground">Sin actividad en</span>
              <Segmented label="Antigüedad de los chats" value={days} options={OLDER_DAYS} onChange={setDays} isDisabled={pending} />
            </div>
          ) : null
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------ total

function TotalPanel({ data, onReload }: { data: StorageSummary; onReload: () => void }) {
  const parts = [
    { label: 'Adjuntos', bytes: data.attachments.total.bytes },
    { label: 'Carpetas de conversaciones', bytes: data.conversations.total.bytes },
    { label: 'Base de datos', bytes: data.database.totalBytes },
  ];
  return (
    <Panel className="flex flex-wrap items-end justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[0.75rem] font-medium uppercase tracking-wide text-muted">Berland ocupa</span>
        <span className="text-[1.75rem] font-semibold tabular-nums tracking-tight text-foreground" data-testid="storage-total">
          {formatBytes(data.totalBytes)}
        </span>
        <span className="text-[0.8125rem] tabular-nums text-muted">{parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(' · ')}</span>
        <span className="text-[0.75rem] text-muted">Tus proyectos no cuentan: son carpetas tuyas y Berland nunca las vacía.</span>
      </div>
      <IconButton label="Volver a medir" size="sm" onClick={onReload}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
      </IconButton>
    </Panel>
  );
}

// ------------------------------------------------------------------ tarjetas

interface CardProps {
  data: StorageSummary;
  onAsk: (id: ActionId) => void;
  disabled: boolean;
}

function StorageCard({ icon: Icon, title, bytes, approx, testId, lines, children }: { icon: LucideIcon; title: string; bytes: number; approx?: boolean; testId: string; lines: ReactNode[]; children: ReactNode }) {
  return (
    <Panel className="flex h-full flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2 text-muted">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <h2 className="text-[0.875rem] font-medium text-foreground">{title}</h2>
      </div>
      <span className="text-[1.375rem] font-semibold tabular-nums tracking-tight text-foreground" data-testid={testId}>
        {approx ? '≈ ' : ''}
        {formatBytes(bytes)}
      </span>
      <ul className="flex flex-1 flex-col gap-1 text-[0.8125rem] text-muted">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">{children}</div>
    </Panel>
  );
}

function ActionButton({ label, onPress, isDisabled }: { label: string; onPress: () => void; isDisabled: boolean }) {
  return (
    <Button size="sm" variant="secondary" isDisabled={isDisabled} onPress={onPress}>
      {label}
    </Button>
  );
}

function AttachmentsCard({ data, onAsk, disabled }: CardProps) {
  const a = data.attachments;
  return (
    <StorageCard
      icon={Images}
      title="Imágenes y archivos subidos"
      bytes={a.total.bytes}
      testId="storage-attachments"
      lines={[
        `${plural(a.total.count, 'archivo', 'archivos')}: ${plural(a.images.count, 'imagen', 'imágenes')} (${formatBytes(a.images.bytes)}) y ${plural(a.others.count, 'otro', 'otros')} (${formatBytes(a.others.bytes)})`,
        `Sin usar: ${plural(a.orphans.count, 'archivo', 'archivos')} (${formatBytes(a.orphans.bytes)}), de chats borrados o nunca enviados`,
        ...(a.linkedFiles ? [`${plural(a.linkedFiles, 'archivo tuyo adjuntado', 'archivos tuyos adjuntados')} por su ruta: no cuentan ni se borran`] : []),
      ]}
    >
      <ActionButton label="Vaciar sin usar" isDisabled={disabled || a.orphans.count === 0} onPress={() => onAsk('attachments-orphans')} />
      <ActionButton label="Vaciar todo" isDisabled={disabled || a.total.count === 0} onPress={() => onAsk('attachments-all')} />
    </StorageCard>
  );
}

function ChatsCard({ data, onAsk, disabled }: CardProps) {
  const c = data.chats;
  return (
    <StorageCard
      icon={MessagesSquare}
      title="Chats"
      bytes={c.bytes}
      approx
      testId="storage-chats"
      lines={[
        `${plural(c.chats, 'chat', 'chats')} · ${plural(c.messages, 'mensaje', 'mensajes')} · ${plural(c.events, 'evento', 'eventos')}`,
        ...(c.busy ? [`${plural(c.busy, 'chat en curso', 'chats en curso')}: no se tocan`] : []),
        `Restos de chats borrados: ${formatBytes(c.leftovers.bytes)}`,
        'Viven dentro de la base de datos; el historial de uso se conserva siempre.',
      ]}
    >
      <ActionButton label="Vaciar restos" isDisabled={disabled || c.leftovers.count === 0} onPress={() => onAsk('chats-leftovers')} />
      <ActionButton label="Vaciar antiguos…" isDisabled={disabled || c.chats === 0} onPress={() => onAsk('chats-older')} />
      <ActionButton label="Vaciar todos" isDisabled={disabled || c.chats === 0} onPress={() => onAsk('chats-all')} />
    </StorageCard>
  );
}

function ConversationsCard({ data, onAsk, disabled }: CardProps) {
  const v = data.conversations;
  return (
    <StorageCard
      icon={FolderOpen}
      title="Carpetas de conversaciones"
      bytes={v.total.bytes}
      testId="storage-conversations"
      lines={[
        v.exists ? `${plural(v.total.count, 'carpeta', 'carpetas')}, una por chat sin proyecto` : 'Aún no hay carpetas de conversaciones',
        `Sin chat: ${plural(v.orphans.count, 'carpeta', 'carpetas')} (${formatBytes(v.orphans.bytes)})`,
        ...(v.truncated ? ['Hay muchísimos archivos: la cifra es un mínimo'] : []),
      ]}
    >
      <ActionButton label="Vaciar sin chat" isDisabled={disabled || v.orphans.count === 0} onPress={() => onAsk('conversations-orphans')} />
    </StorageCard>
  );
}

function DatabaseCard({ data, onAsk, disabled }: CardProps) {
  const d = data.database;
  return (
    <StorageCard
      icon={Database}
      title="Base de datos"
      bytes={d.totalBytes}
      testId="storage-database"
      lines={[
        `Chats ≈ ${formatBytes(d.chatBytes)} · Otros datos ${formatBytes(d.otherBytes)} (tareas de la flota, uso y ajustes; no se vacían aquí)`,
        `Espacio libre que se recupera al compactar: ${formatBytes(d.freeBytes + d.walBytes)}`,
      ]}
    >
      <ActionButton label="Compactar" isDisabled={disabled} onPress={() => onAsk('compact')} />
    </StorageCard>
  );
}

// ------------------------------------------------------------------ diálogo

function CleanDialog({ spec, isPending, error, onClose, onConfirm, extra }: { spec: ActionSpec | null; isPending: boolean; error: string | null; onClose: () => void; onConfirm: () => void; extra: ReactNode }) {
  return (
    <Modal.Backdrop
      isOpen={spec !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading className="break-words">{spec?.title ?? ''}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {spec ? (
              <div className="flex flex-col gap-4 text-[0.875rem]">
                {extra}
                {spec.deletes.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="font-medium text-foreground">Se borra</span>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
                      {spec.deletes.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {spec.keeps.length ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="font-medium text-foreground">No se toca</span>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
                      {spec.keeps.map((k) => (
                        <li key={k}>{k}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {spec.note ? <p className="text-muted">{spec.note}</p> : null}
                {spec.destructive ? <p className="font-medium text-danger">No se puede deshacer.</p> : null}
                {error ? <Notice>{error}</Notice> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" isDisabled={isPending} onPress={onClose}>
                    Cancelar
                  </Button>
                  <Button variant={spec.destructive ? 'danger' : 'primary'} isPending={isPending} onPress={onConfirm}>
                    {spec.confirmLabel}
                  </Button>
                </div>
              </div>
            ) : null}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
