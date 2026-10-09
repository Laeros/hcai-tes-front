import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { ColdStartAnswers, ColdStartQuestion, ColdStartQuestionId } from '../types/recommendation';

export const COLD_START_QUESTIONS: ReadonlyArray<ColdStartQuestion> = [
  {
    id: 'experiencia_previa',
    prompt: '¿Qué experiencia previa tienes con los temas de este curso?',
    options: [
      { value: 'ninguna', label: 'Ninguna: es la primera vez' },
      { value: 'basica', label: 'Básica: conozco algunos conceptos' },
      { value: 'intermedia', label: 'Intermedia: los he aplicado antes' },
      { value: 'avanzada', label: 'Avanzada: los domino bien' },
    ],
  },
  {
    id: 'confianza_tema',
    prompt: '¿Qué tan seguro te sientes resolviendo ejercicios sin ayuda?',
    options: [
      { value: 'muy_baja', label: 'Nada seguro' },
      { value: 'baja', label: 'Poco seguro' },
      { value: 'media', label: 'Moderadamente seguro' },
      { value: 'alta', label: 'Muy seguro' },
    ],
  },
  {
    id: 'formato_preferido',
    prompt: '¿Con qué formato aprendes mejor?',
    options: [
      { value: 'lectura', label: 'Lecturas y documentación' },
      { value: 'video', label: 'Videos explicativos' },
      { value: 'ejercicios', label: 'Ejercicios prácticos' },
      { value: 'proyectos', label: 'Proyectos aplicados' },
    ],
  },
  {
    id: 'horas_semana',
    prompt: '¿Cuántas horas por semana puedes dedicar a este curso?',
    options: [
      { value: '0-2', label: 'Hasta 2 horas' },
      { value: '3-5', label: 'De 3 a 5 horas' },
      { value: '6-10', label: 'De 6 a 10 horas' },
      { value: '10+', label: 'Más de 10 horas' },
    ],
  },
  {
    id: 'objetivo',
    prompt: '¿Cuál es tu objetivo principal en este curso?',
    options: [
      { value: 'aprobar', label: 'Aprobar el curso' },
      { value: 'reforzar_bases', label: 'Reforzar mis bases' },
      { value: 'dominar_tema', label: 'Dominar el tema a fondo' },
      { value: 'aplicar_proyectos', label: 'Aplicarlo en proyectos reales' },
    ],
  },
];

export interface ColdStartSubmitOutcome {
  ok: boolean;
  error?: string;
}

export interface ColdStartModalProps {
  open: boolean;
  onSubmit: (answers: ColdStartAnswers) => Promise<ColdStartSubmitOutcome>;
  /** "Ahora no": cierra el modal solo en esta página; el diagnóstico seguirá disponible en el panel. */
  onDismiss: () => void;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function ColdStartModal({ open, onSubmit, onDismiss }: ColdStartModalProps): ReactElement | null {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<Record<ColdStartQuestionId, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const total = COLD_START_QUESTIONS.length;
  const question = COLD_START_QUESTIONS[step];
  const selected = answers[question.id];
  const isLast = step === total - 1;

  // Foco inicial en cada paso: la opción elegida o la primera.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const target =
      dialog?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      dialog?.querySelector<HTMLInputElement>('input[type="radio"]');
    target?.focus();
  }, [open, step]);

  const handleSelect = useCallback(
    (value: string) => {
      setAnswers((previous) => ({ ...previous, [question.id]: value }));
      setError(null);
    },
    [question.id],
  );

  const handleFinish = useCallback(async () => {
    const complete = COLD_START_QUESTIONS.every((item) => Boolean(answers[item.id]));
    if (!complete) {
      setError('Responde las 5 preguntas para continuar.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await onSubmit(answers as ColdStartAnswers);
      if (!outcome.ok) setError(outcome.error ?? 'No fue posible guardar tu evaluación.');
    } catch {
      setError('No fue posible guardar tu evaluación. Inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }, [answers, onSubmit]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Evita que los atajos de teclado de Classroom reaccionen mientras el modal está abierto.
      event.stopPropagation();
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = dialogRef.current?.getRootNode() instanceof ShadowRoot
        ? (dialogRef.current.getRootNode() as ShadowRoot).activeElement
        : document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onDismiss, submitting],
  );

  if (!open) return null;

  return (
    <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hcai-coldstart-title"
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => event.stopPropagation()}
        onKeyPress={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-6 text-left font-sans text-slate-800 shadow-2xl"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Diagnóstico inicial</p>
        <h2 id="hcai-coldstart-title" className="mt-1 text-lg font-bold text-slate-900">
          Cuéntanos sobre ti para personalizar tu ruta
        </h2>

        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>
              Pregunta {step + 1} de {total}
            </span>
            <span>{Math.round(((step + 1) / total) * 100)}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-label="Progreso del diagnóstico"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={step + 1}
          >
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${((step + 1) / total) * 100}%` }}
            />
          </div>
        </div>

        <fieldset className="mt-5" disabled={submitting}>
          <legend className="text-sm font-semibold text-slate-900">{question.prompt}</legend>
          <div className="mt-3 space-y-2">
            {question.options.map((option) => {
              const checked = selected === option.value;
              return (
                <label
                  key={option.value}
                  className={[
                    'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition',
                    checked ? 'border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-slate-200 hover:bg-slate-50',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name={`hcai-${question.id}`}
                    value={option.value}
                    checked={checked}
                    onChange={() => handleSelect(option.value)}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={submitting}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
          >
            Ahora no
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={step === 0 || submitting}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-40"
            >
              Atrás
            </button>
            {isLast ? (
              <button
                type="button"
                onClick={() => void handleFinish()}
                disabled={!selected || submitting}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 disabled:bg-slate-300"
              >
                {submitting ? 'Enviando…' : 'Finalizar'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep((current) => Math.min(total - 1, current + 1))}
                disabled={!selected}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 disabled:bg-slate-300"
              >
                Siguiente
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
