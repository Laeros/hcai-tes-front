/** Contrato de telemetría con el Módulo 1 (FastAPI: POST /api/v1/telemetry/ingest). */

export type TelemetryEventType = 'CLICK' | 'DWELL_TIME' | 'MATERIAL_VIEW' | 'SUBMISSION_RETRY';

export interface ClickPayload {
  element_id?: string;
  element_tag?: string;
  x?: number;
  y?: number;
  page_url?: string;
  [extra: string]: unknown;
}

export interface DwellTimePayload {
  dwell_time_ms: number;
  material_id?: string;
  material_type?: string;
  scroll_depth_pct?: number;
  [extra: string]: unknown;
}

export interface MaterialViewPayload {
  material_id: string;
  material_type?: string;
  view_duration_ms?: number;
  [extra: string]: unknown;
}

export interface SubmissionRetryPayload {
  assignment_id: string;
  attempt_number: number;
  time_since_last_attempt_ms?: number;
  [extra: string]: unknown;
}

export interface TelemetryPayloadMap {
  CLICK: ClickPayload;
  DWELL_TIME: DwellTimePayload;
  MATERIAL_VIEW: MaterialViewPayload;
  SUBMISSION_RETRY: SubmissionRetryPayload;
}

/** Cuerpo de la petición de ingesta para un tipo de evento concreto. */
export interface TelemetryRequest<T extends TelemetryEventType = TelemetryEventType> {
  raw_user_id: string;
  event_type: T;
  course_id: string;
  payload: TelemetryPayloadMap[T];
  /** ISO-8601 (UTC). */
  timestamp: string;
}

/** Unión discriminada por `event_type`: lo que recibe `sendTelemetry`. */
export type TelemetryPayload = { [K in TelemetryEventType]: TelemetryRequest<K> }[TelemetryEventType];

/** Respuesta de /ingest y /cold-start. */
export interface TelemetryResponse {
  status: string;
  id_hash: string;
  cold_start_required: boolean;
  latency_ms: number;
}

/** Función que los componentes usan para registrar eventos sin conocer al tracker. */
export type TrackFn = <T extends TelemetryEventType>(type: T, payload: TelemetryPayloadMap[T]) => void;

export const TELEMETRY_EVENT_TYPES: readonly TelemetryEventType[] = [
  'CLICK',
  'DWELL_TIME',
  'MATERIAL_VIEW',
  'SUBMISSION_RETRY',
];
