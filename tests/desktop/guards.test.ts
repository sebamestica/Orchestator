import { describe, expect, it } from 'vitest';
import { allowedExternalUrl, classifyNavigation, isSameOrigin, MAX_EXTERNAL_URL } from '../../apps/desktop/src/lib/external-url.ts';
import { hasNoArgs, isTrustedSender, isTrustedWindowSender, parseWindowAction } from '../../apps/desktop/src/lib/ipc-guard.ts';

const APP = 'http://127.0.0.1:47811';

describe('allowedExternalUrl', () => {
  it('acepta https y http://127.0.0.1, normalizados', () => {
    expect(allowedExternalUrl('https://www.canva.com/oauth?x=1')).toBe('https://www.canva.com/oauth?x=1');
    expect(allowedExternalUrl('HTTPS://Example.com')).toBe('https://example.com/');
    expect(allowedExternalUrl('http://127.0.0.1:9222/json')).toBe('http://127.0.0.1:9222/json');
    expect(allowedExternalUrl('http://127.0.0.1')).toBe('http://127.0.0.1/');
  });

  it.each([
    'http://example.com',
    'http://localhost:47811/',
    'http://127.0.0.1.evil.com/',
    'http://127.0.0.2/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-settings:privacy',
    'search-ms:query=x',
    'vbscript:msgbox',
    'ftp://example.com/',
    'https://usuario:clave@example.com/',
    'http://127.0.0.1@evil.com/',
    '//example.com',
    'no es una url',
    '',
  ])('rechaza %s', (url) => {
    expect(allowedExternalUrl(url)).toBeNull();
  });

  it('rechaza lo que no es texto y las URL enormes', () => {
    expect(allowedExternalUrl(undefined)).toBeNull();
    expect(allowedExternalUrl(42)).toBeNull();
    expect(allowedExternalUrl({ href: 'https://example.com' })).toBeNull();
    expect(allowedExternalUrl(`https://example.com/${'a'.repeat(MAX_EXTERNAL_URL)}`)).toBeNull();
  });
});

describe('navegación', () => {
  it('solo el propio origen navega dentro de la ventana', () => {
    expect(isSameOrigin('http://127.0.0.1:47811/#/proyecto/x', APP)).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:47812/', APP)).toBe(false);
    expect(isSameOrigin('http://localhost:47811/', APP)).toBe(false);
    expect(isSameOrigin(undefined, APP)).toBe(false);
  });

  it('un archivo soltado (file:) se bloquea y un enlace https va al navegador', () => {
    expect(classifyNavigation('file:///C:/Users/yo/Escritorio/nota.txt', APP)).toBe('block');
    expect(classifyNavigation('https://github.com/', APP)).toBe('external');
    expect(classifyNavigation('http://127.0.0.1:47811/assets/x.js', APP)).toBe('allow');
    expect(classifyNavigation('data:text/html,hola', APP)).toBe('block');
  });
});

describe('remitente IPC', () => {
  it('acepta solo el marco principal con una página del propio origen', () => {
    expect(isTrustedSender({ url: 'http://127.0.0.1:47811/', isMainFrame: true }, APP)).toBe(true);
    expect(isTrustedSender({ url: 'http://127.0.0.1:47811/#/ajustes', isMainFrame: true }, APP)).toBe(true);
  });

  it('rechaza iframes, otros orígenes, marcos destruidos y remitentes de otra ventana', () => {
    expect(isTrustedSender({ url: 'http://127.0.0.1:47811/', isMainFrame: false }, APP)).toBe(false);
    expect(isTrustedSender({ url: 'https://evil.example/', isMainFrame: true }, APP)).toBe(false);
    expect(isTrustedSender({ url: 'http://127.0.0.1:5174/', isMainFrame: true }, APP)).toBe(false);
    expect(isTrustedSender({ url: 'data:text/html,x', isMainFrame: true }, APP)).toBe(false);
    expect(isTrustedSender({ url: undefined, isMainFrame: true }, APP)).toBe(false);
    expect(isTrustedSender(null, APP)).toBe(false);
  });

  it('en desarrollo el origen confiable es el de Vite', () => {
    const dev = 'http://127.0.0.1:5174';
    expect(isTrustedSender({ url: 'http://127.0.0.1:5174/', isMainFrame: true }, dev)).toBe(true);
    expect(isTrustedSender({ url: 'http://127.0.0.1:47811/', isMainFrame: true }, dev)).toBe(false);
  });

  it('los botones de la ventana también valen desde la página de estado, pero solo mientras se muestra', () => {
    const status = { url: 'data:text/html;charset=utf-8,%3C!doctype', isMainFrame: true };
    expect(isTrustedWindowSender(status, APP, true)).toBe(true);
    expect(isTrustedWindowSender(status, APP, false)).toBe(false);
    expect(isTrustedWindowSender({ ...status, isMainFrame: false }, APP, true)).toBe(false);
    expect(isTrustedWindowSender({ url: 'https://evil.example/', isMainFrame: true }, APP, true)).toBe(false);
    expect(isTrustedWindowSender({ url: 'http://127.0.0.1:47811/', isMainFrame: true }, APP, false)).toBe(true);
  });

  it('valida la acción de ventana y la ausencia de argumentos', () => {
    expect(parseWindowAction('minimize')).toBe('minimize');
    expect(parseWindowAction('toggle-maximize')).toBe('toggle-maximize');
    expect(parseWindowAction('close')).toBe('close');
    expect(parseWindowAction('destroy')).toBeNull();
    expect(parseWindowAction(['close'])).toBeNull();
    expect(parseWindowAction(undefined)).toBeNull();
    expect(hasNoArgs([])).toBe(true);
    expect(hasNoArgs([undefined])).toBe(false);
  });
});
