import type {
  ProviderAdapter, ProviderConfig, ProviderRequest, ProviderResponse,
  ProviderStreamEvent, ProviderToolCallAccumulator,
} from "@forge/shared";
import { argumentsObject, array, callId, consumeCompletion, jsonEvents, object, post, text } from "./http";

export class OpenAIProvider implements ProviderAdapter {
  readonly name = "openai" as const;
  constructor(private readonly config: ProviderConfig) {}

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    return consumeCompletion(this.streamComplete(request));
  }

  async *streamComplete(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const messages = request.messages.map((message) => {
      if (message.role === "tool") return {
        role: "tool", tool_call_id: message.toolCallId, content: message.content,
      };
      return {
        role: message.role, content: message.content || (message.toolCalls?.length ? null : ""),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) } : {}),
      };
    });
    const response = await post(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      model: this.config.model, messages, stream: true, max_completion_tokens: request.maxTokens ?? 4096,
      ...(request.tools.length ? {
        tools: request.tools.map((tool) => ({ type: "function", function: {
          name: tool.name, description: tool.description, parameters: tool.parameters,
        } })), tool_choice: "auto",
      } : {}),
    }, { authorization: `Bearer ${this.config.apiKey ?? ""}` }, request.signal);

    let content = "";
    let finishReason = "";
    const calls = new Map<number, ProviderToolCallAccumulator>();
    for await (const event of jsonEvents(response)) {
      if (event.error) throw new Error("OpenAI streaming request failed.");
      const first = array(event.choices)[0];
      if (!first) continue;
      const choice = object(first);
      if (choice.finish_reason) finishReason = text(choice.finish_reason);
      const delta = object(choice.delta ?? {});
      if (text(delta.content)) {
        content += text(delta.content);
        yield { type: "text", delta: text(delta.content) };
      }
      for (const value of array(delta.tool_calls)) {
        const part = object(value);
        if (typeof part.index !== "number") throw new Error("Missing tool call index.");
        let call = calls.get(part.index);
        if (!call) {
          call = { id: "", name: "", argumentsJson: "" };
          calls.set(part.index, call);
        }
        if (text(part.id)) call.id = text(part.id);
        const fn = object(part.function ?? {});
        call.name += text(fn.name);
        call.argumentsJson += text(fn.arguments);
        if (call.argumentsJson.length > 2_097_152) throw new Error("Tool arguments are too large.");
      }
    }
    if (!["stop", "tool_calls"].includes(finishReason)) throw new Error("OpenAI response was interrupted or truncated.");
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id || callId(), name: call.name, args: argumentsObject(call.argumentsJson),
    }));
    if (toolCalls.some((call) => !call.name) || (!content && !toolCalls.length)) throw new Error("OpenAI returned an empty response.");
    yield { type: "complete", response: { content, toolCalls } };
  }
}
