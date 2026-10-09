import type { ReactElement } from 'react';
import { BLOOM_LABELS_ES, BLOOM_LEVELS, type BloomLevel } from '../types/recommendation';

export interface BloomBarProps {
  level: BloomLevel;
  /** Afinidad 0-100. */
  affinityPct: number;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

export function BloomBar({ level, affinityPct }: BloomBarProps): ReactElement {
  const currentIndex = BLOOM_LEVELS.indexOf(level);
  const affinity = clampPct(affinityPct);

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Taxonomía de Bloom</span>
          <span className="text-sm font-bold text-indigo-700">
            {currentIndex + 1}/{BLOOM_LEVELS.length} · {BLOOM_LABELS_ES[level]}
          </span>
        </div>
        <ol
          className="flex gap-1"
          aria-label={`Nivel actual de Bloom: ${BLOOM_LABELS_ES[level]}, nivel ${currentIndex + 1} de ${BLOOM_LEVELS.length}`}
        >
          {BLOOM_LEVELS.map((item, index) => {
            const reached = index <= currentIndex;
            const isCurrent = index === currentIndex;
            return (
              <li key={item} className="flex-1" title={BLOOM_LABELS_ES[item]}>
                <div
                  className={[
                    'h-2.5 rounded-full transition-colors',
                    reached ? 'bg-indigo-500' : 'bg-slate-200',
                    isCurrent ? 'ring-2 ring-indigo-300 ring-offset-1' : '',
                  ].join(' ')}
                />
                <span
                  className={[
                    'mt-1 block text-center text-[10px] leading-none',
                    isCurrent ? 'font-bold text-indigo-700' : 'text-slate-400',
                  ].join(' ')}
                >
                  {index + 1}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-600">Nivel de afinidad</span>
          <span className="font-bold text-slate-800">{affinity}%</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-label="Nivel de afinidad"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={affinity}
        >
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${affinity}%` }} />
        </div>
      </div>
    </div>
  );
}
