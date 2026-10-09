import type { ReactElement } from 'react';
import {
  BLOOM_LABELS_ES,
  RESOURCE_TYPE_LABELS_ES,
  type RecommendationItem,
  type ResourceType,
} from '../types/recommendation';

export interface RecommendationCardsProps {
  items: RecommendationItem[];
  onOpenResource: (item: RecommendationItem) => void;
  emptyMessage?: string;
}

/** Solo se abren enlaces http(s): evita esquemas como javascript: provenientes del backend. */
export function toSafeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const TYPE_STYLES: Record<ResourceType, string> = {
  DEBUGGING_EXERCISE: 'bg-rose-100 text-rose-700',
  BASE_READING: 'bg-sky-100 text-sky-700',
  VIDEO: 'bg-violet-100 text-violet-700',
  PRACTICE_QUIZ: 'bg-amber-100 text-amber-800',
  PROJECT: 'bg-emerald-100 text-emerald-700',
};

export function RecommendationCards({
  items,
  onOpenResource,
  emptyMessage = 'Aún no hay sugerencias para este curso.',
}: RecommendationCardsProps): ReactElement {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="space-y-2.5">
      {items.map((item) => {
        const hasUrl = toSafeHttpUrl(item.url) !== null;
        return (
          <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TYPE_STYLES[item.resource_type]}`}>
                {RESOURCE_TYPE_LABELS_ES[item.resource_type]}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {BLOOM_LABELS_ES[item.bloom_level]}
              </span>
              {item.estimated_minutes !== null && (
                <span className="text-[11px] text-slate-500">{item.estimated_minutes} min</span>
              )}
              {item.relevance_pct !== null && (
                <span className="ml-auto text-[11px] font-semibold text-emerald-700">
                  {Math.round(item.relevance_pct)}% relevante
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold leading-snug text-slate-900">{item.title}</h3>
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-600">{item.description}</p>
            <button
              type="button"
              disabled={!hasUrl}
              onClick={() => onOpenResource(item)}
              className="mt-2.5 w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {hasUrl ? 'Ir al recurso' : 'Recurso no disponible'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
