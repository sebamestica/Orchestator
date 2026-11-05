/**
 * Utilidades del composer para soltar y pegar archivos. Tomadas de studyapp (`shared/components/Composer` y
 * `shared/utils/grow-textarea.ts`) y adaptadas a Berland.
 */

/** El arrastre o el portapapeles trae archivos (no solo texto o enlaces). */
export function hasFiles(transfer: DataTransfer | null | undefined): transfer is DataTransfer {
  return !!transfer && Array.from(transfer.types ?? []).includes('Files');
}

/**
 * Archivos de un pegado. Si el portapapeles también trae texto (p. ej. celdas copiadas de Excel, que vienen con una
 * imagen), se pega el texto y no se adjunta nada.
 */
export function pastedFiles(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  if (Array.from(transfer.types ?? []).includes('text/plain')) return [];
  return Array.from(transfer.files ?? []);
}

/** Campo editable propio de otra parte de la vista: allí Ctrl+V no adjunta. */
export function isEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return node.isContentEditable || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
}

/** El campo crece con el texto hasta `max` px; desde ahí, se desplaza. */
export function growTextarea(node: HTMLTextAreaElement | null, max: number): void {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, max)}px`;
}

const GENERIC_PASTE = /^image\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Las capturas pegadas llegan todas como `image.png`: se renombran `imagen-pegada-N.png` para que cada ficha tenga
 * su propio nombre (y su «Quitar …» no se repita).
 */
export function namePasted(file: File, n: number): File {
  const match = GENERIC_PASTE.exec(file.name);
  if (!match) return file;
  return new File([file], `imagen-pegada-${n}.${(match[1] ?? 'png').toLowerCase()}`, { type: file.type, lastModified: file.lastModified });
}
