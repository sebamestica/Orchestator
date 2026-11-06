// Las pruebas con repos git reales corren en un solo archivo (un solo worker, en serie):
// en Windows cada git.exe es caro y, repartidas en varios workers, ahogaban al resto de la suite.
import { afterAll, vi } from 'vitest';
import { disposeRepoTemplate } from './helpers.ts';
import './manager.cases.ts';
import './integrate.cases.ts';
import './push-block.cases.ts';
import './review-agy.cases.ts';
import './hardening.cases.ts';
import './limpieza.cases.ts';

// Tope único para todos los `.cases.ts` (con la flota corriendo en paralelo el equipo va cargado). Va aquí y no en
// cada archivo: `vi.setConfig` pisa la configuración del archivo entero y ganaba el último import. Las pruebas que
// necesitan más lo dan en el tercer argumento de `it`.
vi.setConfig({ testTimeout: 120_000 });

// La plantilla de repos y los restos que `cleanup` no pudo borrar: Vitest mata el worker sin emitir `exit`.
afterAll(disposeRepoTemplate, 120_000);
