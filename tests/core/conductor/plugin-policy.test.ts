import { describe, expect, it } from 'vitest';
import { pluginToolClass, pluginToolOf } from '../../../src/core/conductor/plugin-policy.ts';

describe('clase de las herramientas de plugins', () => {
  const chrome = (tool: string, input: unknown = {}) => pluginToolClass('chrome-personal', tool, input);

  it('Chrome: mirar es lectura; clic, rellenar y lo desconocido son acción', () => {
    for (const tool of ['take_snapshot', 'list_pages', 'take_screenshot', 'wait_for', 'get_network_request']) expect(chrome(tool), tool).toBe('lectura');
    for (const tool of ['click', 'fill', 'fill_form', 'type_text', 'press_key', 'upload_file', 'handle_dialog', 'close_page', 'herramienta_nueva']) {
      expect(chrome(tool), tool).toBe('accion');
    }
  });

  it('Chrome: evaluate_script, initScript y las URL que no son web son script', () => {
    expect(chrome('evaluate_script', { function: '() => 1' })).toBe('script');
    expect(chrome('navigate_page', { initScript: 'x' })).toBe('script');
    expect(chrome('navigate_page', { url: 'javascript:alert(1)' })).toBe('script');
    expect(chrome('navigate_page', { url: 'JAVASCRIPT:alert(1)' })).toBe('script');
    expect(chrome('new_page', { url: 'data:text/html,x' })).toBe('script');
    expect(chrome('navigate_page', { url: 'https://a.test' })).toBe('lectura');
    expect(chrome('new_page', { url: 'about:blank' })).toBe('lectura');
    expect(chrome('navigate_page', { type: 'back' })).toBe('lectura');
  });

  it('Canva: get-, list- y search- son lectura; el resto publica', () => {
    expect(pluginToolClass('canva', 'get-design-content', {})).toBe('lectura');
    expect(pluginToolClass('canva', 'search_designs', {})).toBe('lectura');
    expect(pluginToolClass('canva', 'resolve-shortlink', {})).toBe('lectura');
    for (const tool of ['commit-editing-transaction', 'upload-asset-from-url', 'start-editing-transaction', 'generate-design']) {
      expect(pluginToolClass('canva', tool, {}), tool).toBe('publicar');
    }
  });

  it('otro servidor: acción; pluginToolOf separa servidor y herramienta', () => {
    expect(pluginToolClass('otro', 'leer', {})).toBe('accion');
    expect(pluginToolOf('mcp__chrome-personal__click', ['canva', 'chrome-personal'])).toEqual({ server: 'chrome-personal', tool: 'click' });
    expect(pluginToolOf('mcp__orquestador__estado', ['canva', 'chrome-personal'])).toBeUndefined();
    expect(pluginToolOf('mcp__canva__', ['canva'])).toBeUndefined();
  });
});
