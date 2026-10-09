/**
 * Motor de telemetría conductual: clickstream sobre recursos/tareas y Dwell Time (> 2 s).
 *
 * Privacidad por diseño: nunca se envía texto del DOM, solo identificadores técnicos (IDs de
 * material/tarea, etiqueta HTML, coordenadas y la ruta de la URL sin parámetros).
 */
import {
  parseClassroomUrl,
  pathOf,
  SELECTORS,
  type ClassroomContext,
} from './domObserver';
import type { TelemetryEventType, TelemetryPayload, TelemetryPayloadMap, TelemetryRequest } from '../types/telemetry';

export const MIN_DWELL_MS = 2000;
const MAX_DWELL_MS = 86_400_000;
const MAX_ID_LENGTH = 200;

type ResourceKind = 'MATERIAL' | 'ASSIGNMENT';
type SessionEndReason = 'navigation' | 'replaced' | 'pagehide' | 'stop';

interface DwellSession {
  resourceId: string;
  resourceKind: ResourceKind;
  courseId: string;
  accumulatedMs: number;
  /** Instante (performance.now) en que se reanudó el conteo; null si la pestaña está oculta. */
  resumedAt: number | null;
}

export interface TelemetryTrackerOptions {
  getContext: () => ClassroomContext | null;
  send: (event: TelemetryPayload) => void;
  /** Id del host del overlay: los clics dentro del widget no se registran como clickstream de Classroom. */
  ignoredHostId: string;
  minDwellMs?: number;
}

const SUBMIT_LABEL_RE = /^(entregar|volver a entregar|turn in|resubmit|marcar como completada|mark as done)$/i;

function truncate(value: string): string {
  return value.length > MAX_ID_LENGTH ? value.slice(0, MAX_ID_LENGTH) : value;
}

function now(): number {
  return performance.now();
}

export class TelemetryTracker {
  private readonly options: TelemetryTrackerOptions;
  private readonly minDwellMs: number;
  private session: DwellSession | null = null;
  private running = false;
  private readonly attempts = new Map<string, { count: number; lastAt: number }>();

  constructor(options: TelemetryTrackerOptions) {
    this.options = options;
    this.minDwellMs = options.minDwellMs ?? MIN_DWELL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('click', this.onClick, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener('click', this.onClick, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.endSession('stop');
  }

  /** Registro explícito de un evento (lo usan el tracker y los componentes de UI). */
  track<T extends TelemetryEventType>(
    type: T,
    payload: TelemetryPayloadMap[T],
    overrides: { courseId?: string } = {},
  ): void {
    const context = this.options.getContext();
    const courseId = overrides.courseId ?? context?.courseId ?? null;
    const email = context?.userEmail ?? null;
    if (!courseId || !email) return; // sin curso o usuario identificado no hay telemetría atribuible

    const event: TelemetryRequest<T> = {
      raw_user_id: email,
      event_type: type,
      course_id: courseId,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.options.send(event as TelemetryPayload);
  }

  /** Lo invoca el DOMObserver en cada cambio de contexto (curso, tarea, vista o usuario). */
  handleContextChange(next: ClassroomContext, previous: ClassroomContext | null): void {
    const pathChanged = previous === null || pathOf(previous.url) !== pathOf(next.url);
    if (pathChanged) {
      if (this.session && this.session.resourceId !== next.assignmentId) this.endSession('navigation');
      if (next.view === 'assignment' && next.assignmentId && next.courseId && !this.session) {
        this.beginSession(next.assignmentId, 'ASSIGNMENT', next.courseId);
      }
    }

    const navigated =
      previous === null ||
      previous.courseId !== next.courseId ||
      previous.assignmentId !== next.assignmentId ||
      previous.view !== next.view;
    const identityResolved = previous?.userEmail == null && next.userEmail !== null;

    if ((navigated || identityResolved) && next.courseId && next.userEmail) {
      // La navegación se registra como CLICK de tipo NAVIGATION; además identifica al usuario
      // ante el backend para conocer la bandera de Cold-Start.
      this.track('CLICK', {
        element_id: `nav:${next.view}`,
        element_tag: 'NAVIGATION',
        page_url: pathOf(next.url),
      });
    }
  }

  /* ------------------------------ Sesiones de Dwell Time ------------------------------ */

  private beginSession(resourceId: string, resourceKind: ResourceKind, courseId: string): void {
    if (this.session?.resourceId === resourceId) return;
    this.endSession('replaced');
    this.session = {
      resourceId: truncate(resourceId),
      resourceKind,
      courseId,
      accumulatedMs: 0,
      resumedAt: document.visibilityState === 'visible' ? now() : null,
    };
    this.track('MATERIAL_VIEW', { material_id: truncate(resourceId), material_type: resourceKind }, { courseId });
  }

  private endSession(reason: SessionEndReason): void {
    const session = this.session;
    if (!session) return;
    this.session = null;

    const total = session.accumulatedMs + (session.resumedAt !== null ? now() - session.resumedAt : 0);
    if (total < this.minDwellMs) return;
    this.track(
      'DWELL_TIME',
      {
        dwell_time_ms: Math.min(MAX_DWELL_MS, Math.round(total)),
        material_id: session.resourceId,
        material_type: session.resourceKind,
        end_reason: reason,
      },
      { courseId: session.courseId },
    );
  }

  /* ------------------------------ Listeners ------------------------------ */

  private readonly onVisibilityChange = (): void => {
    const session = this.session;
    if (!session) return;
    if (document.visibilityState === 'hidden' && session.resumedAt !== null) {
      session.accumulatedMs += now() - session.resumedAt;
      session.resumedAt = null;
    } else if (document.visibilityState === 'visible' && session.resumedAt === null) {
      session.resumedAt = now();
    }
  };

  private readonly onPageHide = (): void => {
    this.endSession('pagehide');
  };

  private readonly onClick = (event: MouseEvent): void => {
    try {
      this.processClick(event);
    } catch {
      /* el tracker nunca debe interferir con Classroom */
    }
  };

  private processClick(event: MouseEvent): void {
    const { ignoredHostId } = this.options;
    const insideOverlay = event
      .composedPath()
      .some((node) => node instanceof Element && node.id === ignoredHostId);
    if (insideOverlay) return;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const resourceElement = target.closest(SELECTORS.resource);
    if (resourceElement) {
      const resource = this.resolveResource(resourceElement);
      this.track('CLICK', {
        element_id: truncate(resource ? `${resource.kind.toLowerCase()}:${resource.id}` : resourceElement.tagName.toLowerCase()),
        element_tag: resourceElement.tagName,
        x: Math.max(0, Math.round(event.clientX)),
        y: Math.max(0, Math.round(event.clientY)),
        page_url: location.pathname,
      });
      const courseId = this.options.getContext()?.courseId;
      if (resource && courseId) this.beginSession(resource.id, resource.kind, courseId);
      return;
    }

    this.processSubmissionClick(target);
  }

  private resolveResource(element: Element): { id: string; kind: ResourceKind } | null {
    const materialId = element.closest('[data-material-id]')?.getAttribute('data-material-id');
    if (materialId) return { id: truncate(materialId), kind: 'MATERIAL' };

    const anchor = element.closest('a[href]');
    if (anchor instanceof HTMLAnchorElement) {
      const { assignmentId } = parseClassroomUrl(anchor.href);
      if (assignmentId) return { id: truncate(assignmentId), kind: 'ASSIGNMENT' };
    }
    return null;
  }

  /**
   * Heurística de reintentos de entrega: a partir del segundo clic en un botón de entrega de la
   * misma tarea (durante la sesión de la página) se emite SUBMISSION_RETRY. El conteo no sobrevive
   * a recargas.
   */
  private processSubmissionClick(target: Element): void {
    const context = this.options.getContext();
    if (!context || context.view !== 'assignment' || !context.assignmentId) return;

    const button = target.closest('button, [role="button"]');
    const label = button?.textContent?.trim();
    if (!button || !label || label.length > 40 || !SUBMIT_LABEL_RE.test(label)) return;

    const assignmentId = context.assignmentId;
    const previous = this.attempts.get(assignmentId);
    const count = (previous?.count ?? 0) + 1;
    const timestamp = Date.now();
    this.attempts.set(assignmentId, { count, lastAt: timestamp });

    if (count >= 2) {
      this.track('SUBMISSION_RETRY', {
        assignment_id: assignmentId,
        attempt_number: count,
        time_since_last_attempt_ms: previous ? timestamp - previous.lastAt : undefined,
      });
    }
  }
}
