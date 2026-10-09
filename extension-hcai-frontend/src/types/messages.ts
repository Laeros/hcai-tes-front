/** Mensajería content script <-> service worker. */
import type { ColdStartPayload, ColdStartResult, RecommendationsResult } from './recommendation';
import type { TelemetryPayload } from './telemetry';

export type ExtensionRequest =
  | { type: 'TELEMETRY_EVENT'; event: TelemetryPayload }
  | { type: 'GET_IDENTITY'; rawUserId: string }
  | { type: 'GET_RECOMMENDATIONS'; courseId: string; idHash: string }
  | { type: 'SUBMIT_COLD_START'; payload: ColdStartPayload };

/** Estado visible por la UI (el correo en bruto nunca se persiste fuera de storage.session). */
export interface PublicIdentity {
  idHash: string;
  coldStartRequired: boolean;
}

export interface ResponseMap {
  TELEMETRY_EVENT: { accepted: boolean };
  GET_IDENTITY: PublicIdentity | null;
  GET_RECOMMENDATIONS: RecommendationsResult;
  SUBMIT_COLD_START: ColdStartResult;
}

export type ResponseFor<T extends ExtensionRequest['type']> = ResponseMap[T];

/** Notificación service worker -> pestañas de Classroom. */
export interface IdentityUpdatedNotification {
  type: 'IDENTITY_UPDATED';
  rawUserId: string;
  identity: PublicIdentity;
}

export function isIdentityUpdatedNotification(value: unknown): value is IdentityUpdatedNotification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<IdentityUpdatedNotification>;
  return (
    v.type === 'IDENTITY_UPDATED' &&
    typeof v.rawUserId === 'string' &&
    typeof v.identity?.idHash === 'string' &&
    typeof v.identity?.coldStartRequired === 'boolean'
  );
}
