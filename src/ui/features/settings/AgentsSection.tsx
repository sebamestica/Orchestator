import { Button, Chip, Input, Label, Switch } from '@heroui/react';
import { KeyRound, Play, ScanSearch, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.ts';
import type { AgentRecord } from '../../api/types.ts';
import { IconButton } from '../../components/IconButton.tsx';
import { useApp } from '../../store/app.ts';
import { AddAgentDialog } from './AddAgentDialog.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { agentResponse, detectResponse, parseResponse, probeResponse } from './schemas.ts';
import { dropAgent, errorText, KIND_LABEL, Notice, putAgent, SettingsCard } from './shared.tsx';

export function AgentsSection() {
  const agents = useApp((s) => s.agents);
  const sorted = useMemo(() => [...agents].sort((a, b) => a.config.displayName.localeCompare(b.config.displayName)), [agents]);
  const [adding, setAdding] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [deleting, setDeleting] = useState<AgentRecord | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const detect = async () => {
    setDetecting(true);
    setMessage(null);
    try {
      const res = parseResponse(detectResponse, await api.post<unknown>('/agents/detect'), 'la detección de CLIs');
      for (const a of res.added) putAgent(a);
      const found = res.detected.length;
      setMessage({ tone: 'info', text: found === 0 ? 'No se encontraron CLIs de Codex ni agy.' : `${String(found)} CLI(s) detectado(s), ${String(res.added.length)} nuevo(s).` });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err) });
    } finally {
      setDetecting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await api.del(`/agents/${encodeURIComponent(deleting.config.id)}`);
      dropAgent(deleting.config.id);
      setDeleting(null);
    } catch (err) {
      setDeleteError(errorText(err));
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <SettingsCard
        title="Agentes"
        description="Claude con tu clave, Codex CLI, Antigravity CLI y APIs."
        actions={
          <>
            <Button size="sm" variant="secondary" isPending={detecting} onPress={() => void detect()}>
              <ScanSearch className="size-4" aria-hidden="true" />
              Detectar CLIs
            </Button>
            <Button size="sm" variant="primary" onPress={() => setAdding(true)}>
              <KeyRound className="size-4" aria-hidden="true" />
              Agregar por clave
            </Button>
          </>
        }
      >
        {sorted.length === 0 ? (
          <div className="p-4">
            <Notice tone="info">No hay agentes. Detecta los CLIs instalados o agrega uno con tu clave.</Notice>
          </div>
        ) : (
          sorted.map((a) => <AgentRow key={a.config.id} agent={a} onDelete={() => { setDeleteError(null); setDeleting(a); }} />)
        )}
      </SettingsCard>

      <AddAgentDialog
        isOpen={adding}
        onOpenChange={setAdding}
        onAdded={(agent, probe) => setMessage({ tone: probe && probe.warnings.length > 0 ? 'error' : 'info', text: `Agregado ${agent.config.displayName}.${probe && probe.warnings.length > 0 ? ` Avisos: ${probe.warnings.join(' ')}` : ''}` })}
      />
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`¿Borrar ${deleting?.config.displayName ?? 'el agente'}?`}
        description="Se borra el agente y su clave de la bóveda. Sus sesiones y su historial de uso se conservan."
        confirmLabel="Borrar"
        isPending={deletePending}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function probeSummary(agent: AgentRecord): { label: string; color: 'success' | 'warning' | 'danger' | 'default' } {
  const p = agent.lastProbe;
  if (!p) return { label: 'Sin probar', color: 'default' };
  if (!p.installed) return { label: 'No instalado', color: 'danger' };
  if (!p.authenticated) return { label: 'Sin sesión', color: 'danger' };
  if (p.warnings.length > 0) return { label: 'Con avisos', color: 'warning' };
  return { label: 'Funciona', color: 'success' };
}

/**
 * Agentes cuyo gasto descuenta Berland, los únicos a los que les sirve un presupuesto en US$: Claude por SDK y la API de
 * Anthropic (el núcleo solo conoce los precios de Claude). OpenRouter tiene su propio cupo por `/key`.
 */
function countsSpend(config: AgentRecord['config']): boolean {
  return config.kind === 'claude-sdk' || (config.kind === 'api' && config.provider === 'anthropic');
}

/** Agente por API cuyo gasto no se descuenta ni tiene cupo propio: la fila lo dice en vez de ofrecer un tope que no topa. */
function untrackedApi(config: AgentRecord['config']): boolean {
  return config.kind === 'api' && config.provider !== 'anthropic' && config.provider !== 'openrouter';
}

function AgentRow({ agent, onDelete }: { agent: AgentRecord; onDelete: () => void }) {
  const { config } = agent;
  const [busy, setBusy] = useState<'probe' | 'enabled' | 'budget' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [budget, setBudget] = useState(config.budgetUsd !== undefined ? String(config.budgetUsd) : '');
  useEffect(() => setBudget(config.budgetUsd !== undefined ? String(config.budgetUsd) : ''), [config.budgetUsd]);
  const status = probeSummary(agent);
  const path = `/agents/${encodeURIComponent(config.id)}`;

  const run = async (kind: 'probe' | 'enabled' | 'budget', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const probe = () =>
    run('probe', async () => {
      setProbeNote(null);
      const res = parseResponse(probeResponse, await api.post<unknown>(`${path}/probe`), 'la prueba del agente');
      putAgent(res.agent);
      const p = res.probe;
      setProbeNote(
        [p.version ? `Versión ${p.version}` : null, p.models.length > 0 ? `${String(p.models.length)} modelo(s)` : null, ...p.warnings].filter(Boolean).join(' · ') || 'Prueba correcta.',
      );
    });

  const patch = async (body: { enabled: boolean } | { budgetUsd: number | null }) => {
    putAgent(parseResponse(agentResponse, await api.patch<unknown>(path, body), 'el agente editado').agent);
  };

  const setEnabled = (enabled: boolean) => run('enabled', () => patch({ enabled }));

  const commitBudget = () => {
    const text = budget.trim();
    const current = config.budgetUsd;
    if (text === '') {
      if (current !== undefined) void run('budget', () => patch({ budgetUsd: null }));
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) {
      setError('El presupuesto debe ser un número mayor que 0 (o vacío para quitarlo).');
      setBudget(current !== undefined ? String(current) : '');
      return;
    }
    if (n !== current) void run('budget', () => patch({ budgetUsd: n }));
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3.5" data-agent={config.id}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[0.875rem] font-medium text-foreground">{config.displayName}</span>
            <Chip size="sm" variant="soft" color={status.color}>
              {status.label}
            </Chip>
          </div>
          <div className="truncate text-[0.75rem] text-muted">
            {[KIND_LABEL[config.kind] ?? config.kind, config.provider, config.model ?? 'modelo por defecto'].join(' · ')}
          </div>
        </div>
        {/* Con un presupuesto ya guardado (CLI o API) el campo sigue, para poder quitarlo. */}
        {countsSpend(config) || config.budgetUsd !== undefined ? (
          <span className="flex items-center gap-1 text-[0.75rem] text-muted">
            <span aria-hidden="true">US$</span>
            <Input
              aria-label={`Presupuesto en USD de ${config.displayName}`}
              type="number"
              min={0}
              step={1}
              placeholder="sin tope"
              value={budget}
              disabled={busy === 'budget'}
              onChange={(e) => setBudget(e.target.value)}
              onBlur={commitBudget}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitBudget();
              }}
              className="w-24 text-right"
            />
          </span>
        ) : null}
        <Switch isSelected={config.enabled} isDisabled={busy === 'enabled'} onChange={(v) => void setEnabled(v)}>
          <Switch.Content>
            <Label className="sr-only">{`Habilitar ${config.displayName}`}</Label>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <IconButton label={`Probar ${config.displayName}`} disabled={busy === 'probe'} onClick={() => void probe()}>
          <Play className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton label={`Borrar ${config.displayName}`} onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
        </IconButton>
      </div>
      {untrackedApi(config) ? (
        <p className="text-[0.75rem] text-muted">Berland no conoce el precio de este proveedor: su gasto no se descuenta ni tiene tope en US$.</p>
      ) : null}
      {busy === 'probe' ? <p className="text-[0.75rem] text-muted">Probando…</p> : null}
      {probeNote ? <p className="text-[0.75rem] text-muted">{probeNote}</p> : null}
      {error ? <Notice>{error}</Notice> : null}
    </div>
  );
}
