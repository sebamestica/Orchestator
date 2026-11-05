// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesTarget } from '../../../src/shared/api.ts';

vi.mock('../../../src/ui/api/live.ts', async () => {
  const m = await import('./fake-live.ts');
  return { getLive: () => m.getFakeLive() };
});
vi.mock('../../../src/ui/features/composer/Composer.tsx', async () => {
  const m = await import('./fake-composer.tsx');
  return { Composer: m.FakeComposer };
});

import ChatView from '../../../src/ui/features/chat/ChatView.tsx';
import { TargetLine } from '../../../src/ui/features/chat/components/TargetLine.tsx';
import { displayRemote, draftLineParts, targetLineParts, targetLineText } from '../../../src/ui/features/chat/target-line.ts';
import { useApp } from '../../../src/ui/store/app.ts';
import { resetFakeLive, type FakeLive } from './fake-live.ts';
import { fakeCore, installFetch, makeChat, PROJECT, setupApp, type Call, type Reply } from './helpers.ts';

const LOCAL_NO_GIT: ChangesTarget = { kind: 'local', path: 'C:\\dev\\marketing', git: 'none', worktrees: false };
const LOCAL_GIT: ChangesTarget = { kind: 'local', path: 'C:\\dev\\marketing', git: 'local', worktrees: false };
const FLEET: ChangesTarget = { kind: 'local', path: 'C:\\dev\\orquestador', git: 'remote', worktrees: true };
const REMOTE: ChangesTarget = {
  kind: 'remote',
  path: 'C:\\dev\\orquestador',
  remote: { name: 'origin', url: 'https://github.com/sebamestica/Orchestator' },
  branch: 'main',
  configured: true,
};

const text = (t: ChangesTarget, standalone = false) => targetLineText(targetLineParts(t, { standalone }));
const line = () => screen.getByTestId('target-line');
const targetGets = (calls: Call[], chatId = 'chat_abc123') => calls.filter((c) => c.method === 'GET' && c.path === `/chats/${chatId}/target`).length;

let live: FakeLive;
beforeEach(() => {
  setupApp();
  live = resetFakeLive();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('textos de la línea', () => {
  it('los cinco casos del plan', () => {
    expect(text(LOCAL_NO_GIT)).toBe('Local · se guarda en C:\\dev\\marketing · sin git');
    expect(text(LOCAL_GIT)).toBe('Local · se guarda en C:\\dev\\marketing · no se sube a ningún repositorio');
    expect(text({ ...LOCAL_GIT, git: 'remote' })).toBe('Local · se guarda en C:\\dev\\marketing · no se sube a ningún repositorio');
    expect(text(FLEET)).toBe('Local · C:\\dev\\orquestador · ramas orq/… · no se sube');
    expect(text(REMOTE)).toBe('Se subirá a github.com/sebamestica/Orchestator · rama main · solo con tu aprobación');
    expect(text({ ...REMOTE, configured: false })).toBe(
      'Se subirá a github.com/sebamestica/Orchestator · rama main · solo con tu aprobación (el remoto no está configurado en la carpeta)',
    );
    expect(text({ kind: 'local', path: 'D:\\notas', git: 'local', worktrees: false }, true)).toBe('Local · D:\\notas');
  });

  it('remoto sin rama, sin URL o con .git; borrador de una conversación nueva', () => {
    expect(text({ ...REMOTE, branch: null })).toBe('Se subirá a github.com/sebamestica/Orchestator · solo con tu aprobación');
    expect(displayRemote({ name: 'upstream', url: '' })).toBe('upstream');
    expect(displayRemote({ name: null, url: 'https://github.com/a/b.git' })).toBe('github.com/a/b');
    expect(displayRemote({ name: null, url: 'gitlab.com/a/b' })).toBe('gitlab.com/a/b');
    expect(draftLineParts(null)).toBeNull();
    expect(targetLineText(draftLineParts({ path: 'C:\\dev\\demo', worktrees: false }) ?? { kind: 'local', lead: '', place: '', tail: '' })).toBe('Local · se guarda en C:\\dev\\demo');
  });
});

describe('<TargetLine>', () => {
  function serve(target: unknown, status = 200): Call[] {
    return installFetch((method, path): Reply => (method === 'GET' && /^\/chats\/[^/]+\/target$/.test(path) ? { status, body: status === 200 ? { target } : { error: { code: 'x', message: 'falló' } } } : undefined));
  }

  it('muestra el destino del núcleo: discreta, con icono decorativo, aria-live y la ruta truncada con su title', async () => {
    const calls = serve(LOCAL_GIT);
    render(<TargetLine chatId="chat_abc123" standalone={false} />);
    await waitFor(() => expect(line().textContent).toBe('Local · se guarda en C:\\dev\\marketing · no se sube a ningún repositorio'));
    const el = line();
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.dataset.kind).toBe('local');
    expect(el.className).toContain('text-[0.75rem]');
    expect(el.className).toContain('text-muted');
    const place = screen.getByTestId('target-place');
    expect(place.textContent).toBe('C:\\dev\\marketing');
    expect(place.getAttribute('title')).toBe('C:\\dev\\marketing');
    expect(place.className).toContain('truncate');
    const icon = el.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('class')).toContain('lucide-hard-drive');
    expect(targetGets(calls)).toBe(1);
  });

  it('se actualiza con chat_target sin volver a pedirlo; ignora otros chats y mensajes que no validan', async () => {
    const calls = serve(LOCAL_GIT);
    render(<TargetLine chatId="chat_abc123" standalone={false} />);
    await waitFor(() => expect(line().dataset.kind).toBe('local'));
    act(() => live.emit({ type: 'chat_target', chatId: 'chat_otro99', target: REMOTE }));
    expect(line().dataset.kind).toBe('local');
    act(() => live.emit({ type: 'chat_target', chatId: 'chat_abc123', target: { kind: 'remote', path: '' } as unknown as ChangesTarget }));
    expect(line().dataset.kind).toBe('local');
    act(() => live.emit({ type: 'chat_target', chatId: 'chat_abc123', target: REMOTE }));
    expect(line().textContent).toBe('Se subirá a github.com/sebamestica/Orchestator · rama main · solo con tu aprobación');
    expect(line().dataset.kind).toBe('remote');
    expect(line().querySelector('svg')?.getAttribute('class')).toContain('lucide-cloud-upload');
    expect(targetGets(calls)).toBe(1);
  });

  it('al cambiar de chat no muestra el destino anterior y lo pide de nuevo; al reconectar /ws, también', async () => {
    const calls = installFetch((method, path): Reply => {
      if (path === '/chats/chat_abc123/target') return { body: { target: LOCAL_NO_GIT } };
      if (path === '/chats/chat_def456/target') return { body: { target: REMOTE } };
      return undefined;
    });
    const view = render(<TargetLine chatId="chat_abc123" standalone={false} />);
    await waitFor(() => expect(line().textContent).toContain('sin git'));
    view.rerender(<TargetLine chatId="chat_def456" standalone={false} />);
    expect(line().textContent).toBe('');
    await waitFor(() => expect(line().dataset.kind).toBe('remote'));
    act(() => live.setStatus('open'));
    await waitFor(() => expect(targetGets(calls, 'chat_def456')).toBe(2));
  });

  it('una respuesta que no valida o un error deja la línea vacía; sin chat, el borrador del proyecto', async () => {
    serve({ kind: 'local', path: 'C:\\x' });
    const view = render(<TargetLine chatId="chat_abc123" standalone={false} />);
    await waitFor(() => expect(line().dataset.kind).toBe('none'));
    expect(line().textContent).toBe('');
    view.rerender(<TargetLine chatId={null} standalone={false} draft={{ path: 'C:\\dev\\orquestador', worktrees: true }} />);
    expect(line().textContent).toBe('Local · C:\\dev\\orquestador · ramas orq/… · no se sube');
  });
});

describe('en la vista de chat', () => {
  it('va en el pie, justo encima de la ficha del modo, y cambia con chat_target', async () => {
    const chat = makeChat();
    fakeCore({ chats: [chat] }, (method, path) => (method === 'GET' && path === `/chats/${chat.id}/target` ? { body: { target: { ...LOCAL_GIT, path: 'C:\\dev\\demo' } } } : undefined));
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(line().textContent).toBe('Local · se guarda en C:\\dev\\demo · no se sube a ningún repositorio'));
    const footer = line().closest('footer');
    expect(footer).toBeTruthy();
    expect(line().nextElementSibling).toBe(screen.getByTestId('mode-chip').parentElement);
    act(() => live.emit({ type: 'chat_target', chatId: chat.id, target: REMOTE }));
    expect(line().textContent).toMatch(/^Se subirá a github\.com\/sebamestica\/Orchestator/);
  });

  it('conversación nueva de un proyecto con worktrees: el borrador en local', async () => {
    useApp.setState({ projects: [{ ...PROJECT, workspace: { baseBranch: 'main', integrationBranch: 'orq/integracion', links: [], postCreate: [], gate: [{ command: 'node', args: ['-v'], timeoutMs: 60_000, env: {} }] } }] });
    fakeCore({ chats: [] });
    render(<ChatView projectId="demo" />);
    await waitFor(() => expect(line().textContent).toBe('Local · C:\\dev\\demo · ramas orq/… · no se sube'));
  });
});
