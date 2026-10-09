import { createContext, createElement, useContext, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface ShadowContainerOptions {
  /** Id único del elemento host en el DOM de la página. */
  hostId: string;
  /** CSS del widget (texto). Se aplica solo dentro del shadowRoot. */
  cssText: string;
  zIndex?: number;
}

export interface ShadowAppHandle<P> {
  readonly host: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  /** Renderiza (o actualiza) el componente con nuevas props. */
  render(props: P): void;
  /** Re-adjunta el host al documento si la SPA lo eliminó. */
  ensureAttached(): void;
  unmount(): void;
}

const ShadowRootContext = createContext<ShadowRoot | null>(null);

/** Acceso al shadowRoot desde cualquier componente montado con `withShadowContainer`. */
export function useShadowRoot(): ShadowRoot {
  const shadowRoot = useContext(ShadowRootContext);
  if (!shadowRoot) throw new Error('useShadowRoot debe usarse dentro de withShadowContainer.');
  return shadowRoot;
}

function applyHostStyles(host: HTMLElement, zIndex: number): void {
  // Los estilos en línea con !important ganan a cualquier regla de la hoja de Classroom.
  const styles: Array<[string, string]> = [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'fixed'],
    ['top', '0'],
    ['left', '0'],
    ['width', '0'],
    ['height', '0'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['overflow', 'visible'],
    ['z-index', String(zIndex)],
    // El host no intercepta clics; solo los elementos del widget los reciben (pointer-events: auto).
    ['pointer-events', 'none'],
  ];
  styles.forEach(([property, value]) => host.style.setProperty(property, value, 'important'));
}

function applyStyles(shadowRoot: ShadowRoot, cssText: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shadowRoot.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = cssText;
    shadowRoot.appendChild(style);
  }
}

/**
 * HOC de encapsulamiento: devuelve una función que crea el host `#hostId`, adjunta un shadowRoot
 * `open`, inyecta la hoja de estilos interna y monta el componente con `createRoot`.
 */
export function withShadowContainer<P extends object>(
  Component: ComponentType<P>,
  options: ShadowContainerOptions,
): (initialProps: P) => ShadowAppHandle<P> {
  return (initialProps: P): ShadowAppHandle<P> => {
    // Anti-duplicados: cualquier host previo con el mismo id es huérfano y se reemplaza.
    document.getElementById(options.hostId)?.remove();

    const host = document.createElement('div');
    host.id = options.hostId;
    applyHostStyles(host, options.zIndex ?? 999999);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    applyStyles(shadowRoot, options.cssText);

    const mountPoint = document.createElement('div');
    mountPoint.setAttribute('data-hcai-root', '');
    shadowRoot.appendChild(mountPoint);
    document.documentElement.appendChild(host);

    const root: Root = createRoot(mountPoint);
    let unmounted = false;

    const render = (props: P): void => {
      if (unmounted) return;
      root.render(
        <ShadowRootContext.Provider value={shadowRoot}>{createElement(Component, props)}</ShadowRootContext.Provider>,
      );
    };

    render(initialProps);

    return {
      host,
      shadowRoot,
      render,
      ensureAttached: () => {
        if (!unmounted && !host.isConnected) document.documentElement.appendChild(host);
      },
      unmount: () => {
        if (unmounted) return;
        unmounted = true;
        root.unmount();
        host.remove();
      },
    };
  };
}
