/**
 * Validation + targeted-fix types.
 */

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationDomain =
  | 'requirements'
  | 'components'
  | 'compatibility'
  | 'pins'
  | 'wiring'
  | 'power'
  | 'code'
  | 'diagram'
  | 'libraries'
  | 'instructions'
  | 'behavior'
  | 'structure'
  | 'assembly';

/** Artifact kinds addressable by a fix change. */
export type ArtifactKind =
  | 'requirements'
  | 'components'
  | 'hardwarePlan'
  | 'pinAssignments'
  | 'wiring'
  | 'softwarePlan'
  | 'code'
  | 'diagram'
  | 'libraries'
  | 'instructions'
  | 'assembly';

export interface IssueTarget {
  artifact: ArtifactKind;
  componentInstanceId?: string;
  componentId?: string;
  selectionId?: string;
  pin?: string;
  assignmentId?: string;
  connectionId?: string;
  filePath?: string;
  library?: string;
  sectionId?: string;
}

/**
 * Stable machine readable issue codes. The deterministic fixer dispatches on
 * these, which is what makes fixes *targeted* instead of a full regeneration.
 */
export type ValidationIssueCode =
  | 'schema_violation'
  | 'empty_artifact'
  | 'missing_controller'
  | 'missing_component'
  | 'unknown_component'
  | 'invented_component'
  | 'incompatible_components'
  | 'duplicate_instance_id'
  | 'gpio_conflict'
  | 'reserved_pin_used'
  | 'input_only_pin_driven'
  | 'analog_only_pin_driven'
  | 'uart_pin_used_as_gpio'
  | 'duplicate_pin_assignment'
  | 'capability_mismatch'
  | 'motor_on_mcu_pin'
  | 'missing_ground'
  | 'missing_power'
  | 'invalid_voltage'
  | 'output_to_output'
  | 'unknown_pin'
  | 'dangling_reference'
  | 'duplicate_connection'
  | 'floating_required_pin'
  | 'diagram_out_of_sync'
  | 'diagram_missing_component'
  | 'diagram_missing_connection'
  | 'code_pin_mismatch'
  | 'code_missing_include'
  | 'code_stray_include'
  | 'code_i2c_address_invalid'
  | 'code_missing_bus_init'
  | 'code_missing_setup_loop'
  | 'code_unbalanced_braces'
  | 'firmware_compile_error'
  | 'library_missing'
  | 'library_unused'
  | 'instructions_missing_section'
  | 'instructions_out_of_sync'
  | 'power_budget_exceeded'
  | 'unverified_component'
  | 'requirement_uncovered'
  | 'quantity_shortfall'
  | 'behavioral_assertion_failed'
  | 'sim_behavior_mismatch'
  | 'assembly_unknown_part'
  | 'assembly_bad_placement'
  | 'assembly_overlap'
  | 'sim_execution_unavailable'
  | 'model_review';

export interface ValidationIssue {
  id: string;
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  domain: ValidationDomain;
  message: string;
  details?: string;
  target?: IssueTarget;
  fixHint?: string;
  /** True when a deterministic (non-LLM) fix exists for this code. */
  autoFixable: boolean;
  /** `rules` = deterministic engine, `model` = Bedrock critical review. */
  origin: 'rules' | 'model';
}

export interface ValidationCheck {
  id: string;
  name: string;
  domain: ValidationDomain;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  issueIds: string[];
}

export interface ValidationSummary {
  errors: number;
  warnings: number;
  info: number;
  checksRun: number;
  checksPassed: number;
}

export interface ModelReview {
  verdict: 'approve' | 'reject' | 'needs_changes';
  confidence: number;
  notes: string[];
  model: string;
  reviewedAt: string;
}

export interface ValidationResult {
  /** Overall gate: no `error` severity issues remain. */
  passed: boolean;
  iteration: number;
  checkedAt: string;
  durationMs: number;
  issues: ValidationIssue[];
  checks: ValidationCheck[];
  summary: ValidationSummary;
  modelReview?: ModelReview;
  /** Set when validation itself could not run (Bedrock failure, parse failure…). */
  engineError?: string;
}
