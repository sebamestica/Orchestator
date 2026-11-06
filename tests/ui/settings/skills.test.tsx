// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsSection } from '../../../src/ui/features/settings/SkillsSection.tsx';
import { fakeCore, resetStore } from './helpers.ts';

const QUARANTINED = { id: 'pdf-20261104-105000-abc123', name: 'pdf', description: 'Lee PDFs', fileCount: 3, scripts: [], warnings: [], license: { declared: 'MIT', files: [] } };

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Skills › cuarentena', () => {
  it('carga la cuarentena del núcleo al montar, la conserva al volver y la quita al rechazar', async () => {
    let pending = [QUARANTINED];
    const calls = fakeCore({
      'GET /skills': () => ({ body: { skills: [] } }),
      'GET /skills/quarantine': () => ({ body: { skills: pending } }),
      [`POST /skills/${QUARANTINED.id}/reject`]: () => {
        pending = [];
        return { body: { result: QUARANTINED.id } };
      },
    });

    const first = render(<SkillsSection />);
    expect(await screen.findByText('En cuarentena')).toBeTruthy();
    expect(screen.getByText('pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Aprobar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rechazar/ })).toBeTruthy();

    // Cambiar de sección desmonta la vista; al volver, la cuarentena sigue ahí.
    first.unmount();
    render(<SkillsSection />);
    expect(await screen.findByText('En cuarentena')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Rechazar/ }));
    expect(await screen.findByText(/«pdf» descartada/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('En cuarentena')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.path === `/skills/${QUARANTINED.id}/reject`)).toBe(true);
  });
});
