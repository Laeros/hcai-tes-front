/** Taxonomía de Bloom, rutas adaptativas y evaluación diagnóstica (Cold-Start). */

export const BLOOM_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE'] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const BLOOM_LABELS_ES: Record<BloomLevel, string> = {
  REMEMBER: 'Recordar',
  UNDERSTAND: 'Comprender',
  APPLY: 'Aplicar',
  ANALYZE: 'Analizar',
  EVALUATE: 'Evaluar',
  CREATE: 'Crear',
};

export interface BloomState {
  current_level: BloomLevel;
  /** Nivel de afinidad 0-100. */
  affinity_pct: number;
}

export const RESOURCE_TYPES = ['DEBUGGING_EXERCISE', 'BASE_READING', 'VIDEO', 'PRACTICE_QUIZ', 'PROJECT'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS_ES: Record<ResourceType, string> = {
  DEBUGGING_EXERCISE: 'Ejercicio de debugging',
  BASE_READING: 'Lectura base',
  VIDEO: 'Video',
  PRACTICE_QUIZ: 'Práctica',
  PROJECT: 'Proyecto',
};

export interface RecommendationItem {
  id: string;
  title: string;
  description: string;
  resource_type: ResourceType;
  bloom_level: BloomLevel;
  url: string | null;
  estimated_minutes: number | null;
  relevance_pct: number | null;
}

export interface RecommendedRoute {
  route_id: string;
  name: string;
  target_level: BloomLevel;
  items: RecommendationItem[];
}

/** Respuesta de GET /api/v1/recommendations/{id_hash}?course_id=... */
export interface AdaptiveRecommendations {
  id_hash: string;
  course_id: string;
  bloom: BloomState;
  route: RecommendedRoute;
  generated_at: string;
}

export type RecommendationSource = 'network' | 'cache' | 'fallback';

export interface RecommendationsResult {
  data: AdaptiveRecommendations;
  source: RecommendationSource;
}

/* ------------------------------ Cold-Start ------------------------------ */

export type ColdStartQuestionId =
  | 'experiencia_previa'
  | 'confianza_tema'
  | 'formato_preferido'
  | 'horas_semana'
  | 'objetivo';

export interface ColdStartOption {
  value: string;
  label: string;
}

export interface ColdStartQuestion {
  id: ColdStartQuestionId;
  prompt: string;
  options: ReadonlyArray<ColdStartOption>;
}

/** Exactamente 5 respuestas: el backend rechaza cualquier otra cantidad. */
export type ColdStartAnswers = Record<ColdStartQuestionId, string>;

export interface ColdStartPayload {
  raw_user_id: string;
  quiz_answers: ColdStartAnswers;
}

export interface ColdStartResult {
  ok: boolean;
  /** true si el backend no respondió a tiempo y la evaluación quedó en cola para reintento. */
  queued: boolean;
  id_hash: string | null;
  error: string | null;
}
