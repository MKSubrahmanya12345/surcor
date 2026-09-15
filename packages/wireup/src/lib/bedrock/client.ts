/**
 * Amazon Bedrock client.
 *
 * The single place in the codebase that talks to Bedrock.
 *
 * Transport:
 *   - moonshotai.kimi-k2.5 -> Bedrock Mantle Chat Completions
 *   - all other Bedrock models -> native Bedrock Converse
 *
 * Region, credentials and model ids come from the environment
 * (`lib/validation/env.ts`).
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { createLogger, describeError } from '@/lib/logging/logger';
import { applyDnsResultOrder } from '@/lib/net/dns';
import { env, requireBedrockEnv } from '@/lib/validation/env';

const logger = createLogger('bedrock');

export type BedrockOp =
  | 'generation'
  | 'validation'
  | 'firmware_review'
  | 'fix'
  | 'codegen'
  | 'intake'
  | 'idea_expansion'
  | 'idea_review'
  | 'assembly';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export class BedrockError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly model: string;

  /** How many round trips were made before giving up. */
  attempts: number;

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      statusCode?: number;
      model?: string;
    } = {},
  ) {
    super(message);
    this.name = 'BedrockError';
    this.code = options.code ?? 'bedrock_error';
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.model = options.model ?? 'unknown';
    this.attempts = 0;
  }
}

interface ClientCache {
  client: BedrockRuntimeClient | null;
  region: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupBedrock: ClientCache | undefined;
}

const cache: ClientCache =
  globalThis.__wireupBedrock ?? {
    client: null,
    region: null,
  };

globalThis.__wireupBedrock = cache;

function buildClient(): {
  client: BedrockRuntimeClient;
  region: string;
} {
  const config = requireBedrockEnv();

  /*
   * Applied before the first socket is opened.
   * See lib/net/dns.ts.
   */
  const dnsOrder = applyDnsResultOrder(
    env().net.dnsResultOrder,
  );

  if (
    cache.client &&
    cache.region === config.region
  ) {
    return {
      client: cache.client,
      region: config.region,
    };
  }

  const client = new BedrockRuntimeClient({
    region: config.region,

    ...(config.accessKeyId &&
    config.secretAccessKey
      ? {
          credentials: {
            accessKeyId:
              config.accessKeyId,
            secretAccessKey:
              config.secretAccessKey,
            ...(config.sessionToken
              ? {
                  sessionToken:
                    config.sessionToken,
                }
              : {}),
          },
        }
      : {}),

    maxAttempts: 1,
  });

  cache.client = client;
  cache.region = config.region;

  logger.info('client ready', {
    region: config.region,
    dnsResultOrder: dnsOrder,
  });

  return {
    client,
    region: config.region,
  };
}

/** Resolve which model serves a given operation. */
export function resolveModel(
  op: BedrockOp,
): string {
  const config = env().bedrock;

  const model =
    (op === 'validation'
      ? config.validationModelId
      : undefined) ??
    (op === 'fix'
      ? config.fixerModelId
      : undefined) ??
    (op === 'codegen'
      ? config.codegenModelId
      : undefined) ??
    config.modelId;

  if (!model) {
    throw new BedrockError(
      `No Bedrock model configured for op "${op}". ` +
        `Set BEDROCK_MODEL_ID ` +
        `(and optionally BEDROCK_${op.toUpperCase()}_MODEL_ID) ` +
        `in .env.`,
      {
        code:
          'missing_model_configuration',
      },
    );
  }

  return model;
}

export interface ConverseOptions {
  op: BedrockOp;
  model?: string;
  system?: string[];
  userText: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
}

function createTimeoutSignal(
  ms: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    ms,
  );

  return {
    signal: controller.signal,
    dispose: () =>
      clearTimeout(timer),
  };
}

interface ErrorFrame {
  name?: string;
  code?: string;
  message: string;
}

/**
 * Walk an error and its cause chain.
 *
 * Transport failures can arrive wrapped:
 *
 * ERR_HTTP2_STREAM_CANCEL
 *   -> EAI_AGAIN
 *
 * The deepest network error is therefore important when classifying
 * retryability.
 */
function errorFrames(
  error: unknown,
): ErrorFrame[] {
  const frames: ErrorFrame[] = [];

  let current: unknown = error;

  for (
    let depth = 0;
    current && depth < 6;
    depth += 1
  ) {
    if (current instanceof Error) {
      const code =
        (current as NodeJS.ErrnoException)
          .code;

      frames.push({
        name: current.name,
        ...(typeof code === 'string'
          ? { code }
          : {}),
        message: current.message,
      });

      current = (
        current as {
          cause?: unknown;
        }
      ).cause;

      continue;
    }

    frames.push({
      message:
        describeError(current).message,
    });

    break;
  }

  return frames;
}

const NETWORK_ERROR_CODES =
  new Set([
    'EAI_AGAIN',
    'EAI_FAIL',
    'EAI_NODATA',
    'EAI_NONAME',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPIPE',
    'ENETUNREACH',
    'ENETDOWN',
    'EHOSTUNREACH',
    'EADDRNOTAVAIL',
    'ERR_HTTP2_STREAM_CANCEL',
    'ERR_HTTP2_STREAM_ERROR',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);

const DNS_ERROR_CODES =
  new Set([
    'EAI_AGAIN',
    'EAI_FAIL',
    'EAI_NODATA',
    'EAI_NONAME',
    'ENOTFOUND',
  ]);

function classifyError(
  error: unknown,
  model: string,
): BedrockError {
  const described =
    describeError(error);

  const frames =
    errorFrames(error);

  const name =
    frames[0]?.name ??
    described.name ??
    '';

  const statusCode =
    typeof (
      error as {
        $metadata?: {
          httpStatusCode?: number;
        };
      }
    )?.$metadata?.httpStatusCode ===
    'number'
      ? (
          error as {
            $metadata: {
              httpStatusCode: number;
            };
          }
        ).$metadata.httpStatusCode
      : undefined;

  const codes = frames
    .map(
      (frame) => frame.code,
    )
    .filter(
      (
        code,
      ): code is string =>
        typeof code === 'string',
    );

  const networkCode =
    [...codes]
      .reverse()
      .find((code) =>
        NETWORK_ERROR_CODES.has(
          code,
        ),
      );

  const haystack = [
    name,
    ...codes,
    ...frames.map(
      (frame) => frame.message,
    ),
  ].join(' | ');

  const retryableNames = [
    'ThrottlingException',
    'ModelTimeoutException',
    'ServiceQuotaExceededException',
    'ServiceUnavailableException',
    'InternalServerException',
    'TooManyRequestsException',
    'TimeoutError',
    'AbortError',
    'ECONNRESET',
    'ETIMEDOUT',
  ];

  const retryable =
    networkCode !== undefined ||
    retryableNames.some(
      (candidate) =>
        haystack.includes(
          candidate,
        ),
    ) ||
    haystack.includes(
      'socket hang up',
    ) ||
    (statusCode !== undefined &&
      (statusCode === 429 ||
        statusCode >= 500));

  const code =
    networkCode ??
    (name && name !== 'Error'
      ? name
      : undefined) ??
    (statusCode
      ? `http_${statusCode}`
      : undefined) ??
    'bedrock_error';

  if (networkCode) {
    const region =
      env().bedrock.region;

    const host =
      `bedrock-runtime.${region}.amazonaws.com`;

    const dnsFailure =
      DNS_ERROR_CODES.has(
        networkCode,
      );

    return new BedrockError(
      dnsFailure
        ? `Cannot reach Amazon Bedrock in ${region}: DNS lookup for ${host} failed (${networkCode}). ` +
            'The request never left this machine, so credentials, model id and permissions were not evaluated. ' +
            'Check the DNS resolver on the host running Wireup and retry.'
        : `Cannot reach Amazon Bedrock in ${region}: the connection to ${host} failed (${networkCode}). ` +
            'The request did not complete a round trip, so this is a network problem rather than a model or credentials problem.',
      {
        code,
        retryable,
        statusCode,
        model,
      },
    );
  }

  if (
    name ===
      'AccessDeniedException' ||
    statusCode === 403
  ) {
    return new BedrockError(
      `Bedrock denied access to model "${model}". ` +
        `Check AWS credentials and that the model is enabled in ${env().bedrock.region}.`,
      {
        code,
        retryable: false,
        statusCode,
        model,
      },
    );
  }

  if (
    name ===
      'ValidationException' ||
    statusCode === 400
  ) {
    return new BedrockError(
      `Bedrock rejected the request for model "${model}": ${described.message}`,
      {
        code,
        retryable: false,
        statusCode,
        model,
      },
    );
  }

  if (
    name ===
      'ResourceNotFoundException' ||
    statusCode === 404
  ) {
    return new BedrockError(
      `Bedrock model "${model}" was not found in ${env().bedrock.region}. ` +
        'Check BEDROCK_MODEL_ID.',
      {
        code,
        retryable: false,
        statusCode,
        model,
      },
    );
  }

  return new BedrockError(
    described.message ||
      'Bedrock call failed',
    {
      code,
      retryable,
      statusCode,
      model,
    },
  );
}

/**
 * Extract text from the native Bedrock Converse response.
 *
 * Kept because other parts of Wireup use the native Converse response
 * shape through converseRaw().
 */
export function extractText(
  output: ConverseCommandOutput,
): string {
  const content =
    output.output?.message
      ?.content ?? [];

  return content
    .map((block) =>
      'text' in block &&
      typeof block.text ===
        'string'
        ? block.text
        : '',
    )
    .join('')
    .trim();
}

export interface ConverseRawOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Execute a native Bedrock ConverseCommand.
 *
 * This function intentionally remains native Converse.
 *
 * Kimi K2.5 does NOT use this path. `converse()` detects Kimi and
 * sends it through Bedrock Mantle Chat Completions instead.
 *
 * Keeping this function intact preserves the existing Bedrock barrel
 * and any callers that require the native Converse response.
 */
export async function converseRaw(
  input: ConverseCommandInput,
  options?: ConverseRawOptions,
): Promise<{
  output: ConverseCommandOutput;
  model: string;
  attempts: number;
  durationMs: number;
}> {
  const config =
    env().bedrock;

  const model =
    input.modelId ??
    config.modelId ??
    'unknown';

  const maxRetries =
    options?.maxRetries ??
    Math.max(
      0,
      config.maxRetries,
    );

  const timeoutMs =
    options?.timeoutMs ??
    config.timeoutMs;

  const startedAt = Date.now();

  let attempt = 0;
  let lastError:
    | BedrockError
    | null = null;

  while (
    attempt <= maxRetries
  ) {
    attempt += 1;

    const { client } =
      buildClient();

    const timeout =
      createTimeoutSignal(
        timeoutMs,
      );

    try {
      const command =
        new ConverseCommand(
          input,
        );

      const output =
        await client.send(
          command,
          {
            abortSignal:
              timeout.signal,
          },
        );

      return {
        output,
        model,
        attempts: attempt,
        durationMs:
          Date.now() -
          startedAt,
      };
    } catch (error) {
      lastError =
        error instanceof
        BedrockError
          ? error
          : classifyError(
              error,
              model,
            );

      logger.warn(
        'call failed',
        {
          model,
          attempt,
          code:
            lastError.code,
          retryable:
            lastError.retryable,
          error:
            lastError.message,
        },
      );

      if (
        !lastError.retryable ||
        attempt > maxRetries
      ) {
        break;
      }

      const backoff =
        Math.min(
          8000,
          500 *
            2 **
              (attempt - 1),
        );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            backoff,
          ),
      );
    } finally {
      timeout.dispose();
    }
  }

  if (lastError) {
    lastError.attempts =
      attempt;

    throw lastError;
  }

  throw new BedrockError(
    'Bedrock call failed for an unknown reason.',
    { model },
  );
}

/**
 * Kimi K2.5 must use Bedrock Mantle Chat Completions.
 *
 * Native Bedrock Converse currently produces:
 *
 *   ValidationException:
 *   Operation not allowed
 *
 * for the configuration this project is using.
 */
function isKimiK25(
  model: string,
): boolean {
  return (
    model
      .trim()
      .toLowerCase() ===
    'moonshotai.kimi-k2.5'
  );
}

interface MantleResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?:
        | string
        | null;
    };
    finish_reason?:
      | string
      | null;
  }>;

  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };

  model?: string;

  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

function mantleEndpoint(
  region: string,
): string {
  return `https://bedrock-mantle.${region}.api.aws/v1/chat/completions`;
}

function mantleErrorMessage(
  response: Response,
  body: unknown,
): string {
  if (
    body &&
    typeof body ===
      'object' &&
    'error' in body
  ) {
    const error =
      (
        body as MantleResponse
      ).error;

    if (
      error?.message
    ) {
      return error.message;
    }
  }

  if (
    typeof body ===
      'string' &&
    body.trim()
  ) {
    return body;
  }

  return `${response.status} ${response.statusText}`;
}

function classifyMantleHttpError(
  response: Response,
  body: unknown,
  model: string,
): BedrockError {
  const message =
    mantleErrorMessage(
      response,
      body,
    );

  if (
    response.status === 401
  ) {
    return new BedrockError(
      `Bedrock Mantle authentication failed for model "${model}". ` +
        'Check BEDROCK_API_KEY.',
      {
        code:
          'authentication_failed',
        retryable: false,
        statusCode: 401,
        model,
      },
    );
  }

  if (
    response.status === 403
  ) {
    return new BedrockError(
      `Bedrock Mantle denied access to model "${model}": ${message}`,
      {
        code:
          'access_denied',
        retryable: false,
        statusCode: 403,
        model,
      },
    );
  }

  if (
    response.status === 400
  ) {
    return new BedrockError(
      `Bedrock Mantle rejected the request for model "${model}": ${message}`,
      {
        code:
          'validation_error',
        retryable: false,
        statusCode: 400,
        model,
      },
    );
  }

  if (
    response.status === 404
  ) {
    return new BedrockError(
      `Bedrock Mantle could not find model "${model}" in ${env().bedrock.region}: ${message}`,
      {
        code:
          'model_not_found',
        retryable: false,
        statusCode: 404,
        model,
      },
    );
  }

  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    return new BedrockError(
      `Bedrock Mantle request failed (${response.status}): ${message}`,
      {
        code: `http_${response.status}`,
        retryable: true,
        statusCode:
          response.status,
        model,
      },
    );
  }

  return new BedrockError(
    `Bedrock Mantle request failed (${response.status}): ${message}`,
    {
      code:
        `http_${response.status}`,
      retryable: false,
      statusCode:
        response.status,
      model,
    },
  );
}

function classifyMantleNetworkError(
  error: unknown,
  model: string,
): BedrockError {
  const message =
    describeError(error)
      .message;

  const code =
    error instanceof Error &&
    typeof (
      error as NodeJS.ErrnoException
    ).code === 'string'
      ? (
          error as NodeJS.ErrnoException
        ).code
      : undefined;

  const retryableCodes =
    new Set([
      'EAI_AGAIN',
      'EAI_FAIL',
      'EAI_NODATA',
      'EAI_NONAME',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ECONNRESET',
      'ECONNABORTED',
      'ETIMEDOUT',
      'EPIPE',
      'ENETUNREACH',
      'ENETDOWN',
      'EHOSTUNREACH',
      'EADDRNOTAVAIL',
      'ERR_HTTP2_STREAM_CANCEL',
      'ERR_HTTP2_STREAM_ERROR',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ]);

  const retryable =
    (code !== undefined &&
      retryableCodes.has(
        code,
      )) ||
    message
      .toLowerCase()
      .includes('timeout') ||
    message
      .toLowerCase()
      .includes('socket') ||
    message
      .toLowerCase()
      .includes('network');

  return new BedrockError(
    `Cannot reach Bedrock Mantle in ${env().bedrock.region}: ${message}`,
    {
      code:
        code ??
        'network_error',
      retryable,
      model,
    },
  );
}

/**
 * Execute Kimi through Bedrock Mantle Chat Completions.
 */
async function mantleChatCompletions(
  options: ConverseOptions,
): Promise<{
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason?: string;
  attempts: number;
  durationMs: number;
}> {
  const config =
    env().bedrock;

  const model =
    options.model ??
    resolveModel(
      options.op,
    );

  /*
   * BEDROCK_API_KEY is read directly so this client remains compatible
   * even if older env.ts versions don't expose it on ServerEnv yet.
   */
  const apiKey =
    process.env.BEDROCK_API_KEY?.trim();

  if (!apiKey) {
    throw new BedrockError(
      'BEDROCK_API_KEY is not configured. ' +
        'Set BEDROCK_API_KEY to your Amazon Bedrock API key.',
      {
        code:
          'missing_bedrock_api_key',
        retryable: false,
        model,
      },
    );
  }

  const maxRetries =
    Math.max(
      0,
      config.maxRetries,
    );

  const timeoutMs =
    options.timeoutMs ??
    config.timeoutMs;

  const endpoint =
    mantleEndpoint(
      config.region,
    );

  /*
   * Kimi K2.5 has a 16k output limit.
   *
   * This prevents the existing BEDROCK_MAX_TOKENS_CEILING=160000
   * configuration from producing an invalid Kimi request.
   */
  const requestedMaxTokens =
    options.maxTokens ??
    config.maxTokens;

  const maxTokens =
    Math.min(
      Math.max(
        1,
        requestedMaxTokens,
      ),
      16_000,
    );

  const messages: Array<{
    role:
      | 'system'
      | 'user';
    content: string;
  }> = [];

  if (
    options.system &&
    options.system.length > 0
  ) {
    messages.push({
      role: 'system',
      content:
        options.system.join(
          '\n\n',
        ),
    });
  }

  messages.push({
    role: 'user',
    content:
      options.userText,
  });

  const startedAt =
    Date.now();

  let attempt = 0;

  let lastError:
    | BedrockError
    | null = null;

  while (
    attempt <= maxRetries
  ) {
    attempt += 1;

    const timeout =
      createTimeoutSignal(
        timeoutMs,
      );

    try {
      const dnsOrder =
        applyDnsResultOrder(
          env().net
            .dnsResultOrder,
        );

      logger.info(
        'Mantle request',
        {
          op: options.op,
          model,
          region:
            config.region,
          endpoint,
          attempt,
          maxTokens,
          temperature:
            options.temperature ??
            config.temperature,
          topP:
            options.topP ??
            config.topP,
          dnsResultOrder:
            dnsOrder,
        },
      );

      const response =
        await fetch(
          endpoint,
          {
            method: 'POST',
            headers: {
              Authorization:
                `Bearer ${apiKey}`,
              'Content-Type':
                'application/json',
              Accept:
                'application/json',
            },
            body: JSON.stringify(
              {
                model,
                messages,
                max_tokens:
                  maxTokens,
                temperature:
                  options.temperature ??
                  config.temperature,
                top_p:
                  options.topP ??
                  config.topP,
              },
            ),
            signal:
              timeout.signal,
          },
        );

      let body: unknown;

      const contentType =
        response.headers.get(
          'content-type',
        ) ?? '';

      if (
        contentType.includes(
          'application/json',
        )
      ) {
        body =
          await response.json();
      } else {
        body =
          await response.text();
      }

      if (!response.ok) {
        throw classifyMantleHttpError(
          response,
          body,
          model,
        );
      }

      const result =
        body as MantleResponse;

      const text =
        result
          .choices?.[0]
          ?.message?.content
          ?.trim() ?? '';

      if (!text) {
        throw new BedrockError(
          'Bedrock Mantle returned an empty completion.',
          {
            code:
              'empty_completion',
            retryable:
              attempt <=
              maxRetries,
            model,
          },
        );
      }

      const inputTokens =
        result.usage
          ?.input_tokens ??
        result.usage
          ?.prompt_tokens;

      const outputTokens =
        result.usage
          ?.output_tokens ??
        result.usage
          ?.completion_tokens;

      const totalTokens =
        result.usage
          ?.total_tokens ??
        (
          inputTokens !==
            undefined &&
          outputTokens !==
            undefined
            ? inputTokens +
              outputTokens
            : undefined
        );

      const stopReason =
        result
          .choices?.[0]
          ?.finish_reason ??
        undefined;

      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        model:
          result.model ??
          model,
        ...(stopReason
          ? {
              stopReason,
            }
          : {}),
        attempts: attempt,
        durationMs:
          Date.now() -
          startedAt,
      };
    } catch (error) {
      lastError =
        error instanceof
        BedrockError
          ? error
          : classifyMantleNetworkError(
              error,
              model,
            );

      logger.warn(
        'Mantle call failed',
        {
          op: options.op,
          model,
          attempt,
          code:
            lastError.code,
          retryable:
            lastError.retryable,
          error:
            lastError.message,
        },
      );

      if (
        !lastError.retryable ||
        attempt > maxRetries
      ) {
        break;
      }

      const backoff =
        Math.min(
          8000,
          500 *
            2 **
              (attempt - 1),
        );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            backoff,
          ),
      );
    } finally {
      timeout.dispose();
    }
  }

  if (lastError) {
    lastError.attempts =
      attempt;

    throw lastError;
  }

  throw new BedrockError(
    'Bedrock Mantle call failed for an unknown reason.',
    {
      model,
    },
  );
}

/**
 * One Bedrock model call.
 *
 * Kimi K2.5:
 *   -> Bedrock Mantle Chat Completions
 *
 * Everything else:
 *   -> native Bedrock Converse
 */
export async function converse(
  options: ConverseOptions,
): Promise<{
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason?: string;
  attempts: number;
  durationMs: number;
}> {
  const model =
    options.model ??
    resolveModel(
      options.op,
    );

  if (
    isKimiK25(model)
  ) {
    return mantleChatCompletions(
      {
        ...options,
        model,
      },
    );
  }

  /*
   * Preserve the original native Converse behavior for every model
   * other than Kimi K2.5.
   */
  const config =
    env().bedrock;

  const input:
    ConverseCommandInput = {
    modelId: model,

    messages: [
      {
        role: 'user',
        content: [
          {
            text:
              options.userText,
          },
        ],
      },
    ],

    ...(options.system &&
    options.system.length > 0
      ? {
          system:
            options.system.map(
              (text) => ({
                text,
              }),
            ),
        }
      : {}),

    inferenceConfig: {
      maxTokens:
        options.maxTokens ??
        config.maxTokens,

      temperature:
        options.temperature ??
        config.temperature,

      topP:
        options.topP ??
        config.topP,
    },
  };

  const raw =
    await converseRaw(
      input,
      {
        timeoutMs:
          options.timeoutMs,
        maxRetries:
          config.maxRetries,
      },
    );

  const text =
    extractText(
      raw.output,
    );

  if (!text) {
    throw new BedrockError(
      'Bedrock returned an empty completion.',
      {
        code:
          'empty_completion',
        retryable: false,
        model,
      },
    );
  }

  return {
    text,
    usage: {
      inputTokens:
        raw.output.usage
          ?.inputTokens,
      outputTokens:
        raw.output.usage
          ?.outputTokens,
      totalTokens:
        raw.output.usage
          ?.totalTokens,
    },
    model:
      raw.model,
    stopReason:
      raw.output.stopReason,
    attempts:
      raw.attempts,
    durationMs:
      raw.durationMs,
  };
}

/**
 * Non-throwing probe used by the API health endpoint.
 */
export async function describeBedrockConfig(): Promise<{
  configured: boolean;
  region: string;
  model?: string;
  validationModel?: string;
  fixerModel?: string;
  codegenModel?: string;
  transport?:
    | 'bedrock'
    | 'openai'
    | 'anthropic'
    | 'gemini';
  maxTokens: number;
  temperature: number;
  problem?: string;
}> {
  const config =
    env().bedrock;

  const modelId =
    config.modelId?.trim() ??
    '';

  const haystack =
    modelId
      .toLowerCase()
      .replace(
        /^models\//,
        '',
      );

  /*
   * Detect direct-transport availability without requiring Bedrock creds.
   */
  const hasOpenAI =
    Boolean(
      env().models
        .openaiApiKey,
    );

  const hasAnthropic =
    Boolean(
      env().models
        .anthropicApiKey,
    );

  const hasGemini =
    Boolean(
      env().models
        .geminiApiKey,
    );

  const directAstra =
    /^gpt-6-astra(?:[-.][a-z0-9]+)*$/.test(
      haystack,
    );

  const directGemini =
    haystack.startsWith(
      'gemini-',
    ) &&
    !haystack.includes(
      'arn:',
    ) &&
    !haystack.includes(
      ':',
    );

  const directFable =
    /fable|opus-5|sonnet-5/.test(
      haystack,
    );

  if (
    directAstra &&
    hasOpenAI
  ) {
    return {
      configured: true,
      region:
        config.region,
      model:
        config.modelId,
      validationModel:
        config.validationModelId ||
        config.modelId,
      fixerModel:
        config.fixerModelId ||
        config.modelId,
      codegenModel:
        config.codegenModelId,
      transport:
        'openai',
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
    };
  }

  if (
    directFable &&
    hasAnthropic
  ) {
    return {
      configured: true,
      region:
        config.region,
      model:
        config.modelId,
      validationModel:
        config.validationModelId ||
        config.modelId,
      fixerModel:
        config.fixerModelId ||
        config.modelId,
      codegenModel:
        config.codegenModelId,
      transport:
        'anthropic',
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
    };
  }

  if (
    directGemini &&
    hasGemini
  ) {
    return {
      configured: true,
      region:
        config.region,
      model:
        config.modelId,
      validationModel:
        config.validationModelId ||
        config.modelId,
      fixerModel:
        config.fixerModelId ||
        config.modelId,
      codegenModel:
        config.codegenModelId,
      transport:
        'gemini',
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
    };
  }

  /*
   * Kimi uses Mantle API-key authentication.
   *
   * Do not require the AWS SDK credentials merely to report the
   * configuration as available.
   */
  if (
    isKimiK25(
      modelId,
    ) &&
    Boolean(
      process.env
        .BEDROCK_API_KEY?.trim(),
    )
  ) {
    return {
      configured: true,
      region:
        config.region,
      model:
        config.modelId,
      validationModel:
        config.validationModelId ||
        config.modelId,
      fixerModel:
        config.fixerModelId ||
        config.modelId,
      codegenModel:
        config.codegenModelId,
      transport:
        'bedrock',
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
    };
  }

  try {
    requireBedrockEnv();

    return {
      configured: true,
      region:
        config.region,
      model:
        config.modelId,
      validationModel:
        config.validationModelId ||
        config.modelId,
      fixerModel:
        config.fixerModelId ||
        config.modelId,
      codegenModel:
        config.codegenModelId,
      transport:
        'bedrock',
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
    };
  } catch (error) {
    return {
      configured: false,
      region:
        config.region,
      model:
        config.modelId,
      maxTokens:
        config.maxTokens,
      temperature:
        config.temperature,
      problem:
        describeError(error)
          .message,
    };
  }
}