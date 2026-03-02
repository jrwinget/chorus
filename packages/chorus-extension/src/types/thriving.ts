/**
 * LABS (Developer Thriving) framework dimensions from Dr. Cat Hicks' research.
 * Each dimension represents a key factor in developer wellbeing and productivity.
 */
export type LabsDimension = 'learning_culture' | 'agency' | 'belonging' | 'self_efficacy';

/**
 * TRACE (Healthy Measurement) framework principles.
 * Guides how developer metrics should be collected and used.
 */
export type TracePrinciple =
  | 'transparent'
  | 'rewards_growth'
  | 'agency'
  | 'consistent'
  | 'explores_context';

/**
 * How a checklist item was created/triggered.
 */
export type ChecklistItemSource = 'manual' | 'auto_detected';

/**
 * Scope of a checklist item.
 * - pr: per-PR items checked during individual reviews
 * - team: team-wide items tracked across all reviews
 */
export type ChecklistScope = 'pr' | 'team';

/**
 * Rule types for automatic detection of checklist item completion.
 * Each maps to an existing Chorus action that can be detected.
 */
export type AutoDetectRuleType =
  | 'ballot_submitted'
  | 'evidence_added'
  | 'retrospective_recorded'
  | 'nudge_responded'
  | 'scheme_recorded';

/**
 * Auto-detection rule definition.
 * Specifies which Chorus action triggers automatic checking of a checklist item.
 */
export interface AutoDetectRule {
  type: AutoDetectRuleType;
}

/**
 * Template definition for a thriving checklist item.
 * Templates are seeded on initialization and define the available checklist items.
 */
export interface ThrivingTemplate {
  id?: number;
  item_key: string;
  label: string;
  description: string;
  dimension?: LabsDimension;
  trace_principle?: TracePrinciple;
  source: ChecklistItemSource;
  scope: ChecklistScope;
  auto_detect_rule?: string; // JSON string of AutoDetectRule
  sort_order: number;
}

/**
 * Per-PR instance of a checklist item.
 * Created when a PR's checklist is initialized from templates.
 */
export interface ThrivingChecklistItem {
  id?: number;
  pr_reference: string;
  item_key: string;
  checked: boolean;
  checked_at?: string;
  auto_detected: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
}

/**
 * Combined checklist item with template metadata for display.
 */
export interface ThrivingChecklistItemWithTemplate extends ThrivingChecklistItem {
  label: string;
  description: string;
  dimension?: LabsDimension;
  trace_principle?: TracePrinciple;
  source: ChecklistItemSource;
  scope: ChecklistScope;
  auto_detect_rule?: string;
  sort_order: number;
}

/**
 * Per-dimension analytics aggregates.
 */
export interface DimensionAnalytics {
  dimension: LabsDimension;
  completion_rate: number; // 0-1
  trend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
  pr_count: number;
}

/**
 * Full thriving analytics result.
 */
export interface ThrivingAnalytics {
  dimensions: DimensionAnalytics[];
  trace_completion: number; // 0-1
  overall_thriving_score: number; // 0-1
  neglected_dimensions: LabsDimension[];
  strong_dimensions: LabsDimension[];
}

/**
 * Query filters for thriving checklist data.
 */
export interface ThrivingChecklistFilters {
  pr_reference?: string;
  dimension?: LabsDimension;
  scope?: ChecklistScope;
  start_date?: string;
  end_date?: string;
}
