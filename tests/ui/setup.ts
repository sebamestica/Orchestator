// Setup de Vitest (setupFiles en vitest.config.ts): corre antes de cada archivo de prueba.
// Solo actúa en las pruebas con DOM (happy-dom); las del núcleo no cargan React ni Testing Library.
if (typeof document !== 'undefined') {
  // Desde @testing-library/react, como las pruebas: así se configura la misma instancia que usan findBy/waitFor.
  const { configure } = await import('@testing-library/react');
  // Por defecto cada findBy/waitFor se rinde a los 1000 ms, aparte del testTimeout de 60 s. Con la flota y
  // Defender cargando la CPU, un render de 100 ms llega a tardar segundos. Un fallo real sigue apareciendo a los 15 s.
  configure({ asyncUtilTimeout: 15_000 });
}

// Sin imports estáticos TypeScript lo trata como script y no admite el await de arriba.
export {};
