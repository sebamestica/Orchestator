import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { applyStoredTheme } from './app/use-appearance.ts';
import './styles/index.css';

// Antes del primer render: el último tema aplicado, para no abrir en oscuro con el tema claro.
applyStoredTheme();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
