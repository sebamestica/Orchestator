// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageCleanResultSchema, storageSummarySchema, type StorageCleanResult, type StorageSummary } from '../../../src/shared/api.ts';
import { parseRoute, routeHash } from '../../../src/ui/app/routes.ts';
import SettingsView from '../../../src/ui/features/settings/SettingsView.tsx';
import { formatBytes, resultText } from '../../../src/ui/features/settings/StorageSection.tsx';
import { fakeCore, resetStore } from './helpers.ts';

const MB = 1024 * 1024;

function summary(over: Partial<{ orphans: number; chats: number; leftovers: number }> = {}): StorageSummary {
  const orphans = over.orphans ?? 9;
  return storageSummarySchema.parse({
    measuredAt: '2026-11-05T14:20:00.000Z',
    totalBytes: 74 * MB + 52 * MB + 100 * MB,
    attachments: {
      dir: 'C:\\Users\\yo\\AppData\\Local\\orquestador\\attachments',
      total: { count: 38, bytes: 74 * MB },
      images: { count: 31, bytes: 61 * MB },
      others: { count: 7, bytes: 13 * MB },
      orphans: { count: orphans, bytes: orphans ? 18 * MB : 0 },
      linkedFiles: 4,
    },
    chats: {
      chats: over.chats ?? 24,
      busy: 1,
      messages: 1310,
      events: 48210,
      sessions: 61,
      bytes: 71 * MB,
      leftovers: { count: over.leftovers ?? 5120, bytes: over.leftovers === 0 ? 0 : 9 * MB },
      oldestUpdatedAt: '2026-10-02T18:04:11.000Z',
    },
    conversations: {
      root: 'C:\\Users\\yo\\AppData\\Local\\berland-conversaciones',
      exists: true,
      total: { count: 6, bytes: 52 * MB },
      orphans: { count: 2, bytes: 11 * MB },
      truncated: false,
    },
    database: { path: 'C:\\Users\\yo\\AppData\\Local\\orquestador\\orquestador.db', fileBytes: 96 * MB, walBytes: 4 * MB, shmBytes: 0, totalBytes: 100 * MB, freeBytes: 6 * MB, chatBytes: 80 * MB, otherBytes: 10 * MB },
  });
}

function result(over: Partial<StorageCleanResult> = {}): StorageCleanResult {
  return storageCleanResultSchema.parse({
    target: 'attachments',
    deleted: { chats: 0, messages: 0, events: 0, sessions: 0, attachments: 9, files: 9, folders: 0 },
    freedBytes: 18 * MB,
    skipped: [],
    compacted: false,
    warnings: [],
    ...over,
  });
}

function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
}

beforeEach(() => resetStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('formatBytes', () => {
  it('B, KB, MB y GB en español (base 1024)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(5 * MB)).toBe('5 MB');
    expect(formatBytes(23.4 * MB)).toBe('23 MB');
    expect(formatBytes(1.5 * 1024 * MB)).toBe('1,5 GB');
    expect(formatBytes(-3)).toBe('0 B');
  });

  it('resume lo que hizo una acción, con lo omitido', () => {
    expect(resultText(result())).toBe('Se borraron 9 archivos. Se liberaron 18 MB.');
    expect(
      resultText(result({ target: 'chats', deleted: { chats: 2, messages: 9, events: 300, sessions: 3, attachments: 0, files: 0, folders: 1 }, skipped: [{ id: 'c1', reason: 'está respondiendo' }], freedBytes: 3 * MB })),
    ).toBe('Se borraron 2 chats. Se liberaron 3 MB. 1 elemento quedó sin tocar (está respondiendo).');
  });
});

describe('rutas', () => {
  it('#/ajustes/almacenamiento abre la sección', () => {
    expect(parseRoute('#/ajustes/almacenamiento')).toEqual({ name: 'settings', section: 'almacenamiento' });
    expect(routeHash({ name: 'settings', section: 'almacenamiento' })).toBe('#/ajustes/almacenamiento');
  });
});

describe('Ajustes › Almacenamiento', () => {
  it('muestra el total y lo que ocupa cada categoría', async () => {
    fakeCore({ 'GET /storage': () => ({ body: { storage: summary() } }) });
    render(<SettingsView section="almacenamiento" />);
    expect((await screen.findByTestId('storage-total')).textContent).toBe('226 MB');
    expect(screen.getByTestId('storage-attachments').textContent).toBe('74 MB');
    expect(screen.getByTestId('storage-chats').textContent).toBe('≈ 71 MB');
    expect(screen.getByTestId('storage-conversations').textContent).toBe('52 MB');
    expect(screen.getByTestId('storage-database').textContent).toBe('100 MB');
    expect(screen.getByText('38 archivos: 31 imágenes (61 MB) y 7 otros (13 MB)')).toBeTruthy();
    expect(screen.getByText('1 chat en curso: no se tocan')).toBeTruthy();
    expect(screen.getByText(/son carpetas tuyas y Berland nunca las vacía/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Almacenamiento' }).getAttribute('aria-current')).toBe('page');
  });

  it('«Vaciar sin usar» pide confirmación con lo que se borra y solo al confirmar llama al núcleo', async () => {
    const after = summary({ orphans: 0 });
    const calls = fakeCore({
      'GET /storage': () => ({ body: { storage: summary() } }),
      'POST /storage/attachments/clean': () => ({ body: { result: result(), storage: after } }),
    });
    render(<SettingsView section="almacenamiento" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vaciar sin usar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('¿Vaciar los adjuntos sin usar?')).toBeTruthy();
    expect(within(dialog).getByText(/9 archivos \(18 MB\): copias de imágenes y archivos que ningún chat usa/)).toBeTruthy();
    expect(within(dialog).getByText('Los archivos tuyos adjuntados por su ruta')).toBeTruthy();
    expect(within(dialog).getByText('No se puede deshacer.')).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /storage']);

    // Cancelar no llama a nada.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Vaciar sin usar' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Vaciar' }));
    expect(await screen.findByText('Se borraron 9 archivos. Se liberaron 18 MB.')).toBeTruthy();
    expect(calls.slice(1)).toEqual([{ method: 'POST', path: '/storage/attachments/clean', body: { scope: 'orphans' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // El resumen nuevo llega en la respuesta: ya no hay nada sin usar.
    expect(isDisabled(screen.getByRole('button', { name: 'Vaciar sin usar' }))).toBe(true);
  });

  it('«Vaciar antiguos…» deja elegir los días, avisa qué se conserva y envía olderThanDays', async () => {
    const calls = fakeCore({
      'GET /storage': () => ({ body: { storage: summary() } }),
      'POST /storage/chats/clean': () => ({ body: { result: result({ target: 'chats', deleted: { chats: 5, messages: 40, events: 900, sessions: 6, attachments: 0, files: 0, folders: 0 }, compacted: true, freedBytes: 12 * MB }), storage: summary({ chats: 19 }) } }),
    });
    render(<SettingsView section="almacenamiento" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vaciar antiguos…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/sin actividad en los últimos 30 días/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: '90 días' }));
    expect(within(dialog).getByText(/sin actividad en los últimos 90 días/)).toBeTruthy();
    expect(within(dialog).getByText('Los chats que están respondiendo o con subagentes trabajando')).toBeTruthy();
    expect(within(dialog).getByText('El historial de uso y gasto')).toBeTruthy();
    expect(within(dialog).getByText('Tus proyectos y sus carpetas')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vaciar' }));
    expect(await screen.findByText('Se borraron 5 chats. Se liberaron 12 MB.')).toBeTruthy();
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/storage/chats/clean', body: { scope: 'older', olderThanDays: 90 } });
  });

  it('«Vaciar todos» los chats dice cuántos y con qué; «Compactar» no se presenta como borrado', async () => {
    fakeCore({ 'GET /storage': () => ({ body: { storage: summary() } }) });
    render(<SettingsView section="almacenamiento" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vaciar todos' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/24 chats con sus 1310 mensajes, propuestas, eventos y sesiones/)).toBeTruthy();
    expect(within(dialog).getByText(/sus carpetas de conversación, con lo que la mente creó en ellas/)).toBeTruthy();
    expect(within(dialog).getByText('No se puede deshacer.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Compactar' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No borra datos/)).toBeTruthy();
    expect(within(dialog).queryByText('No se puede deshacer.')).toBeNull();
  });

  it('sin nada que vaciar, los botones quedan deshabilitados', async () => {
    fakeCore({ 'GET /storage': () => ({ body: { storage: summary({ orphans: 0, leftovers: 0, chats: 0 }) } }) });
    render(<SettingsView section="almacenamiento" />);
    expect(isDisabled(await screen.findByRole('button', { name: 'Vaciar sin usar' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Vaciar restos' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Vaciar todos' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Vaciar todo' }))).toBe(false);
  });

  it('un error del núcleo se muestra en el diálogo, que sigue abierto', async () => {
    fakeCore({
      'GET /storage': () => ({ body: { storage: summary() } }),
      'POST /storage/conversations/clean': () => ({ status: 409, body: { error: { code: 'conflict', message: 'Ya se está vaciando el almacenamiento: espera a que termine' } } }),
    });
    render(<SettingsView section="almacenamiento" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vaciar sin chat' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vaciar' }));
    expect(await within(dialog).findByText('Ya se está vaciando el almacenamiento: espera a que termine')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('si el núcleo no tiene la ruta, lo dice', async () => {
    fakeCore({});
    render(<SettingsView section="almacenamiento" />);
    expect(await screen.findByText(/El núcleo todavía no tiene esta función/)).toBeTruthy();
  });
});
