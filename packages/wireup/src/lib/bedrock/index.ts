/** Bedrock service barrel. */

export {
  BedrockError,
  converse,
  converseRaw,
  describeBedrockConfig,
  extractText,
  resolveModel,
  type BedrockOp,
  type ConverseOptions,
  type ConverseRawOptions,
  type TokenUsage,
} from './client';

export {
  generateProjectSpec,
  reviewFirmware,
  proposeFixChanges,
  reviewProject,
  type BedrockOperationResult,
} from './operations';

export {
  buildFixUserPrompt,
  buildGenerationUserPrompt,
  buildValidationUserPrompt,
  ENGINEER_PERSONA,
  GENERATION_JSON_CONTRACT,
  ISSUE_CODE_LIST,
  VALIDATION_JSON_CONTRACT,
  type FixPromptInput,
  type GenerationPromptInput,
  type ValidationPromptInput,
} from './prompts';

export { runStructuredCall, type StructuredCallOptions, type StructuredCallResult } from './structured';
