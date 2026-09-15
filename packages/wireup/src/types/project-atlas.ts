/**
 * Project Atlas — the domain-neutral state layer for the next Wireup.
 *
 * Atlas keeps the source, the extracted graph, measurable facts, and any
 * proposed transformation together. It is deliberately model-agnostic: an
 * LLM may improve extraction later, but a project never becomes an opaque
 * transcript and the system never pretends an inference is a fact.
 */

export type AtlasSourceKind = 'brief' | 'profile' | 'document' | 'code' | 'data' | 'note';
export type AtlasSourceOrigin = 'user' | 'project' | 'agent';
export type AtlasNodeKind =
  | 'source'
  | 'text_unit'
  | 'concept'
  | 'entity'
  | 'requirement'
  | 'metric'
  | 'assumption'
  | 'risk'
  | 'artifact'
  | 'target';
export type AtlasNodeStatus = 'observed' | 'inferred' | 'unresolved' | 'verified';
export type AtlasEdgeKind =
  | 'contains'
  | 'mentions'
  | 'requires'
  | 'supports'
  | 'depends_on'
  | 'conflicts_with'
  | 'derived_from'
  | 'maps_to'
  | 'measures';
export type AtlasMetricStatus = 'measured' | 'estimated' | 'missing' | 'derived';
export type AtlasTransformStatus = 'ready' | 'needs_clarification' | 'unsupported' | 'applied';

export interface AtlasSource {
  id: string;
  kind: AtlasSourceKind;
  origin: AtlasSourceOrigin;
  title: string;
  content: string;
  contentHash: string;
  chars: number;
  lines: number;
  capturedAt: string;
}

export interface AtlasNode {
  id: string;
  kind: AtlasNodeKind;
  label: string;
  description: string;
  value?: string | number;
  unit?: string;
  quantity?: number;
  confidence: number;
  status: AtlasNodeStatus;
  sourceIds: string[];
  tags: string[];
}

export interface AtlasEdge {
  id: string;
  from: string;
  to: string;
  kind: AtlasEdgeKind;
  weight: number;
  confidence: number;
  sourceIds: string[];
  evidence?: string;
}

export interface AtlasMetric {
  id: string;
  label: string;
  value: number;
  unit: string;
  status: AtlasMetricStatus;
  sourceIds: string[];
  target?: number;
  formula?: string;
}

export interface AtlasQuantification {
  sourceChars: number;
  sourceLines: number;
  sourceTokensApprox: number;
  sourceCount: number;
  nodeCount: number;
  edgeCount: number;
  textUnitCount: number;
  claimCount: number;
  metricCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  riskCount: number;
  coverage: number;
  confidence: number;
}

export interface AtlasTargetSpec {
  language: string;
  framework?: string;
  packageName?: string;
}

export interface AtlasMapping {
  sourceNodeId: string;
  sourceLabel: string;
  targetPath: string;
  targetType: string;
  confidence: number;
  reason: string;
}

export interface AtlasGeneratedFile {
  path: string;
  language: string;
  purpose: string;
  content: string;
  sourceNodeIds: string[];
}

export interface AtlasTransformPlan {
  id: string;
  status: AtlasTransformStatus;
  baseVersion: number;
  target: AtlasTargetSpec;
  title: string;
  summary: string;
  rationale: string;
  steps: { id: string; label: string; detail: string; status: 'ready' | 'needs_review' | 'complete' }[];
  mappings: AtlasMapping[];
  files: AtlasGeneratedFile[];
  gaps: string[];
  metrics: { inputFacts: number; mappedFacts: number; generatedFiles: number; generatedLines: number; confidence: number };
  requiresApproval: boolean;
  createdAt: string;
  appliedAt?: string;
}

export interface ProjectAtlasState {
  version: number;
  sources: AtlasSource[];
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  metrics: AtlasMetric[];
  quantification: AtlasQuantification;
  transform: AtlasTransformPlan | null;
  updatedAt: string;
}
