/**
 * @forge/wireup public API — the ported Wireup agent engine as a Forge
 * workspace library.
 *
 * Forge never imports the engine's internals: it talks to this surface, sets
 * up a persistence sink (SQLite), and drives projects through the orchestrator.
 */

/* Persistence seam (Forge wires a SQLite sink; tests can leave it unset). */
export {
  registerPersistenceSink,
  getPersistenceSink,
  hasPersistenceSink,
  hydrateIfNeeded,
  resetPersistenceSink,
  type PersistenceSink,
  type ProjectRow,
} from '@/lib/store/persistence';

/* In-process store handle (tests / diagnostics). */
export { memoryDb, resetMemoryDb, clone } from '@/lib/store/memory';

/* Project repository (memory-backed, flushed through the sink). */
export {
  createProjectRecord,
  getProjectState,
  listProjectStates,
  saveProjectState,
  appendEvents,
  recordLlmCall,
  markProjectFailed,
  findStalledProjects,
  getProjectEvents,
  deleteProject,
  serializeProject,
  type CreateProjectInput,
  type ProjectPatch,
} from '@/lib/mongodb/projects';

/* Component catalog repository. */
export {
  countComponents,
  listComponents,
  getComponentById,
  upsertComponents,
  tryListComponents,
  deleteComponent,
  type UpsertResult,
} from '@/lib/mongodb/components';

/* Orchestrator — the agent run (create → pipeline → validate/fix → finish). */
export {
  runGeneration,
  startGeneration,
  isRunning,
  runPipeline,
  buildGenerationContext,
  buildRefreshers,
  controllerInfo,
  deriveLinks,
  EventFlusher,
  PersistenceError,
  persistFailure,
  persistLlmCall,
  persistState,
  appendRevision,
  createRevision,
  snapshotOf,
  summariseChanges,
  OrchestratorError,
  type RunOptions,
} from '@/modules/orchestrator';

/* Component catalog service (auto-seeds the bundled registry on first use). */
export {
  getCatalog,
  retrieveRelevantComponents,
  matchComponent,
  matchComponentStrict,
  findComponentById,
  profilesForSelections,
  invalidateCatalogCache,
  type CatalogState,
  type RetrievalInput,
  type RetrievalResult,
} from '@/modules/components/service';

/* Bundled seed catalog. */
export { SEED_COMPONENTS } from '@/modules/components/catalog';

/* Shared types the host needs to interpret project state. */
export type {
  ProjectState,
  ProjectArtifacts,
  ProjectStatus,
  GenerationStage,
  CodeArtifact,
  InstructionsArtifact,
  LibrariesArtifact,
  SoftwarePlan,
  HardwarePlan,
  LlmCallRecord,
} from '@/types/project';
export type { Diagram } from '@/types/diagram';
export type { ComponentDefinition } from '@/types/component';
export type { AgentEvent, AgentEventType } from '@/types/generation';
export type { ValidationResult } from '@/types/validation';
export type { WiringPlan } from '@/types/wiring';
export type {
  EverflowState,
  EverflowEvaluation,
  EverflowGraph,
  HumanTask,
  ProjectDoubt,
  ResearchFinding,
  ExpandedBrief,
} from '@/types/everflow';
export type { ProjectAtlasState } from '@/types/project-atlas';