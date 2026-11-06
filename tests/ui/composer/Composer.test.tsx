// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../../src/ui/features/composer/Composer.tsx';
import type { ComposerProps } from '../../../src/ui/features/composer/Composer.tsx';
import { MAX_ATTACHMENT_BYTES } from '../../../src/shared/api.ts';
import type { Attachment } from '../../../src/shared/api.ts';
import { ApiError } from '../../../src/ui/api/client.ts';

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
  it('Shift+Tab cicla auto → plan → bypass → chat → auto y evita mover el foco', () => {
    const { props, rerender } = setup();
    for (const [mode, next] of [['auto', 'plan'], ['plan', 'bypass'], ['bypass', 'chat'], ['chat', 'auto']] as const) {
      rerender(<Composer {...props} mode={mode} />);
      expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true })).toBe(false);
      expect(props.onModeChange).toHaveBeenLastCalledWith(next);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar modo: Chat' }));
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
  describe('aviso de adjunto rechazado', () => {
    const big = () => {
      const file = new File(['x'], 'grande.txt');
      Object.defineProperty(file, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
      return file;
    };
    it('se puede cerrar', () => {
      setup();
      paste([big()]);
      expect(screen.getByRole('alert').textContent).toContain('20 MB');
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso de adjuntos' }));
      expect(screen.queryByText(/20 MB/)).toBeNull();
    });
    it('desaparece al enviar', async () => {
      const { props } = setup();
      paste([big()]);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hola' } });
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText(/20 MB/)).toBeNull());
    });
    it('quitar adjuntos borra el aviso de límite', async () => {
      const { props } = setup();
      paste(Array.from({ length: 21 }, (_, i) => new File(['x'], `${i}.txt`)));
      await waitFor(() => expect(props.onAttach).toHaveBeenCalledTimes(20));
      await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
      expect(screen.getByText(/20 archivos/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Quitar 0.txt' }));
      expect(screen.queryByText(/20 archivos/)).toBeNull();
    });
    it('no pasa a otra conversación', () => {
      const { props, rerender } = setup({ resetKey: 'chat_a' });
      paste([big()]);
      rerender(<Composer {...props} resetKey="chat_b" />);
      expect(screen.queryByText(/20 MB/)).toBeNull();
    });
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
    setup({ onAttach: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
    paste([image()]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('servicio'));
    expect((screen.getByRole('button', { name: 'Enviar mensaje' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto.png' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('si el núcleo rechaza el adjunto, muestra su motivo en un solo aviso', async () => {
    setup({ onAttach: vi.fn().mockRejectedValue(new ApiError(400, 'invalid_request', 'La ruta no es un archivo')) });
    paste([image()]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('La ruta no es un archivo'));
    expect(screen.getByRole('alert').textContent).not.toContain('servicio puede no estar disponible');
  });
  it('muestra error de envío y conserva borrador sin rechazo sin controlar', async () => {
    setup({ onSubmit: vi.fn().mockRejectedValue(new Error('501')) });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo enviar'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Borrador');
  });
  it('con otro resetKey vacía la bandeja, salvo si cambia durante el envío', async () => {
    const { props, rerender } = setup({ resetKey: 'chat_a' });
    paste([image()]);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    rerender(<Composer {...props} resetKey="chat_b" />);
    expect(screen.queryByAltText('foto.png')).toBeNull();

    // El chat que crea el propio envío no es otra conversación: si el envío falla, la bandeja sigue.
    let resolve: ((accepted: boolean) => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    rerender(<Composer {...props} resetKey="" onSubmit={onSubmit} />);
    paste([image()]);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    rerender(<Composer {...props} resetKey="chat_new" onSubmit={onSubmit} />);
    await act(async () => { resolve?.(false); });
    expect(screen.getByAltText('foto.png')).toBeTruthy();
  });
  it('con text y onTextChange, el texto lo guarda quien lo monta', async () => {
    const onTextChange = vi.fn();
    const { props, rerender } = setup({ text: 'de A', onTextChange });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe('de A');
    fireEvent.change(input, { target: { value: 'de A!' } });
    expect(onTextChange).toHaveBeenLastCalledWith('de A!');
    rerender(<Composer {...props} text="" />);
    expect(input.value).toBe('');
    rerender(<Composer {...props} text="hola" />);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({ text: 'hola', attachments: [] }));
    await waitFor(() => expect(onTextChange).toHaveBeenLastCalledWith(''));
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

describe('Composer al estilo Claude Code (issue 10)', () => {
  const ready = (id: string, name: string): Attachment => ({ ...attachment, id, name, path: `C:/data/${name}` });
  const drop = (files: File[]) => {
    const dataTransfer = { types: ['Files'], files };
    fireEvent.dragEnter(window, { dataTransfer });
    return fireEvent.drop(window, { dataTransfer });
  };

  it('soltar una imagen crea el adjunto con vista previa, lo sube y lo envía', async () => {
    const { props } = setup();
    const file = image();
    expect(drop([file])).toBe(false);
    expect(screen.getByAltText('foto.png').getAttribute('src')).toBe('blob:preview');
    expect(props.onAttach).toHaveBeenCalledWith(file);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({ text: '', attachments: [attachment] }));
  });

  it('mientras se arrastra, el texto de ayuda lo dice y la caja se resalta', () => {
    const { container } = setup();
    const dataTransfer = { types: ['Files'], files: [image()] };
    fireEvent.dragEnter(window, { dataTransfer });
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Suelta los archivos para adjuntarlos');
    expect(container.querySelector('form')?.className).toContain('ring-2');
    fireEvent.dragLeave(window, { dataTransfer });
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Escribe a Berland');
  });

  it('Ctrl+V fuera del campo también adjunta; en otro campo editable no', async () => {
    const { props } = setup();
    render(<input aria-label="Renombrar chat" />);
    expect(fireEvent.paste(screen.getByLabelText('Renombrar chat'), { clipboardData: { files: [image()] } })).toBe(true);
    expect(props.onAttach).not.toHaveBeenCalled();
    expect(fireEvent.paste(document.body, { clipboardData: { files: [image()] } })).toBe(false);
    await waitFor(() => expect(props.onAttach).toHaveBeenCalledTimes(1));
    expect(screen.getByAltText('foto.png')).toBeTruthy();
  });

  it('si el portapapeles también trae texto (celdas de Excel), pega el texto y no adjunta', () => {
    const { props } = setup();
    expect(fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { types: ['text/plain', 'Files'], files: [image()] } })).toBe(true);
    expect(props.onAttach).not.toHaveBeenCalled();
  });

  it('numera las capturas pegadas sin nombre propio', async () => {
    const onAttach = vi.fn(async (file: File) => ready(file.name === 'imagen-pegada-1.png' ? 'attachment-1' : 'attachment-2', file.name));
    setup({ onAttach });
    paste([new File(['a'], 'image.png', { type: 'image/png' })]);
    paste([new File(['b'], 'image.png', { type: 'image/png' })]);
    expect(screen.getByAltText('imagen-pegada-1.png')).toBeTruthy();
    expect(screen.getByAltText('imagen-pegada-2.png')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quitar imagen-pegada-2.png' })).toBeTruthy();
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(2));
    expect(onAttach.mock.calls.map(([file]) => [file.name, file.type])).toEqual([['imagen-pegada-1.png', 'image/png'], ['imagen-pegada-2.png', 'image/png']]);
  });

  it('quitar un adjunto ya subido lo saca de la bandeja y del envío', async () => {
    const onAttach = vi.fn(async (file: File) => ready(file.name === 'foto.png' ? 'attachment-1' : 'attachment-2', file.name));
    const { props } = setup({ onAttach });
    paste([image(), new File(['nota'], 'nota.md', { type: 'text/markdown' })]);
    await waitFor(() => expect(screen.queryByText('Subiendo…')).toBeNull());
    const tray = screen.getByRole('list', { name: 'Adjuntos' });
    expect(within(tray).getAllByRole('listitem')).toHaveLength(2);
    expect(within(tray).getByText('nota.md')).toBeTruthy();
    expect(within(tray).getByText('4 B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto.png' }));
    expect(screen.queryByAltText('foto.png')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({ text: '', attachments: [ready('attachment-2', 'nota.md')] }));
  });

  it('la barra de esfuerzo va en la barra del composer, junto a la ficha de modo, y avisa el nivel elegido', async () => {
    const onEffortChange = vi.fn();
    setup({ effort: 'high', onEffortChange });
    const trigger = screen.getByRole('button', { name: /Esfuerzo: Profundo/ });
    expect(trigger.parentElement?.contains(screen.getByRole('button', { name: 'Cambiar modo: Auto' }))).toBe(true);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Esfuerzo de razonamiento' });
    fireEvent.keyDown(within(dialog).getByRole('slider', { name: 'Esfuerzo de razonamiento' }), { key: 'ArrowLeft' });
    expect(onEffortChange).toHaveBeenCalledWith('medium');
  });

  it('ofrece los niveles que pide la vista y se deshabilita con el composer', async () => {
    const onEffortChange = vi.fn();
    setup({ effort: 'xhigh', onEffortChange, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
    fireEvent.click(screen.getByRole('button', { name: /Esfuerzo: Muy profundo/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(within(dialog).getByRole('slider'), { key: 'ArrowRight' });
    expect(onEffortChange).toHaveBeenCalledWith('max');
    cleanup();
    setup({ effort: 'low', onEffortChange, isDisabled: true });
    const disabled = screen.getByRole('button', { name: /Esfuerzo: Rápido/ });
    expect(disabled.hasAttribute('disabled') || disabled.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('sin onEffortChange no muestra la barra de esfuerzo', () => {
    setup({ effort: 'high' });
    expect(screen.queryByRole('button', { name: /Esfuerzo/ })).toBeNull();
  });

  it('con dos composers montados, solo el último atiende al soltar y al pegar fuera del campo', async () => {
    const first = vi.fn().mockResolvedValue(attachment);
    const second = vi.fn().mockResolvedValue(attachment);
    setup({ onAttach: first });
    const other = render(<Composer placeholder="Otro" mode="plan" onModeChange={vi.fn()} onAttach={second} onSubmit={vi.fn()} />);
    drop([image()]);
    fireEvent.paste(document.body, { clipboardData: { files: [image()] } });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    expect(first).not.toHaveBeenCalled();
    other.unmount();
    drop([image()]);
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
  });
});
