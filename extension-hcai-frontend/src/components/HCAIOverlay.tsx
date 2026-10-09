import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { ClassroomContext } from '../content/domObserver';
import { sendRequest } from '../services/messaging';
import { isIdentityUpdatedNotification, type PublicIdentity } from '../types/messages';
import {
  BLOOM_LEVELS,
  type ColdStartAnswers,
  type RecommendationItem,
  type RecommendationsResult,
} from '../types/recommendation';
import type { TrackFn } from '../types/telemetry';
import { BloomBar } from './BloomBar';
import { ColdStartModal, type ColdStartSubmitOutcome } from './ColdStartModal';
import { RecommendationCards, toSafeHttpUrl } from './RecommendationCards';

export interface HCAIOverlayProps {
  context: ClassroomContext | null;
  track: TrackFn;
}

const EXPANDED_STORAGE_KEY = 'hcai.ui.expanded';
const RETRY_DELAY_MS = 15_000;

/* ------------------------------ Hooks ------------------------------ */

/** Identidad (id_hash + bandera Cold-Start) mantenida por el service worker. */
function useIdentity(rawUserId: string | null): [PublicIdentity | null, (next: PublicIdentity) => void] {
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);

  useEffect(() => {
    setIdentity(null);
    if (!rawUserId) return undefined;

    let cancelled = false;
    sendRequest({ type: 'GET_IDENTITY', rawUserId })
      .then((stored) => {
        if (!cancelled && stored) setIdentity(stored);
      })
      .catch(() => undefined);

    const listener = (message: unknown): void => {
      if (isIdentityUpdatedNotification(message) && message.rawUserId === rawUserId) {
        setIdentity(message.identity);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [rawUserId]);

  return [identity, setIdentity];
}

interface RecommendationsState {
  loading: boolean;
  result: RecommendationsResult | null;
}

function useRecommendations(
  courseId: string | null,
  idHash: string | null,
  enabled: boolean,
): { state: RecommendationsState; reload: () => void } {
  const [state, setState] = useState<RecommendationsState>({ loading: false, result: null });
  const requestRef = useRef(0);

  const reload = useCallback(() => {
    if (!courseId || !idHash || !enabled) return;
    const requestId = ++requestRef.current;
    setState((previous) => ({ ...previous, loading: true }));
    sendRequest({ type: 'GET_RECOMMENDATIONS', courseId, idHash })
      .then((result) => {
        if (requestId === requestRef.current && result) setState({ loading: false, result });
      })
      .catch(() => {
        if (requestId === requestRef.current) setState((previous) => ({ ...previous, loading: false }));
      });
  }, [courseId, idHash, enabled]);

  useEffect(() => {
    setState({ loading: false, result: null });
  }, [courseId, idHash]);

  useEffect(() => {
    reload();
    return () => {
      requestRef.current += 1; // invalida respuestas en vuelo
    };
  }, [reload]);

  return { state, reload };
}

/* ------------------------------ Iconos ------------------------------ */

function BrainIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

/* ------------------------------ Componente ------------------------------ */

export function HCAIOverlay({ context, track }: HCAIOverlayProps): ReactElement | null {
  const courseId = context?.courseId ?? null;
  const userEmail = context?.userEmail ?? null;

  const [expanded, setExpanded] = useState(false);
  const [dismissedColdStart, setDismissedColdStart] = useState(false);
  const [identity, setIdentity] = useIdentity(userEmail);

  const coldStartRequired = identity?.coldStartRequired === true;
  const { state, reload } = useRecommendations(courseId, identity?.idHash ?? null, identity !== null && !coldStartRequired);

  // Preferencia de panel (colapsado/expandido) persistente entre páginas.
  useEffect(() => {
    let cancelled = false;
    chrome.storage.local
      .get(EXPANDED_STORAGE_KEY)
      .then((stored) => {
        if (!cancelled && typeof stored[EXPANDED_STORAGE_KEY] === 'boolean') {
          setExpanded(stored[EXPANDED_STORAGE_KEY] as boolean);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Si el diagnóstico vuelve a ser obligatorio (otro usuario/curso), el modal se reabre.
  useEffect(() => {
    setDismissedColdStart(false);
  }, [identity?.idHash]);

  // Reintento automático mientras el servicio adaptativo no responde y el panel está visible.
  useEffect(() => {
    if (!expanded || !state.result || state.result.source === 'network') return undefined;
    const timer = setTimeout(reload, RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [expanded, state.result, reload]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    chrome.storage.local.set({ [EXPANDED_STORAGE_KEY]: next }).catch(() => undefined);
    track('CLICK', { element_id: 'hcai:panel_toggle', element_tag: 'HCAI_OVERLAY', expanded: next });
  }, [expanded, track]);

  const handleOpenResource = useCallback(
    (item: RecommendationItem) => {
      track('CLICK', {
        element_id: `hcai:recommendation:${item.id}`,
        element_tag: 'RECOMMENDATION',
        recommendation_id: item.id,
        resource_type: item.resource_type,
        bloom_level: item.bloom_level,
        page_url: location.pathname,
      });
      const safeUrl = toSafeHttpUrl(item.url);
      if (safeUrl) window.open(safeUrl, '_blank', 'noopener,noreferrer');
    },
    [track],
  );

  const handleColdStartSubmit = useCallback(
    async (answers: ColdStartAnswers): Promise<ColdStartSubmitOutcome> => {
      if (!userEmail) return { ok: false, error: 'No se pudo identificar tu sesión de Google Classroom.' };
      const result = await sendRequest({
        type: 'SUBMIT_COLD_START',
        payload: { raw_user_id: userEmail, quiz_answers: answers },
      });
      if (!result?.ok) return { ok: false, error: result?.error ?? 'No fue posible guardar tu evaluación.' };
      setIdentity({ idHash: result.id_hash ?? identity?.idHash ?? '', coldStartRequired: false });
      return { ok: true };
    },
    [identity?.idHash, setIdentity, userEmail],
  );

  // Fuera de un curso (p. ej. la home de Classroom) el widget no se muestra.
  if (!courseId) return null;

  const data = state.result?.data ?? null;
  const source = state.result?.source ?? null;
  const badge = data ? String(BLOOM_LEVELS.indexOf(data.bloom.current_level) + 1) : '•';

  return (
    <>
      <div className="pointer-events-auto fixed bottom-5 right-5 flex flex-col items-end gap-3 font-sans text-slate-800">
        {expanded && (
          <section
            aria-label="Asistente adaptativo HCAI"
            className="flex max-h-[min(80vh,560px)] w-[340px] flex-col overflow-hidden rounded-2xl bg-white text-left shadow-2xl ring-1 ring-slate-200"
          >
            <header className="flex items-center justify-between bg-indigo-600 px-4 py-3 text-white">
              <div className="flex items-center gap-2">
                <BrainIcon className="h-5 w-5" />
                <h2 className="text-sm font-bold">Asistente HCAI</h2>
              </div>
              <button
                type="button"
                onClick={toggle}
                aria-label="Minimizar panel"
                className="rounded-md p-1 text-white/80 hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {!userEmail && (
                <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                  No pudimos identificar tu cuenta de Classroom. El asistente permanece en pausa.
                </p>
              )}

              {userEmail && !identity && (
                <p className="text-center text-xs text-slate-500">Conectando con el servicio adaptativo…</p>
              )}

              {coldStartRequired && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-center">
                  <p className="text-sm font-semibold text-indigo-900">Completa tu diagnóstico inicial</p>
                  <p className="mt-1 text-xs text-indigo-700">
                    Son 5 preguntas breves para personalizar tu ruta de aprendizaje.
                  </p>
                  <button
                    type="button"
                    onClick={() => setDismissedColdStart(false)}
                    className="mt-3 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1"
                  >
                    Comenzar diagnóstico
                  </button>
                </div>
              )}

              {identity && !coldStartRequired && !data && (
                <div className="space-y-2" aria-busy="true" aria-label="Cargando recomendaciones">
                  <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
                  <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
                </div>
              )}

              {data && !coldStartRequired && (
                <>
                  {source !== 'network' && (
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <span>
                        {source === 'cache'
                          ? 'Mostrando datos guardados: sin conexión con el servicio.'
                          : 'Servicio adaptativo no disponible por ahora.'}
                      </span>
                      <button
                        type="button"
                        onClick={reload}
                        disabled={state.loading}
                        className="shrink-0 rounded-md bg-amber-200 px-2 py-1 font-semibold hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
                      >
                        {state.loading ? '…' : 'Reintentar'}
                      </button>
                    </div>
                  )}

                  <BloomBar level={data.bloom.current_level} affinityPct={data.bloom.affinity_pct} />

                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {data.route.items.length > 0 ? data.route.name : 'Recursos recomendados'}
                    </h3>
                    <RecommendationCards
                      items={data.route.items}
                      onOpenResource={handleOpenResource}
                      emptyMessage={
                        source === 'fallback'
                          ? 'Cuando el servicio responda verás aquí tus recursos de nivelación.'
                          : 'Aún no hay sugerencias para este curso.'
                      }
                    />
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {!expanded && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Abrir asistente HCAI"
            aria-expanded={false}
            className="relative flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg ring-1 ring-black/10 transition hover:scale-105 hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2"
          >
            <BrainIcon className="h-6 w-6" />
            <span
              className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-400 px-1 text-[11px] font-bold text-slate-900 ring-2 ring-white"
              title="Nivel de Bloom"
            >
              {badge}
            </span>
          </button>
        )}
      </div>

      <ColdStartModal
        open={coldStartRequired && !dismissedColdStart}
        onSubmit={handleColdStartSubmit}
        onDismiss={() => setDismissedColdStart(true)}
      />
    </>
  );
}
