/**
 * TypeScript interfaces and types for the condensed UI system.
 * Defines consolidated navigation, adaptive drawer, and space-optimized components.
 */

import type { HumanTask, EverflowEvaluation } from './everflow';
import type { ProjectState, ProjectStatus } from './project';
import type { AgentEvent } from './generation';

/* ------------------------------------------------------------------------- */
/* Consolidated Navigation State                                             */
/* ------------------------------------------------------------------------- */

/** The 5 consolidated tabs that replace the original 9-tab system */
export type ConsolidatedTab = 'overview' | 'map' | 'build' | 'code' | 'terminal';

/** Sub-routes within the Build tab (Parts + Wiring + Diagram) */
export type BuildSubRoute = 'parts' | 'wiring' | 'diagram';

/** Sub-routes within the Code tab (Simulation + Firmware) */
export type CodeSubRoute = 'simulation' | 'firmware';

/** Combined sub-route type for all consolidated tabs */
export type ConsolidatedSubRoute = BuildSubRoute | CodeSubRoute;

/** Current navigation state in the condensed UI */
export interface ConsolidatedNavState {
  activeTab: ConsolidatedTab;
  activeSubRoute?: ConsolidatedSubRoute;
  terminalActive: boolean;
  drawerMode: 'tasks' | 'input' | null;
}

/** Navigation history for session persistence */
export interface NavigationHistory {
  previousTab: ConsolidatedTab;
  previousSubRoute?: ConsolidatedSubRoute;
  sessionPersistence: Map<string, any>;
}

/** Tab configuration with consolidation mapping */
export interface ConsolidatedTabConfig {
  href: string;
  label: string;
  subRoutes: string[]; // Internal routing for consolidated content
  badge?: { tone: 'wait' | 'done'; text: string };
  originalTabs: string[]; // Which original tabs this consolidates
}

/* ------------------------------------------------------------------------- */
/* Topbar Component Types                                                    */
/* ------------------------------------------------------------------------- */

/** Primary actions always visible in the consolidated topbar (4 buttons) */
export interface PrimaryAction {
  key: string;
  label: string;
  icon?: string;
  variant: 'primary' | 'attention' | 'ghost';
  onClick: () => void;
  badge?: number; // For Agent Tasks pending count
}

/** Secondary actions in the overflow menu */
export interface OverflowAction {
  key: string;
  label: string;
  href?: string;
  onClick?: () => void;
  separator?: boolean; // Add separator before this item
}

/** Props for the ConsolidatedTopbar component */
export interface ConsolidatedTopbarProps {
  project: ProjectState | null;
  openAsks: number;
  onDrawerToggle: (mode: 'tasks' | 'input') => void;
  onTerminalToggle: () => void;
}

/* ------------------------------------------------------------------------- */
/* Adaptive Drawer System Types                                             */
/* ------------------------------------------------------------------------- */

/** Mode of the adaptive drawer - combines both original drawers */
export type DrawerMode = 'tasks' | 'input';

/** State of the adaptive drawer system */
export interface AdaptiveDrawerState {
  mode: DrawerMode | null;
  isOpen: boolean;
  autoSwitched: boolean; // True if opened due to pending tasks
  lastManualMode: DrawerMode;
  width: number; // 30% reduction from current dual system (280px vs 400px)
}

/** Content for the tasks mode (replaces left drawer) */
export interface TasksModeContent {
  openTasks: HumanTask[];
  answeredIds: string[];
  busyId: string | null;
}

/** Content for the input mode (replaces right drawer) */
export interface InputModeContent {
  type: 'idea' | 'correction' | 'steer';
  text: string;
  history: HumanTask[];
}

/** Combined drawer content */
export interface DrawerContent {
  tasksMode: TasksModeContent;
  inputMode: InputModeContent;
}

/** Props for the AdaptiveDrawer component */
export interface AdaptiveDrawerProps {
  mode: DrawerMode | null;
  onClose: () => void;
  onModeChange: (mode: DrawerMode) => void;
  project: ProjectState | null;
}

/** Header configuration for drawer modes */
export interface AdaptiveDrawerHeader {
  title: string; // "AI needs you" or "You add to the agent"
  modeToggle: boolean; // Show toggle between tasks/input
  closeButton: boolean;
  count?: number; // Task count badge
}

/* ------------------------------------------------------------------------- */
/* Compact Status Bar Types                                                 */
/* ------------------------------------------------------------------------- */

/** Compact representation of build steps with space optimization */
export interface CompactBuildStep {
  key: string;
  state: 'pending' | 'active' | 'completed' | 'failed';
  label: string; // Only shown for active step
  order: number;
}

/** Props for the CompactStatusBar component (40% height reduction) */
export interface CompactStatusBarProps {
  project: ProjectState | null;
  status: ProjectStatus;
  stage: string;
  inProgress: boolean;
  steps: CompactBuildStep[];
  loopEvaluation: EverflowEvaluation | null;
  openAsks: number;
}

/* ------------------------------------------------------------------------- */
/* Embedded Terminal Types                                                  */
/* ------------------------------------------------------------------------- */

/** Terminal checks for validation */
export interface TerminalChecks {
  passed: boolean;
  nodeInstalled: boolean;
  platformioInstalled: boolean;
  gitInstalled: boolean;
  errors: string[];
}

/** State for the embedded terminal (replaces overlay dock) */
export interface EmbeddedTerminalState {
  isEmbedded: boolean; // true for new design
  sessionId: string;
  checks: TerminalChecks;
  autoActivated: boolean; // true if tab opened due to validation pass
}

/** Session persistence for terminal across navigation */
export interface TerminalSessionPersistence {
  output: string[];
  command: string;
  workingDirectory: string;
  processId?: number;
}

/** Props for the EmbeddedTerminal component */
export interface EmbeddedTerminalProps {
  projectId: string;
  checks: TerminalChecks;
  isActive: boolean; // Only render when Terminal tab is active
}

/* ------------------------------------------------------------------------- */
/* Compact Agent Console Types                                              */
/* ------------------------------------------------------------------------- */

/** Compact event representation for space-optimized console (50% reduction) */
export interface CompactEvent {
  id: string;
  type: string;
  message: string;
  timestamp: Date;
  expanded: boolean;
  groupedEvents?: CompactEvent[]; // For related events (e.g., multiple file ops)
  truncated?: boolean; // If content was truncated
}

/** Props for the CompactAgentConsole component */
export interface CompactAgentConsoleProps {
  events: AgentEvent[];
  maxEvents: number; // 5 instead of unlimited
  onEventExpand: (eventId: string) => void;
}

/* ------------------------------------------------------------------------- */
/* CSS Reduction and Space Optimization Types                               */
/* ------------------------------------------------------------------------- */

/** CSS utility configuration for space reductions */
export interface CSSReductionConfig {
  statusBarReduction: number; // 40% target
  consoleReduction: number; // 50% target  
  drawerReduction: number; // 30% target
  bundleSizeTarget: number; // 40% CSS file reduction
}

/** Spacing scale for condensed layouts */
export interface CondensedSpacing {
  xs: string; // 4px
  sm: string; // 8px  
  md: string; // 12px
  lg: string; // 16px
  xl: string; // 24px
}

/** Component height constraints for space optimization */
export interface CompactDimensions {
  statusHeight: string; // --status-height-compact: 120px
  consoleMaxHeight: string; // --console-max-height: 200px  
  drawerWidth: string; // --drawer-width-compact: 280px
}

/* ------------------------------------------------------------------------- */
/* Error Handling and Recovery Types                                        */
/* ------------------------------------------------------------------------- */

/** Navigation error types for consolidation fallbacks */
export interface NavigationError {
  code: 'CONSOLIDATION_FAILED' | 'ROUTE_NOT_FOUND' | 'SUB_ROUTE_ERROR';
  path: string;
  originalRoute?: string;
  message: string;
}

/** Error boundary configuration */
export interface NavigationErrorBoundary {
  fallbackTab: ConsolidatedTab; // Safe default ('overview')
  preserveSubRoute: boolean;
  errorRecovery: 'refresh' | 'redirect' | 'modal';
}

/** Drawer error recovery */
export interface DrawerError {
  code: 'MODE_INVALID' | 'CONTENT_LOAD_FAILED' | 'PERSISTENCE_ERROR';
  mode?: DrawerMode;
  message: string;
}

/** Terminal embedding error */
export interface TerminalError {
  code: 'EMBEDDING_FAILED' | 'SESSION_LOST' | 'CHECKS_UNAVAILABLE';
  fallbackToOverlay: boolean;
  message: string;
}

/* ------------------------------------------------------------------------- */
/* Backward Compatibility Types                                             */
/* ------------------------------------------------------------------------- */

/** Mapping from old routes to new consolidated routes */
export interface RouteMapping {
  oldRoute: string;
  newRoute: string;
  subRoute?: ConsolidatedSubRoute;
}

/** Legacy URL patterns that need redirection */
export interface LegacyRouteConfig {
  patterns: RouteMapping[];
  preserveQueryParams: boolean;
  redirectMode: 'permanent' | 'temporary';
}

/* ------------------------------------------------------------------------- */
/* Feature Flag and Rollout Types                                           */
/* ------------------------------------------------------------------------- */

/** Feature flag configuration for gradual rollout */
export interface CondensedUIConfig {
  enabled: boolean;
  rolloutPercentage: number; // 0-100
  userWhitelist: string[];
  fallbackToOriginal: boolean;
}

/** A/B testing configuration */
export interface UIVariant {
  name: 'original' | 'condensed';
  weight: number;
  config: Record<string, any>;
}

export interface UIExperiment {
  variants: UIVariant[];
  userAssignment: Map<string, string>; // userId -> variant
}

/* ------------------------------------------------------------------------- */
/* Testing and Validation Types                                             */
/* ------------------------------------------------------------------------- */

/** Property test configuration for UI validation */
export interface UIPropertyTestConfig {
  iterations: number; // 100+ per property
  timeoutMs: number;
  coverage: {
    navigationPaths: number;
    drawerModes: number; 
    responsiveBreakpoints: number;
  };
}

/** Space reduction validation */
export interface SpaceReductionMetrics {
  statusBarHeight: { before: number; after: number; reduction: number };
  consoleSpace: { before: number; after: number; reduction: number };
  drawerWidth: { before: number; after: number; reduction: number };
  cssBundle: { before: number; after: number; reduction: number };
}

/** Accessibility preservation validation */
export interface AccessibilityMetrics {
  keyboardNavigation: boolean;
  screenReaderCompatibility: boolean;
  focusManagement: boolean;
  ariaCompliance: boolean;
}
