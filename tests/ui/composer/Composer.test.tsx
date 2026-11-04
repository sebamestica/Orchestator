// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../../src/ui/features/composer/Composer.tsx';
import type { ComposerProps } from '../../../src/ui/features/composer/Composer.tsx';
import { MAX_ATTACHMENT_BYTES } from '../../../src/shared/api.ts';
import type { Attachment } from '../../../src/shared/api.ts';

const attachment: Attachment = { id: 'attachment-1', name: 'foto.png', mime: 'image/png', size: 3, path: 'C:/data/foto.png', kind: 'image', source: 'upload', createdAt: '2026-11-04T12:00:00.000Z' };
const image = () => new File(['abc'], 'foto.png', { type: 'image/png' });
function setup(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = { placeholder: 'Escribe a Berland', mode: 'auto', onModeChange: vi.fn(), onAttach: vi.fn().mockResolvedValue(attachment), onSubmit: vi.fn().mockResolvedValue(true), onStop: vi.fn(), ...overrides };
  return { ...render(<Composer {...props} />), props };
}
const paste = (files: File[]) => fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files } });
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Composer', () => {
  it('abre el menú y selecciona archivos con el input oculto', async () => {
    const { props } = setup();
    const input = screen.getByLabelText('Seleccionar archivos');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Añadir adjunto' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Adjuntar archivo' }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(['nota'], 'nota.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(props.onAttach).toHaveBeenCalledWith(file));
    expect(screen.getByText('nota.txt')).toBeTruthy();
  });
  it('deja pegar texto normal y oculta la capa al salir de la ventana', () => {
    setup();
    expect(paste([])).toBe(true);
    const dataTransfer = { types: ['Files'], files: [image()] };
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.dragLeave(window, { dataTransfer });
    expect(screen.queryByText('Suelta para adjuntar')).toBeNull();
  });
  it('evita envíos duplicados mientras onSubmit está pendiente', async () => {
    let resolve: ((accepted: boolean) => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    setup({ onSubmit });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Hola' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => { resolve?.(false); });
  });
  it('Enter envía, Shift+Enter e IME no envían; limpia al aceptar', async () => {
    const { props } = setup();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Hola' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({ text: 'Hola', attachments: [] }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });
  it('Shift+Tab cicla auto → plan → bypass → auto y evita mover el foco', () => {
    const { props, rerender } = setup();
    for (const [mode, next] of [['auto', 'plan'], ['plan', 'bypass'], ['bypass', 'auto']] as const) {
      rerender(<Composer {...props} mode={mode} />);
      expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true })).toBe(false);
      expect(props.onModeChange).toHaveBeenLastCalledWith(next);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar modo: Bypass' }));
    expect(props.onModeChange).toHaveBeenLastCalledWith('auto');
  });
  it('Esc solo detiene durante la transmisión, también fuera del textarea', () => {
    const { props, rerender } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onStop).not.toHaveBeenCalled();
    rerender(<Composer {...props} isStreaming />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Detener respuesta' }));
    expect(props.onStop).toHaveBeenCalledTimes(2);
  });
  it('pega imagen, bloquea mientras sube, envía el contrato y libera la miniatura', async () => {
    let resolve: ((value: Attachment) => void) | undefined;
    const onAttach = vi.fn(() => new Promise<Attachment>((done) => { resolve = done; }));
    const { props } = setup({ onAttach });
    const file = image();
    paste([file]);
    expect(onAttach).toHaveBeenCalledWith(file);
    expect(screen.getByAltText('foto.png').getAttribute('src')).toBe('blob:preview');
    expect(screen.getByText('Subiendo…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enviar mensaje' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve?.(attachment); });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({ text: '', attachments: [attachment] }));
    await waitFor(() => expect(screen.queryByAltText('foto.png')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
  it('cuenta entradas anidadas y al soltar sobre la ventana adjunta cada archivo sin navegar', async () => {
    const { props } = setup();
    const files = [image(), new File(['a'], 'nota.txt')];
    const dataTransfer = { types: ['Files'], files };
    fireEvent.dragEnter(window, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText('Suelta para adjuntar')).toBeNull();
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.dragEnter(document.body, { dataTransfer });
    fireEvent.dragLeave(document.body, { dataTransfer });
    expect(screen.getByText('Suelta para adjuntar')).toBeTruthy();
    expect(fireEvent.dragOver(window, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(window, { dataTransfer })).toBe(false);
    expect(screen.queryByText('Suelta para adjuntar')).toBeNull();
    await waitFor(() => expect(props.onAttach).toHaveBeenCalledTimes(2));
    expect(props.onAttach).toHaveBeenNthCalledWith(2, files[1]);
  });
  it('quitar durante la carga libera URL y una resolución tardía no restaura el adjunto', async () => {
    let resolve: ((value: Attachment) => void) | undefined;
    setup({ onAttach: () => new Promise((done) => { resolve = done; }) });
    paste([image()]);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto.png' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => { resolve?.(attachment); });
    expect(screen.queryByRole('list', { name: 'Adjuntos' })).toBeNull();
  });
  it('libera miniaturas al desmontar', async () => {
    const { unmount } = setup();
    paste([image()]);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
  it('rechaza tamaño superior a 20 MB con aviso', () => {
    const { props } = setup();
    const file = new File(['x'], 'grande.txt');
    Object.defineProperty(file, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    paste([file]);
    expect(screen.getByRole('alert').textContent).toContain('20 MB');
    expect(props.onAttach).not.toHaveBeenCalled();
  });
  it('acepta exactamente 20 MB y limita a 20 adjuntos incluso en el mismo lote', async () => {
    const { props } = setup();
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `${i}.txt`));
    Object.defineProperty(files[0], 'size', { value: MAX_ATTACHMENT_BYTES });
    paste(files);
    expect(screen.getByRole('alert').textContent).toContain('20 archivos');
    await waitFor(() => expect(props.onAttach).toHaveBeenCalledTimes(20));
  });
  it('conserva texto y adjuntos si onSubmit devuelve false', async () => {
    const { props } = setup({ onSubmit: vi.fn().mockResolvedValue(false) });
    paste([image()]);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Borrador');
    expect(screen.getByAltText('foto.png')).toBeTruthy();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it('muestra fallo de carga y bloquea el envío hasta quitarlo', async () => {
    setup({ onAttach: vi.fn().mockRejectedValue(new Error('404')) });
    paste([image()]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('servicio'));
    expect((screen.getByRole('button', { name: 'Enviar mensaje' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto.png' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('muestra error de envío y conserva borrador sin rechazo sin controlar', async () => {
    setup({ onSubmit: vi.fn().mockRejectedValue(new Error('501')) });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo enviar'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Borrador');
  });
  it('deshabilitado impide cargas pero cancela la navegación al soltar', () => {
    const { props } = setup({ isDisabled: true });
    const dataTransfer = { types: ['Files'], files: [image()] };
    fireEvent.dragEnter(window, { dataTransfer });
    expect(screen.queryByText('Suelta para adjuntar')).toBeNull();
    expect(fireEvent.drop(window, { dataTransfer })).toBe(false);
    expect(props.onAttach).not.toHaveBeenCalled();
  });
});
