/**
 * Service Worker (MV3): puente de red entre Google Classroom y el backend FastAPI.
 *
 * - Cola asíncrona de telemetría persistida en chrome.storage.session (el correo en bruto nunca se
 *   escribe en disco; sobrevive a la suspensión del worker pero no al cierre del navegador).
 * - Reintentos con backoff exponencial; el orden de los eventos se conserva.
 * - Identidad (id_hash + bandera cold_start_required) cacheada y notificada a las pestañas.
 * - Recomendaciones: red -> caché de sesión -> fallback vacío.
 */
import {
  getAdaptiveRecommendations,
  isAdaptiveRecommendations,
  sendTelemetry,
  submitColdStartAnswers,
} from '../services/apiService';
import type {
  ExtensionRequest,
  IdentityUpdatedNotification,
  PublicIdentity,
  ResponseMap,
} from '../types/messages';
import type { ColdStartPayload, ColdStartResult, RecommendationsResult } from '../types/recommendation';
import { TELEMETRY_EVENT_TYPES, type TelemetryPayload, type TelemetryResponse } from '../types/telemetry';

const CLASSROOM_ORIGIN = 'https://classroom.google.com';
const CLASSROOM_URL_PATTERN = `${CLASSROOM_ORIGIN}/*`;

const KEYS = {
  queue: 'hcai.queue',
  identity: 'hcai.identity',
  pendingColdStart: 'hcai.pendingColdStart',
  recsPrefix: 'hcai.recs.',
} as const;

const MAX_QUEUE_SIZE = 500;
const MAX_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

interface QueueItem {
  id: string;
  event: TelemetryPayload;
  attempts: number;
  nextAttemptAt: number;
}

interface StoredIdentity extends PublicIdentity {
  rawUserId: string;
}

interface PendingColdStart {
  payload: ColdStartPayload;
  attempts: number;
  nextAttemptAt: number;
}

/* ------------------------------ Almacenamiento serializado ------------------------------ */

let lockChain: Promise<unknown> = Promise.resolve();

/** Serializa las operaciones lectura-modificación-escritura sobre storage.session. */
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = lockChain.then(task, task);
  lockChain = run.catch(() => undefined);
  return run;
}

async function readKey<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.session.get(key);
  return stored[key] as T | undefined;
}

async function readQueue(): Promise<QueueItem[]> {
  const value = await readKey<unknown>(KEYS.queue);
  return Array.isArray(value) ? (value as QueueItem[]) : [];
}

async function writeQueue(queue: QueueItem[]): Promise<void> {
  await chrome.storage.session.set({ [KEYS.queue]: queue });
}

async function readIdentity(): Promise<StoredIdentity | null> {
  const value = await readKey<StoredIdentity>(KEYS.identity);
  return value && typeof value.idHash === 'string' ? value : null;
}

async function readPending(): Promise<PendingColdStart | null> {
  const value = await readKey<PendingColdStart>(KEYS.pendingColdStart);
  return value && value.payload ? value : null;
}

function backoffDelay(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/* ------------------------------ Identidad y notificaciones ------------------------------ */

async function notifyTabs(notification: IdentityUpdatedNotification): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: CLASSROOM_URL_PATTERN });
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await chrome.tabs.sendMessage(tab.id, notification);
        } catch {
          /* pestaña sin content script activo: se ignora */
        }
      }),
    );
  } catch {
    /* sin acceso a pestañas: se ignora */
  }
}

async function updateIdentity(rawUserId: string, idHash: string, coldStartRequired: boolean): Promise<void> {
  const changed = await withLock(async () => {
    const previous = await readIdentity();
    const pending = await readPending();
    // Si la evaluación está en cola de reenvío, no se reabre el modal por una respuesta anterior.
    const locallyCompleted = pending !== null && pending.payload.raw_user_id === rawUserId;
    const effectiveRequired = locallyCompleted ? false : coldStartRequired;

    const next: StoredIdentity = { rawUserId, idHash, coldStartRequired: effectiveRequired };
    await chrome.storage.session.set({ [KEYS.identity]: next });
    return (
      previous === null ||
      previous.rawUserId !== rawUserId ||
      previous.idHash !== idHash ||
      previous.coldStartRequired !== effectiveRequired
    );
  });
  if (changed) {
    const identity = await withLock(readIdentity);
    if (identity) {
      await notifyTabs({
        type: 'IDENTITY_UPDATED',
        rawUserId,
        identity: { idHash: identity.idHash, coldStartRequired: identity.coldStartRequired },
      });
    }
  }
}

async function applyTelemetryResponse(rawUserId: string, data: TelemetryResponse): Promise<void> {
  await updateIdentity(rawUserId, data.id_hash, data.cold_start_required);
}

/* ------------------------------ Cola de telemetría ------------------------------ */

let flushing = false;
let flushAgain = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlushAt(timestamp: number): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void flushQueue();
    },
    Math.max(0, timestamp - Date.now()),
  );
}

async function enqueue(event: TelemetryPayload): Promise<void> {
  await withLock(async () => {
    const queue = await readQueue();
    queue.push({ id: crypto.randomUUID(), event, attempts: 0, nextAttemptAt: 0 });
    await writeQueue(queue.length > MAX_QUEUE_SIZE ? queue.slice(queue.length - MAX_QUEUE_SIZE) : queue);
  });
}

async function removeItem(id: string): Promise<void> {
  await withLock(async () => {
    const queue = await readQueue();
    await writeQueue(queue.filter((item) => item.id !== id));
  });
}

async function markFailure(id: string): Promise<{ dropped: boolean; nextAttemptAt: number }> {
  return withLock(async () => {
    const queue = await readQueue();
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) return { dropped: true, nextAttemptAt: 0 };
    const item = queue[index];
    item.attempts += 1;
    item.nextAttemptAt = Date.now() + backoffDelay(item.attempts);
    const dropped = item.attempts >= MAX_ATTEMPTS;
    if (dropped) queue.splice(index, 1);
    await writeQueue(queue);
    return { dropped, nextAttemptAt: item.nextAttemptAt };
  });
}

async function flushPendingColdStart(): Promise<void> {
  const pending = await withLock(readPending);
  if (!pending || pending.nextAttemptAt > Date.now()) return;

  const result = await submitColdStartAnswers(pending.payload, { timeoutMs: 2000 });
  if (result.ok) {
    await withLock(async () => chrome.storage.session.remove(KEYS.pendingColdStart));
    await updateIdentity(pending.payload.raw_user_id, result.data.id_hash, false);
    return;
  }
  if (!result.error.retryable || pending.attempts + 1 >= MAX_ATTEMPTS) {
    await withLock(async () => chrome.storage.session.remove(KEYS.pendingColdStart));
    return;
  }
  const attempts = pending.attempts + 1;
  const nextAttemptAt = Date.now() + backoffDelay(attempts);
  await withLock(async () =>
    chrome.storage.session.set({ [KEYS.pendingColdStart]: { ...pending, attempts, nextAttemptAt } }),
  );
  scheduleFlushAt(nextAttemptAt);
}

async function flushQueue(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      await flushPendingColdStart();

      const queue = await withLock(readQueue);
      for (const item of queue) {
        if (item.nextAttemptAt > Date.now()) {
          scheduleFlushAt(item.nextAttemptAt);
          break; // se conserva el orden: el primer evento pendiente bloquea hasta su backoff
        }
        const result = await sendTelemetry(item.event);
        if (result.ok) {
          await removeItem(item.id);
          await applyTelemetryResponse(item.event.raw_user_id, result.data);
          continue;
        }
        if (!result.error.retryable) {
          await removeItem(item.id); // 4xx: el backend lo rechazó; reintentar no sirve
          continue;
        }
        const { dropped, nextAttemptAt } = await markFailure(item.id);
        if (!dropped) scheduleFlushAt(nextAttemptAt);
        break;
      }
    } while (flushAgain);
  } finally {
    flushing = false;
  }
}

/* ------------------------------ Manejadores de mensajes ------------------------------ */

async function handleColdStart(payload: ColdStartPayload): Promise<ColdStartResult> {
  const result = await submitColdStartAnswers(payload);
  if (result.ok) {
    await updateIdentity(payload.raw_user_id, result.data.id_hash, false);
    return { ok: true, queued: false, id_hash: result.data.id_hash, error: null };
  }
  if (result.error.retryable) {
    // Backend lento o caído: se guarda para reenvío y la UI se desbloquea de forma optimista.
    const attempts = 1;
    const nextAttemptAt = Date.now() + backoffDelay(attempts);
    await withLock(async () =>
      chrome.storage.session.set({ [KEYS.pendingColdStart]: { payload, attempts, nextAttemptAt } }),
    );
    const identity = await withLock(readIdentity);
    if (identity) await updateIdentity(payload.raw_user_id, identity.idHash, false);
    scheduleFlushAt(nextAttemptAt);
    return { ok: true, queued: true, id_hash: identity?.idHash ?? null, error: null };
  }
  const message =
    result.error.status === 400 || result.error.status === 422
      ? 'El servidor rechazó las respuestas. Revisa que las 5 preguntas estén contestadas.'
      : 'No fue posible guardar tu evaluación. Inténtalo de nuevo.';
  return { ok: false, queued: false, id_hash: null, error: message };
}

async function handleRecommendations(courseId: string, idHash: string): Promise<RecommendationsResult> {
  const cacheKey = `${KEYS.recsPrefix}${idHash}.${courseId}`;
  const result = await getAdaptiveRecommendations(courseId, idHash);
  if (result.source === 'network') {
    await chrome.storage.session.set({ [cacheKey]: result.data });
    return result;
  }
  const cached = await readKey<unknown>(cacheKey);
  return isAdaptiveRecommendations(cached) ? { data: cached, source: 'cache' } : result;
}

async function handleRequest(request: ExtensionRequest): Promise<ResponseMap[ExtensionRequest['type']]> {
  switch (request.type) {
    case 'TELEMETRY_EVENT': {
      await enqueue(request.event);
      void flushQueue();
      return { accepted: true };
    }
    case 'GET_IDENTITY': {
      const identity = await withLock(readIdentity);
      if (!identity || identity.rawUserId !== request.rawUserId) return null;
      return { idHash: identity.idHash, coldStartRequired: identity.coldStartRequired };
    }
    case 'GET_RECOMMENDATIONS':
      return handleRecommendations(request.courseId, request.idHash);
    case 'SUBMIT_COLD_START':
      return handleColdStart(request.payload);
  }
}

/* ------------------------------ Validación de mensajes entrantes ------------------------------ */

function isNonEmptyString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isTelemetryEvent(value: unknown): value is TelemetryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.raw_user_id, 320) &&
    isNonEmptyString(v.course_id, 100) &&
    isNonEmptyString(v.timestamp, 64) &&
    (TELEMETRY_EVENT_TYPES as readonly string[]).includes(v.event_type as string) &&
    typeof v.payload === 'object' &&
    v.payload !== null &&
    !Array.isArray(v.payload) &&
    Object.keys(v.payload).length > 0
  );
}

function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'TELEMETRY_EVENT':
      return isTelemetryEvent(v.event);
    case 'GET_IDENTITY':
      return isNonEmptyString(v.rawUserId, 320);
    case 'GET_RECOMMENDATIONS':
      return isNonEmptyString(v.courseId, 100) && isNonEmptyString(v.idHash, 64);
    case 'SUBMIT_COLD_START': {
      const p = v.payload as Record<string, unknown> | undefined;
      return (
        typeof p === 'object' &&
        p !== null &&
        isNonEmptyString(p.raw_user_id, 320) &&
        typeof p.quiz_answers === 'object' &&
        p.quiz_answers !== null
      );
    }
    default:
      return false;
  }
}

/* ------------------------------ Registro de listeners (síncrono, nivel superior) ------------------------------ */

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.origin !== CLASSROOM_ORIGIN || !isExtensionRequest(message)) {
    return false;
  }
  handleRequest(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.warn('[HCAI] Error procesando mensaje:', error instanceof Error ? error.name : 'desconocido');
      sendResponse(null);
    });
  return true; // respuesta asíncrona
});

async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: CLASSROOM_URL_PATTERN });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch {
        /* pestaña descartada o sin permiso: se ignora */
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') void injectIntoOpenTabs();
  void flushQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void flushQueue();
});

// Al despertar el worker con eventos pendientes en la cola, se reanuda el envío.
void flushQueue();
