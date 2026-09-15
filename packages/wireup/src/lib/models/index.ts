/**
 * Model layer — public surface.
 *
 * `converseRouted` is the only function operations need: it picks the
 * transport by model id (Astra/Fable direct when a key exists, else Bedrock
 * Converse with family-correct config) and normalises the result.
 */

export type { EffortLevel, ModelCallUsage, ModelFamily, ModelTransport, RoutedCallOptions, RoutedCallResult } from './types';
export { ModelRouteError } from './types';
export type { EffortOp } from './detect';
export { compareEffort, defaultEffort, detectModelFamily, isAstraModel, isDirectAstraModelId, isDirectGeminiModelId, isFableModel, isGeminiModel, parseEffort } from './detect';
export type { RouteDecision } from './router';
export { converseRouted, decideRoute } from './router';
export type { AstraFunctionCall, AstraFunctionOutput, AstraFunctionTool, AstraResponseItem, AstraResponsesPayload, AstraToolTurn, AstraToolTurnRequest } from './openai-astra';
export { attachToolResult, astraDirectAvailable, callAstra, callAstraToolTurn, parseAstraToolTurn, pendingToolCount, registerAsyncTool, updateEffort } from './openai-astra';
export { callFable, effortForTurn, fableDirectAvailable, headroomFor } from './anthropic-fable';
export { callGemini, geminiDirectAvailable } from './gemini';
