/**
 * Centinela de navegación de Google Classroom (SPA).
 *
 * Importante: Classroom no publica un contrato de DOM ni de URLs. Todos los selectores y patrones
 * viven en `SELECTORS` y `parseClassroomUrl` para poder ajustarlos en un único lugar.
 * La lectura es 100% pasiva: no modifica ni inyecta nada en el DOM nativo.
 */

export type ClassroomView = 'home' | 'stream' | 'classwork' | 'assignment' | 'people' | 'other';

export interface ClassroomContext {
  readonly url: string;
  readonly courseId: string | null;
  readonly assignmentId: string | null;
  readonly view: ClassroomView;
  readonly userEmail: string | null;
  /** Hay recursos/tareas visibles en el DOM (elementos clave de "Trabajo de clase"). */
  readonly hasResources: boolean;
}

export type ContextChangeReason = 'init' | 'mutation' | 'popstate' | 'hashchange' | 'navigation-api';

export interface DOMObserverOptions {
  onContextChange: (next: ClassroomContext, previous: ClassroomContext | null, reason: ContextChangeReason) => void;
  /** Ventana de agrupación de mutaciones (ms). */
  debounceMs?: number;
}

export const SELECTORS = {
  /** Recursos y tareas: atributo de material, enlaces de tarea y elementos de listas de trabajo. */
  resource: [
    '[data-material-id]',
    'a[href*="/c/"][href*="/a/"]',
    'a[href*="/c/"][href*="/details"]',
    '[role="listitem"] a[href*="/c/"]',
  ].join(', '),
  /** Enlaces a cursos (tarjetas de la home, pestañas del curso). */
  courseLink: 'a[href*="/c/"]',
  /** Selectores del selector de cuenta que identifican inequívocamente al usuario. */
  userStrong: [
    'a[href*="accounts.google.com/SignOutOptions"]',
    'a[href*="accounts.google.com/Logout"]',
    '[data-email]',
    '[data-identifier]',
  ],
  /** Selectores genéricos: solo se aceptan si el elemento está en la esquina superior derecha. */
  userGeneric: [
    'a[aria-label*="@"]',
    'button[aria-label*="@"]',
    'img[alt*="@"]',
    'header [aria-label*="@"]',
    '[role="banner"] [aria-label*="@"]',
  ],
  userMeta: 'meta[name="og-profile-acct"]',
} as const;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_ATTRIBUTES = ['aria-label', 'title', 'data-email', 'data-identifier', 'alt'] as const;
const COURSE_RE = /^\/(?:c|w)\/([A-Za-z0-9_-]{6,})/;
const URL_POLL_MS = 1000;
const ASSIGNMENT_RE = /\/a\/([A-Za-z0-9_-]{6,})/;

/* ------------------------------ Utilidades puras ------------------------------ */

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function parseClassroomUrl(href: string): Pick<ClassroomContext, 'courseId' | 'assignmentId' | 'view'> {
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return { courseId: null, assignmentId: null, view: 'other' };
  }
  // Se descarta el prefijo de cuenta (/u/0/...).
  const path = pathname.replace(/^\/u\/\d+(?=\/|$)/, '') || '/';

  const courseId = COURSE_RE.exec(path)?.[1] ?? null;
  const assignmentId = courseId ? (ASSIGNMENT_RE.exec(path)?.[1] ?? null) : null;

  let view: ClassroomView;
  if (!courseId) {
    view = path === '/' || /^\/h(\/|$)/.test(path) ? 'home' : 'other';
  } else if (assignmentId) {
    view = 'assignment';
  } else if (/^\/w\//.test(path) || /\/t\/all/.test(path)) {
    view = 'classwork';
  } else if (/\/r(\/|$)/.test(path)) {
    view = 'people';
  } else if (/^\/c\/[A-Za-z0-9_-]+\/?$/.test(path)) {
    view = 'stream';
  } else {
    view = 'other';
  }
  return { courseId, assignmentId, view };
}

function emailFromElement(element: Element): string | null {
  for (const attribute of EMAIL_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    const match = value ? EMAIL_RE.exec(value) : null;
    if (match) return match[0].toLowerCase();
  }
  const text = element.textContent;
  if (text && text.length <= 200) {
    const match = EMAIL_RE.exec(text);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function isInTopRightCorner(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.top >= 0 && rect.top < 100 && rect.right > window.innerWidth * 0.5;
}

/** Busca el correo institucional con una cascada de selectores de más a menos específico. */
export function extractUserEmail(doc: Document): string | null {
  for (const selector of SELECTORS.userStrong) {
    for (const element of Array.from(doc.querySelectorAll(selector)).slice(0, 10)) {
      const email = emailFromElement(element);
      if (email) return email;
    }
  }
  for (const selector of SELECTORS.userGeneric) {
    for (const element of Array.from(doc.querySelectorAll(selector)).slice(0, 10)) {
      if (!isInTopRightCorner(element)) continue;
      const email = emailFromElement(element);
      if (email) return email;
    }
  }
  const metaContent = doc.querySelector(SELECTORS.userMeta)?.getAttribute('content');
  const metaMatch = metaContent ? EMAIL_RE.exec(metaContent) : null;
  return metaMatch ? metaMatch[0].toLowerCase() : null;
}

function sameContext(a: ClassroomContext, b: ClassroomContext): boolean {
  return (
    a.url === b.url &&
    a.courseId === b.courseId &&
    a.assignmentId === b.assignmentId &&
    a.view === b.view &&
    a.userEmail === b.userEmail &&
    a.hasResources === b.hasResources
  );
}

/* ------------------------------ Observador ------------------------------ */

export class DOMObserver {
  private readonly options: DOMObserverOptions;
  private readonly debounceMs: number;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private urlPoll: ReturnType<typeof setInterval> | null = null;
  private current: ClassroomContext | null = null;
  private pendingReason: ContextChangeReason = 'mutation';

  constructor(options: DOMObserverOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 250;
  }

  getContext(): ClassroomContext | null {
    return this.current;
  }

  start(): void {
    if (this.observer) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => this.start(), { once: true });
      return;
    }
    this.evaluate('init');

    this.observer = new MutationObserver(() => this.schedule('mutation'));
    this.observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('hashchange', this.onHashChange);
    this.navigationApi()?.addEventListener('navigatesuccess', this.onNavigationApi);

    // Red de seguridad: un history.pushState sin mutaciones de DOM también se detecta (comparación barata).
    this.urlPoll = setInterval(() => {
      if (this.current && location.href !== this.current.url) this.schedule('mutation');
    }, URL_POLL_MS);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.urlPoll !== null) clearInterval(this.urlPoll);
    this.urlPoll = null;
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('hashchange', this.onHashChange);
    this.navigationApi()?.removeEventListener('navigatesuccess', this.onNavigationApi);
  }

  /** Fuerza una reevaluación inmediata (p. ej. tras detectar que el correo ya está disponible). */
  refresh(): void {
    this.evaluate('mutation');
  }

  private readonly onPopState = (): void => this.schedule('popstate');
  private readonly onHashChange = (): void => this.schedule('hashchange');
  private readonly onNavigationApi = (): void => this.schedule('navigation-api');

  private navigationApi(): EventTarget | null {
    return (window as unknown as { navigation?: EventTarget }).navigation ?? null;
  }

  /**
   * Agrupa ráfagas de mutaciones: como mucho una evaluación por ventana, de modo que el flujo
   * continuo de cambios de Classroom no puede retrasar indefinidamente la detección.
   */
  private schedule(reason: ContextChangeReason): void {
    if (reason !== 'mutation') this.pendingReason = reason;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const effective = this.pendingReason;
      this.pendingReason = 'mutation';
      this.evaluate(effective);
    }, this.debounceMs);
  }

  private snapshot(): ClassroomContext {
    const url = location.href;
    const parsed = parseClassroomUrl(url);
    const urlChanged = this.current === null || this.current.url !== url;
    const userEmail = urlChanged || this.current?.userEmail == null ? extractUserEmail(document) : this.current.userEmail;
    return {
      url,
      ...parsed,
      userEmail: userEmail ?? this.current?.userEmail ?? null,
      hasResources: document.querySelector(SELECTORS.resource) !== null,
    };
  }

  private evaluate(reason: ContextChangeReason): void {
    const next = this.snapshot();
    const previous = this.current;
    if (previous && sameContext(previous, next)) return;
    this.current = next;
    this.options.onContextChange(next, previous, reason);
  }
}
