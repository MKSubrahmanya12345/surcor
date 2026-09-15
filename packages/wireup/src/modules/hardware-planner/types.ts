/** Shared types for the hardware planner. */

import type { ComponentRole } from '@/types/component';
import type { HardwarePlan, ProjectRequirements } from '@/types/project';
import type { ComponentSelection } from '@/types/component';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';

/** A component choice before instances are materialised. */
export interface DraftSelection {
  componentId: string;
  quantity: number;
  role: ComponentRole;
  reason: string;
  required: boolean;
  source: 'catalog' | 'model' | 'planner';
  matchedFrom?: string;
  notes?: string;
  /** Optional per-instance labels supplied by the model ("Left motor", …). */
  labels?: string[];
}

export interface HardwarePlannerInput {
  requirements: ProjectRequirements;
  analysis: PromptAnalysis;
  /** Raw `components` array from the generation model call. */
  modelComponents: unknown;
  catalog: import('@/types/component').ComponentDefinition[];
}

export interface HardwarePlanResult {
  selections: ComponentSelection[];
  plan: HardwarePlan;
  /** Component names the model asked for that could not be mapped to the catalog. */
  unmatched: { query: string; reason: string }[];
  /**
   * Parts synthesised from an electrical contract because the catalog had no
   * entry. They carry `metadata.provisional` and must be surfaced to the user
   * as unverified rather than presented as catalog parts.
   */
  provisional: import('@/types/component').ComponentDefinition[];
  notes: string[];
}
