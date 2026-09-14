import type {
  ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse,
  ProviderStreamEvent, ProviderToolCallAccumulator,
} from "@forge/shared";
import { argumentsObject, callId, consumeCompletion, jsonEvents, object, post, text } from "./http";

export class AnthropicProvider implements ProviderAdapter {
  readonly name = "anthropic" as const;
  constructor(private readonly config: ProviderConfig) {}

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const messages: Record<string, unknown>[] = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      const role = message.role === "assistant" ? "assistant" : "user";
      const content: Record<string, unknown>[] = [];
      if (message.role === "tool") {
        content.push({ type: "tool_result", tool_use_id: message.toolCallId, content: message.content });
      } else {
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
        }
      }
      if (!content.length) continue;
      const previous = messages.at(-1);
      if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...content);
      else messages.push({ role, content });
    }
    const response = await post(`${this.config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      model: this.config.model,
      system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      ...(request.tools.length ? {
        tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        tool_choice: { type: "auto" },
      } : {}),
    }, { "x-api-key": this.config.apiKey ?? "", "anthropic-version": "2023-06-01" }, request.signal);

    let content = "";
    let stopped = false;
    let stopReason = "";
    const calls = new Map<number, ProviderToolCallAccumulator>();
    for await (const event of jsonEvents(response)) {
      if (event.type === "error") throw new Error("Anthropic streaming request failed.");
      if (event.type === "content_block_start") {
        const block = object(event.content_block);
        if (block.type === "tool_use") {
          if (typeof event.index !== "number") throw new Error("Missing tool block index.");
          calls.set(event.index, {
            id: text(block.id) || callId(), name: text(block.name), argumentsJson: "",
            initialArgs: argumentsObject(block.input),
          });
        } else if (block.type === "text" && text(block.text)) {
          const delta = text(block.text);
          content += delta;
          yield { type: "text", delta };
        }
      } else if (event.type === "content_block_delta") {
        const delta = object(event.delta);
        if (delta.type === "text_delta") {
          content += text(delta.text);
          yield { type: "text", delta: text(delta.text) };
        } else if (delta.type === "input_json_delta") {
          const call = calls.get(Number(event.index));
          if (!call) throw new Error("Tool argument delta has no matching tool call.");
          call.argumentsJson += text(delta.partial_json);
          if (call.argumentsJson.length > 2_097_152) throw new Error("Tool arguments are too large.");
        }
      } else if (event.type === "message_delta") {
        stopReason = text(object(event.delta).stop_reason);
      } else if (event.type === "message_stop") stopped = true;
    }
    if (!stopped || !["end_turn", "tool_use", "stop_sequence"].includes(stopReason)) {
      throw new Error("Anthropic response was interrupted or truncated.");
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id, name: call.name,
      args: call.argumentsJson ? argumentsObject(call.argumentsJson) : call.initialArgs ?? {},
    }));
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) throw new Error("Anthropic returned an empty response.");
    yield { type: "complete", response: { content, toolCalls } };
  }
}
