// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, type Route } from '../../src/ui/app/routes.ts';
import { takeTokenFromLocation } from '../../src/ui/api/bridge.ts';
import { EmptyState } from '../../src/ui/components/EmptyState.tsx';
import { Hammer } from 'lucide-react';

describe('rutas de la interfaz', () => {
  const cases: Route[] = [
    { name: 'home' },
    { name: 'project', projectId: 'vetworld' },
    { name: 'project', projectId: 'vetworld', chatId: 'chat_abc123' },
    { name: 'board' },
    { name: 'board', projectId: 'orquestador' },
    { name: 'standalone' },
    { name: 'standalone', chatId: 'chat_x1y2z3' },
    { name: 'settings', section: 'mente' },
    { name: 'plugins' },
  ];
  it.each(cases)('ida y vuelta %o', (route) => {
    expect(parseRoute(routeHash(route))).toEqual(route);
  });
  it('Conversaciones vive en #/conversaciones; los enlaces viejos #/suelto siguen abriendo lo mismo', () => {
    expect(routeHash({ name: 'standalone' })).toBe('#/conversaciones');
    expect(routeHash({ name: 'standalone', chatId: 'chat_x1y2z3' })).toBe('#/conversaciones/chat_x1y2z3');
    expect(parseRoute('#/suelto')).toEqual({ name: 'standalone' });
    expect(parseRoute('#/suelto/chat_x1y2z3')).toEqual({ name: 'standalone', chatId: 'chat_x1y2z3' });
  });
  it('una sección desconocida cae en general', () => {
    expect(parseRoute('#/ajustes/nada')).toEqual({ name: 'settings', section: 'general' });
  });
});

describe('token en el fragmento', () => {
  it('se toma del fragmento y se borra de la barra de direcciones', () => {
    const token = 'a'.repeat(43);
    window.history.replaceState(null, '', `/#t=${token}`);
    expect(takeTokenFromLocation()).toBe(token);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('orq.token')).toBe(token);
  });
  it('conserva la ruta cuando el token viene después de ella', () => {
    const token = 'b'.repeat(43);
    window.history.replaceState(null, '', `/#/ajustes/mente&t=${token}`);
    expect(takeTokenFromLocation()).toBe(token);
    expect(window.location.hash).toBe('#/ajustes/mente');
    expect(parseRoute(window.location.hash)).toEqual({ name: 'settings', section: 'mente' });
  });
});

describe('componentes base', () => {
  it('EmptyState muestra título y descripción', () => {
    render(<EmptyState icon={Hammer} title="Título" description="Texto" />);
    expect(screen.getByText('Título')).toBeTruthy();
    expect(screen.getByText('Texto')).toBeTruthy();
  });
});
