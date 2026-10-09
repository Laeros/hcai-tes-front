/**
 * Content script principal: ciclo de vida de la inyección.
 *
 * Garantías anti-duplicación:
 *  1. Bandera global por mundo aislado (evita doble ejecución, p. ej. tras chrome.scripting).
 *  2. Un único host #hcai-host-root: si existe uno huérfano (extensión recargada) se reemplaza.
 *  3. Vigilante de <html>: si la SPA elimina el host, se vuelve a adjuntar sin recrear React.
 *  4. Si el contexto de la extensión se invalida, todo se desmonta de forma ordenada.
 */
import overlayCss from '../styles/overlay.css?inline';
import { HCAIOverlay, type HCAIOverlayProps } from '../components/HCAIOverlay';
import { withShadowContainer } from '../components/ShadowContainer';
import { isExtensionAlive, onContextInvalidated, sendRequest } from '../services/messaging';
import type { TelemetryPayload, TrackFn } from '../types/telemetry';
import { DOMObserver, type ClassroomContext } from './domObserver';
import { TelemetryTracker } from './telemetryTracker';

export const HOST_ID = 'hcai-host-root';
const BOOT_FLAG = '__HCAI_CONTENT_BOOTSTRAPPED__';

function bootstrap(): void {
  const flags = window as unknown as Record<string, unknown>;
  if (flags[BOOT_FLAG] === true || !isExtensionAlive()) return;
  flags[BOOT_FLAG] = true;

  let context: ClassroomContext | null = null;
  let tornDown = false;

  const mountOverlay = withShadowContainer<HCAIOverlayProps>(HCAIOverlay, {
    hostId: HOST_ID,
    cssText: overlayCss,
    zIndex: 999999,
  });

  const send = (event: TelemetryPayload): void => {
    // Fire-and-forget: la UI de Classroom nunca espera a la red.
    void sendRequest({ type: 'TELEMETRY_EVENT', event }).catch(() => undefined);
  };

  const tracker = new TelemetryTracker({
    getContext: () => context,
    send,
    ignoredHostId: HOST_ID,
  });

  const track: TrackFn = (type, payload) => tracker.track(type, payload);
  const overlay = mountOverlay({ context, track });

  const observer = new DOMObserver({
    onContextChange: (next, previous) => {
      context = next;
      overlay.render({ context, track });
      tracker.handleContextChange(next, previous);
    },
  });

  // Re-adjunta el host si la SPA lo elimina del árbol (el shadow root y React se conservan).
  const hostWatcher = new MutationObserver(() => {
    if (!tornDown) overlay.ensureAttached();
  });
  hostWatcher.observe(document.documentElement, { childList: true });

  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    hostWatcher.disconnect();
    observer.stop();
    tracker.stop();
    overlay.unmount();
  };
  onContextInvalidated(teardown);

  tracker.start();
  observer.start();
}

bootstrap();
