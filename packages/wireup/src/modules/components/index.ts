/**
 * Component database module — public surface.
 *
 * The catalog is the ground truth for hardware: the LLM may only choose from
 * what is seeded here (or stored in MongoDB), never invent parts.
 */

export {
  SEED_COMPONENTS,
  getSeedComponent,
  listSeedIds,
  checkCatalogIntegrity,
  type CatalogIntegrityReport,
} from './catalog';

export {
  ComponentDefinitionSchema,
  ComponentPinSchema,
  LibraryRequirementSchema,
  type ComponentDefinitionInput,
} from './schema';

export {
  formatCatalogContext,
  formatCatalogIndex,
  formatComponentBrief,
  formatMcuContext,
} from './context';

export {
  findComponentById,
  getCatalog,
  invalidateCatalogCache,
  matchComponent,
  matchComponentStrict,
  profilesForSelections,
  retrieveRelevantComponents,
  type CatalogState,
  type MatchResult,
  type RetrievalInput,
  type RetrievalResult,
} from './service';
