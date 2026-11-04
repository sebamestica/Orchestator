import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Spinner } from '@heroui/react';
import { Folder, GitBranch } from 'lucide-react';
import { z } from 'zod';
import { folderInspectionSchema, fsListResponse, projectFromFolderBody, type FolderInspection, type FsListResponse } from '../../../shared/api.ts';
import { api, ApiError } from '../../api/client.ts';
import { useApp } from '../../store/app.ts';
import { navigate } from '../../app/routes.ts';

export interface AddProjectDialogProps { open: boolean; onClose: () => void }
export function AddProjectDialog({ open, onClose }: AddProjectDialogProps) {
  return <Modal isOpen={open} onOpenChange={(value) => { if (!value) onClose(); }}><Modal.Backdrop><Modal.Container><Modal.Dialog>
    <Modal.Header><Modal.Heading>Abrir una carpeta local</Modal.Heading></Modal.Header>
    {open && <FolderForm onClose={onClose} />}
  </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>;
}
function FolderForm({ onClose }: { onClose: () => void }) {
  const [listing, setListing] = useState<FsListResponse | null>(null);
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [name, setName] = useState(''); const [id, setId] = useState(''); const [gate, setGate] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true);
  const refreshProjects = useApp((s) => s.refreshProjects);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { if (alive.current) setError(e instanceof ApiError && [404, 501].includes(e.status) ? 'Esta función todavía no está disponible en este núcleo. Puedes probar el explorador de carpetas.' : e instanceof Error ? e.message : 'No se pudo abrir la carpeta.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function inspect(path: string) {
    const result = folderInspectionSchema.parse(await api.post<unknown>('/projects/inspect', { path }));
    if (!alive.current) return;
    setInspection(result); setName(result.suggestedName); setId(result.suggestedId);
    setGate(result.gate?.map((g) => [g.command, ...g.args].join(' ')).join('\n') ?? '');
  }
  async function browse(path: string) {
    const result = fsListResponse.parse(await api.get<unknown>(`/fs/list?path=${encodeURIComponent(path)}`));
    if (alive.current) setListing(result);
  }
  async function pick() {
    const path = window.orq ? z.string().nullable().parse(await window.orq.pickFolder()) : z.object({ path: z.string().nullable() }).parse(await api.post<unknown>('/fs/pick-folder')).path;
    if (path && alive.current) await inspect(path);
  }
  async function add() {
    if (!inspection) return;
    const body = projectFromFolderBody.parse({ path: inspection.path, name: name.trim(), id: id.trim() });
    const result = z.object({ project: z.object({ id: projectFromFolderBody.shape.id.unwrap() }) }).parse(await api.post<unknown>('/projects/from-folder', body));
    if (!alive.current) return;
    // El alta ya ocurrió: un fallo de refresco no debe permitir registrar dos veces.
    try { await refreshProjects(); } catch { /* La siguiente carga global reintentará la lista. */ }
    if (alive.current) { navigate({ name: 'project', projectId: result.project.id }); onClose(); }
  }
  const inputClass = 'mt-1 w-full rounded-lg border border-foreground/[0.06] bg-foreground/[0.045] p-2 text-sm';
  return <><Modal.Body><div className="space-y-4">
    {error && <p role="alert" className="text-sm text-muted">{error}</p>}{busy && <Spinner aria-label="Procesando carpeta" />}
    {!inspection ? <>
      <p className="text-sm text-muted">1. Elige la carpeta de tu proyecto.</p>
      <Button isDisabled={busy} onPress={() => { void run(pick); }}>Elegir carpeta</Button>
      <Button isDisabled={busy} onPress={() => { void run(() => browse('')); }}>Explorar carpetas</Button>
      {listing && <div className="space-y-2"><p className="break-all text-sm">{listing.path || 'Carpetas disponibles'}</p>
        {listing.parent !== null && <Button isDisabled={busy} onPress={() => { void run(() => browse(listing.parent ?? '')); }}>Subir</Button>}
        <ul className="max-h-64 overflow-auto">{listing.entries.filter((e) => e.isDir).slice(0, 500).map((entry) => <li key={entry.path}><Button className="w-full justify-start bg-foreground/[0.045] hover:bg-foreground/[0.08]" isDisabled={busy} onPress={() => { void run(() => browse(entry.path)); }} aria-label={`Entrar en ${entry.name}`}><Folder size={16} aria-hidden="true" />{entry.name}{entry.isGitRepo && <GitBranch size={16} aria-label="Repositorio git" />}</Button></li>)}</ul>
        {listing.entries.length > 500 && <p className="text-sm text-muted">Se muestran hasta 500 carpetas.</p>}
        {listing.path && <Button isDisabled={busy} onPress={() => { void run(() => inspect(listing.path)); }}>Usar esta carpeta</Button>}
      </div>}
    </> : <>
      <p className="text-sm text-muted">2. Revisa el proyecto antes de agregarlo.</p>
      <p className="break-all text-sm">{inspection.path}</p><p>{inspection.isGitRepo ? 'Repositorio git' : 'Carpeta sin repositorio git'}</p>
      <label className="block">Nombre<input className={inputClass} value={name} maxLength={120} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block">Id<input className={inputClass} value={id} disabled={busy} onChange={(e) => setId(e.target.value)} /></label>
      <label className="block">Gate propuesto<textarea className={inputClass} value={gate} disabled={busy} placeholder="npm run -s check" onChange={(e) => setGate(e.target.value)} /></label>
      <p className="text-sm text-muted">Al agregar se usará el gate detectado; los cambios de este campo aún no se guardan.</p>
      {inspection.warnings.length > 0 && <ul className="list-inside list-disc text-sm text-muted">{inspection.warnings.slice(0, 500).map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <Button isDisabled={busy} onPress={() => setInspection(null)}>Cambiar carpeta</Button>
    </>}
  </div></Modal.Body><Modal.Footer><Button isDisabled={busy} onPress={onClose}>Cancelar</Button>{inspection && <Button className="bg-foreground text-canvas" isDisabled={busy || !name.trim() || !id.trim()} onPress={() => { void run(add); }}>Agregar</Button>}</Modal.Footer></>;
}
