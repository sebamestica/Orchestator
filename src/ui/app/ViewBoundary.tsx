import { Button } from '@heroui/react';
import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { EmptyState } from '../components/EmptyState.tsx';

interface ViewBoundaryProps {
  children: ReactNode;
  /** Al cambiar (por ejemplo, la ruta) se quita el aviso y se vuelve a intentar la vista. */
  resetKey?: string;
  /** Contenedor del aviso; por defecto ocupa el hueco de la vista. */
  className?: string;
}

interface ViewBoundaryState {
  error: Error | null;
}

/**
 * Atrapa lo que falla dentro de una vista (un trozo perezoso que ya no existe tras recompilar `dist/ui`,
 * o una excepción de render) para que la barra de título y la lateral sigan montadas y se pueda recargar.
 * Con `resetKey` por ruta, navegar quita el aviso sin volver a montar la vista cuando no falló.
 * React ya informa del error por consola, así que aquí no se registra otra vez.
 */
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  override state: ViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ViewBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(prev: ViewBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.className ?? 'flex flex-1 items-center justify-center'}>
        <EmptyState
          icon={TriangleAlert}
          title="No se pudo cargar esta vista"
          description={error.message}
          action={
            <Button variant="secondary" size="sm" onPress={() => window.location.reload()}>
              Recargar
            </Button>
          }
        />
      </div>
    );
  }
}
