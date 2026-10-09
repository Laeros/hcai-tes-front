/**
 * Cliente HTTP hacia el API Gateway FastAPI.
 *
 * Se ejecuta únicamente en el service worker: allí `host_permissions` evita las restricciones CORS
 * que sí sufriría un fetch lanzado desde el content script (que usa el origen de la página).
 *
 * Política de tiempo límite:
 *  - Llamadas que alimentan la UI (recomendaciones, cold-start): 200 ms.
 *  - Ingesta de telemetría (cola en segundo plano, nunca bloquea la UI): 2000 ms. Con 200 ms un
 *    timeout produciría reintentos de eventos que el backend quizá ya guardó (la ingesta no es
 *    idempotente) y duplicaría registros.
 * Ninguna función lanza excepciones: devuelven un resultado explícito o un fallback.
 */
import {
  BLOOM_LEVELS,
  RESOURCE_TYPES,
  type AdaptiveRecommendations,
  type ColdStartPayload,
  type RecommendationItem,
  type RecommendationsResult,
} from '../types/recommendation';
import type { TelemetryPayload, TelemetryResponse } from '../types/telemetry';

export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
export const UI_TIMEOUT_MS = 200;
export const TELEMETRY_TIMEOUT_MS = 2000;

const ID_HASH_RE = /^[0-9a-f]{64}$/;

export type ApiErrorKind = 'timeout' | 'network' | 'http' | 'parse';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: ApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable =
      kind === 'timeout' ||
      kind === 'network' ||
      (kind === 'http' && status !== null && (status === 408 || status === 425 || status === 429 || status >= 500));
  }
}

export type ApiResult<T> =
  | { ok: true; data: T; latencyMs: number }
  | { ok: false; error: ApiError; latencyMs: number };

export interface RequestOptions {
  timeoutMs?: number;
}

/* ------------------------------ Infraestructura ------------------------------ */

async function requestJson(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) throw new ApiError('http', `HTTP ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new ApiError('parse', 'La respuesta del servidor no es JSON válido.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError('timeout', `Tiempo límite de ${timeoutMs} ms excedido.`);
    throw new ApiError('network', 'No fue posible contactar al servidor.');
  } finally {
    clearTimeout(timer);
  }
}

async function execute<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const started = performance.now();
  try {
    const data = await run();
    return { ok: true, data, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError('network', 'Error inesperado de red.');
    return { ok: false, error: apiError, latencyMs: Math.round(performance.now() - started) };
  }
}

/* ------------------------------ Validación de respuestas ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTelemetryResponse(value: unknown): value is TelemetryResponse {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    typeof value.id_hash === 'string' &&
    ID_HASH_RE.test(value.id_hash) &&
    typeof value.cold_start_required === 'boolean' &&
    typeof value.latency_ms === 'number'
  );
}

function isRecommendationItem(value: unknown): value is RecommendationItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    (RESOURCE_TYPES as readonly string[]).includes(value.resource_type as string) &&
    (BLOOM_LEVELS as readonly string[]).includes(value.bloom_level as string) &&
    (value.url === null || typeof value.url === 'string') &&
    (value.estimated_minutes === null || typeof value.estimated_minutes === 'number') &&
    (value.relevance_pct === null || typeof value.relevance_pct === 'number')
  );
}

export function isAdaptiveRecommendations(value: unknown): value is AdaptiveRecommendations {
  if (!isRecord(value) || !isRecord(value.bloom) || !isRecord(value.route)) return false;
  return (
    typeof value.id_hash === 'string' &&
    typeof value.course_id === 'string' &&
    typeof value.generated_at === 'string' &&
    (BLOOM_LEVELS as readonly string[]).includes(value.bloom.current_level as string) &&
    typeof value.bloom.affinity_pct === 'number' &&
    typeof value.route.route_id === 'string' &&
    typeof value.route.name === 'string' &&
    (BLOOM_LEVELS as readonly string[]).includes(value.route.target_level as string) &&
    Array.isArray(value.route.items) &&
    value.route.items.every(isRecommendationItem)
  );
}

/* ------------------------------ Fallback ------------------------------ */

export function buildFallbackRecommendations(courseId: string, userId: string): AdaptiveRecommendations {
  return {
    id_hash: userId,
    course_id: courseId,
    bloom: { current_level: 'REMEMBER', affinity_pct: 0 },
    route: { route_id: 'fallback', name: 'Ruta adaptativa no disponible', target_level: 'REMEMBER', items: [] },
    generated_at: new Date().toISOString(),
  };
}

/* ------------------------------ API pública ------------------------------ */

export function sendTelemetry(data: TelemetryPayload, options: RequestOptions = {}): Promise<ApiResult<TelemetryResponse>> {
  return execute(async () => {
    const body = await requestJson(
      '/api/v1/telemetry/ingest',
      { method: 'POST', body: JSON.stringify(data) },
      options.timeoutMs ?? TELEMETRY_TIMEOUT_MS,
    );
    if (!isTelemetryResponse(body)) throw new ApiError('parse', 'Respuesta de ingesta con formato inesperado.');
    return body;
  });
}

export function submitColdStartAnswers(
  data: ColdStartPayload,
  options: RequestOptions = {},
): Promise<ApiResult<TelemetryResponse>> {
  return execute(async () => {
    const body = await requestJson(
      '/api/v1/telemetry/cold-start',
      { method: 'POST', body: JSON.stringify(data) },
      options.timeoutMs ?? UI_TIMEOUT_MS,
    );
    if (!isTelemetryResponse(body)) throw new ApiError('parse', 'Respuesta de cold-start con formato inesperado.');
    return body;
  });
}

/**
 * Nunca falla: ante timeout, error de red, 404 (módulo de recomendaciones aún no desplegado) o
 * respuesta inválida devuelve una ruta vacía marcada como `fallback`.
 * `userId` es el `id_hash` devuelto por el backend (nunca el correo en bruto).
 */
export async function getAdaptiveRecommendations(
  courseId: string,
  userId: string,
  options: RequestOptions = {},
): Promise<RecommendationsResult> {
  const fallback: RecommendationsResult = { data: buildFallbackRecommendations(courseId, userId), source: 'fallback' };
  if (!courseId || !ID_HASH_RE.test(userId)) return fallback;

  const result = await execute(async () => {
    const body = await requestJson(
      `/api/v1/recommendations/${encodeURIComponent(userId)}?course_id=${encodeURIComponent(courseId)}`,
      { method: 'GET' },
      options.timeoutMs ?? UI_TIMEOUT_MS,
    );
    if (!isAdaptiveRecommendations(body)) throw new ApiError('parse', 'Recomendaciones con formato inesperado.');
    return body;
  });
  return result.ok ? { data: result.data, source: 'network' } : fallback;
}
