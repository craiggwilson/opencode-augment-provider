import * as fs from "node:fs";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger } from "./augment-model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the debug trace log file. */
const TRACE_LOG_PATH = "/tmp/augment-provider-trace.log";

// ---------------------------------------------------------------------------
// Augment API types (request)
// ---------------------------------------------------------------------------

enum ChatRequestNodeType {
  TEXT = 0,
  TOOL_RESULT = 1,
  IMAGE = 2,
  IMAGE_ID = 3,
  IDE_STATE = 4,
  EDIT_EVENTS = 5,
}

enum ChatResultNodeType {
  RAW_RESPONSE = 0,
  SUGGESTED_QUESTIONS = 1,
  MAIN_TEXT_FINISHED = 2,
  WORKSPACE_FILE_CHUNKS = 3,
  RELEVANT_SOURCES = 4,
  TOOL_USE = 5,
  TOOL_USE_START = 7,
  THINKING = 8,
  BILLING_METADATA = 9,
  TOKEN_USAGE = 10,
}

enum ChatStopReason {
  REASON_UNSPECIFIED = 0,
  END_TURN = 1,
  MAX_TOKENS = 2,
  TOOL_USE_REQUESTED = 3,
  SAFETY = 4,
  RECITATION = 5,
  MALFORMED_FUNCTION_CALL = 6,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Credentials and connection settings for the Augment API.
 */
export interface AugmentLanguageModelConfig {
  /** Bearer token for the Augment API. */
  apiKey: string;
  /** Base URL for the Augment API (without trailing slash). */
  apiUrl: string;
  /** Enable debug logging. */
  debug?: boolean;
  /**
   * Custom User-Agent string. Defaults to "augment.sdk.ai/{version} (typescript)".
   */
  clientUserAgent?: string;
}

// ---------------------------------------------------------------------------
// Trace logging (temporary diagnostic aid)
// ---------------------------------------------------------------------------

const TRACE_ENABLED = Boolean(process.env.OPENCODE_AUGMENT_PROVIDER_DEBUG);

let traceSeq = 0;

/**
 * Appends a JSON entry to the trace log file when `OPENCODE_AUGMENT_PROVIDER_DEBUG` is set.
 */
function trace(event: string, data: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;
  try {
    const entry = JSON.stringify({ seq: traceSeq++, ts: new Date().toISOString(), event, ...data });
    fs.appendFileSync(TRACE_LOG_PATH, `${entry}\n`);
  } catch {
    // Best-effort — never crash the provider over trace logging.
  }
}

/**
 * Estimates the number of input tokens by counting characters across all prompt messages
 * and dividing by 4, which is the standard approximation (1 token ≈ 4 characters).
 *
 * The Augment API reports unreliable `input_tokens` values in TOKEN_USAGE nodes for
 * multi-turn conversations — it returns the delta token count for the latest turn rather
 * than the full accumulated context size. Character-based estimation produces a much more
 * useful count for display in the OpenCode sidebar.
 */
function estimateInputTokens(prompt: LanguageModelV3CallOptions["prompt"]): number {
  let chars = 0;
  for (const msg of prompt) {
    if (msg.role === "system") {
      chars += (typeof msg.content === "string" ? msg.content : "").length;
    } else if (msg.role === "user" || msg.role === "assistant") {
      for (const p of msg.content) {
        if ("text" in p && typeof p.text === "string") {
          chars += p.text.length;
        }
      }
    } else if (msg.role === "tool") {
      for (const p of msg.content) {
        if (p.type === "tool-result") {
          const out = p.output;
          if (out.type === "text" || out.type === "error-text") {
            chars += out.value.length;
          } else if (out.type === "json" || out.type === "error-json") {
            chars += JSON.stringify(out.value).length;
          }
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Summarises a prompt into a compact structure for trace logging.
 */
function summarisePrompt(
  prompt: LanguageModelV3CallOptions["prompt"]
): Array<{ parts: Array<Record<string, unknown>>; role: string }> {
  return prompt.map((msg) => {
    const parts: Array<Record<string, unknown>> = [];
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      parts.push({ length: text.length, preview: text.slice(0, 200), type: "system" });
    } else if (msg.role === "user") {
      for (const p of msg.content) {
        if (p.type === "text") {
          parts.push({ length: p.text.length, preview: p.text.slice(0, 200), type: "text" });
        } else {
          parts.push({ type: p.type });
        }
      }
    } else if (msg.role === "assistant") {
      for (const p of msg.content) {
        if (p.type === "text") {
          parts.push({ length: p.text.length, preview: p.text.slice(0, 200), type: "text" });
        } else if (p.type === "tool-call") {
          parts.push({ toolCallId: p.toolCallId, toolName: p.toolName, type: "tool-call" });
        } else if (p.type === "reasoning") {
          parts.push({ length: p.text.length, type: "reasoning" });
        } else {
          parts.push({ type: (p as { type: string }).type });
        }
      }
    } else if (msg.role === "tool") {
      for (const p of msg.content) {
        if (p.type === "tool-result") {
          parts.push({ toolCallId: p.toolCallId, toolName: p.toolName, type: "tool-result" });
        }
      }
    }
    return { parts, role: msg.role };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { text: string; type: "text" } =>
          typeof p === "object" && p !== null && p.type === "text"
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function toolsToDefinitions(tools: LanguageModelV3CallOptions["tools"]) {
  if (!tools) return [];
  return tools
    .filter(
      (t): t is { description?: string; inputSchema: object; name: string; type: "function" } =>
        t.type === "function"
    )
    .map((t) => ({
      description: t.description ?? "",
      input_schema_json: JSON.stringify(t.inputSchema),
      name: t.name,
    }));
}

function userMessageToNodes(
  msg: LanguageModelV3CallOptions["prompt"][number] & { role: "user" },
  startId: number
) {
  const nodes: {
    id: number;
    text_node?: { content: string };
    type: ChatRequestNodeType;
  }[] = [];
  let text = "";
  let id = startId;
  for (const part of msg.content) {
    if (part.type === "text") {
      nodes.push({ id: id++, type: ChatRequestNodeType.TEXT, text_node: { content: part.text } });
      text += part.text;
    }
  }
  return { nodes, text };
}

function toolMessageToNodes(
  msg: LanguageModelV3CallOptions["prompt"][number] & { role: "tool" },
  startId: number
) {
  const nodes: {
    id: number;
    tool_result_node?: { content: string; is_error: boolean; tool_use_id: string };
    type: ChatRequestNodeType;
  }[] = [];
  let id = startId;
  for (const part of msg.content) {
    if (part.type === "tool-result") {
      let content = "";
      let isError = false;
      const output = part.output;
      if (output.type === "text") {
        content = output.value;
      } else if (output.type === "json") {
        content = JSON.stringify(output.value);
      } else if (output.type === "error-text") {
        content = output.value;
        isError = true;
      } else if (output.type === "error-json") {
        content = JSON.stringify(output.value);
        isError = true;
      } else if (output.type === "content") {
        content = output.value
          .filter((v): v is { text: string; type: "text" } => v.type === "text")
          .map((v) => v.text)
          .join("\n");
      }
      nodes.push({
        id: id++,
        type: ChatRequestNodeType.TOOL_RESULT,
        tool_result_node: { content, is_error: isError, tool_use_id: part.toolCallId },
      });
    }
  }
  return nodes;
}

function assistantMessageToResponseNodes(
  msg: LanguageModelV3CallOptions["prompt"][number] & { role: "assistant" }
) {
  const nodes: {
    content?: string;
    id: number;
    thinking?: { content?: string };
    tool_use?: { input_json: string; tool_name: string; tool_use_id: string };
    type: ChatResultNodeType;
  }[] = [];
  let text = "";
  let id = 0;
  for (const part of msg.content) {
    if (part.type === "text") {
      text += part.text;
      nodes.push({ id: id++, type: ChatResultNodeType.RAW_RESPONSE, content: part.text });
    } else if (part.type === "tool-call") {
      nodes.push({
        id: id++,
        type: ChatResultNodeType.TOOL_USE,
        tool_use: {
          input_json: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
          tool_name: part.toolName,
          tool_use_id: part.toolCallId,
        },
      });
    } else if (part.type === "reasoning") {
      nodes.push({
        id: id++,
        type: ChatResultNodeType.THINKING,
        thinking: { content: part.text },
      });
    }
  }
  return { nodes, text };
}

function buildChatRequest(
  prompt: LanguageModelV3CallOptions["prompt"],
  tools: LanguageModelV3CallOptions["tools"]
) {
  const chatHistory: {
    request_message: string;
    request_nodes: ReturnType<typeof userMessageToNodes>["nodes"];
    response_nodes: ReturnType<typeof assistantMessageToResponseNodes>["nodes"];
    response_text: string;
  }[] = [];
  let pendingRequestNodes: ReturnType<typeof userMessageToNodes>["nodes"] = [];
  let pendingRequestText = "";
  let nodeId = 0;

  for (const msg of prompt) {
    if (msg.role === "system") {
      const systemText = extractText(msg.content);
      if (systemText) {
        pendingRequestNodes.push({
          id: nodeId++,
          type: ChatRequestNodeType.TEXT,
          text_node: { content: `System: ${systemText}` },
        });
        pendingRequestText += `System: ${systemText}\n\n`;
      }
    } else if (msg.role === "user") {
      const { nodes, text } = userMessageToNodes(msg, nodeId);
      pendingRequestNodes.push(...nodes);
      nodeId += nodes.length;
      if (pendingRequestText && text) {
        pendingRequestText += `\n${text}`;
      } else {
        pendingRequestText += text;
      }
    } else if (msg.role === "tool") {
      const nodes = toolMessageToNodes(msg, nodeId);
      pendingRequestNodes.push(...nodes);
      nodeId += nodes.length;
    } else if (msg.role === "assistant") {
      const { nodes: responseNodes, text: responseText } = assistantMessageToResponseNodes(msg);
      chatHistory.push({
        request_message: pendingRequestText,
        request_nodes: pendingRequestNodes,
        response_nodes: responseNodes,
        response_text: responseText,
      });
      pendingRequestNodes = [];
      pendingRequestText = "";
      nodeId = 0;
    }
  }

  pendingRequestNodes.forEach((node, i) => {
    node.id = i;
  });

  return {
    chatHistory,
    message: pendingRequestText,
    nodes: pendingRequestNodes,
    toolDefinitions: toolsToDefinitions(tools),
  };
}

function stopReasonToFinishReason(stopReason: ChatStopReason | undefined): {
  unified: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
  raw: string | undefined;
} {
  switch (stopReason) {
    case ChatStopReason.END_TURN:
      return { unified: "stop", raw: "end_turn" };
    case ChatStopReason.MAX_TOKENS:
      return { unified: "length", raw: "max_tokens" };
    case ChatStopReason.TOOL_USE_REQUESTED:
      return { unified: "tool-calls", raw: "tool_use" };
    case ChatStopReason.SAFETY:
      return { unified: "content-filter", raw: "safety" };
    case ChatStopReason.RECITATION:
      return { unified: "content-filter", raw: "recitation" };
    case ChatStopReason.MALFORMED_FUNCTION_CALL:
      return { unified: "error", raw: "malformed_function_call" };
    default:
      return { unified: "other", raw: undefined };
  }
}

function responseNodeToContent(node: {
  thinking?: { content?: string; summary?: string };
  tool_use?: { input_json: string; tool_name: string; tool_use_id: string };
  type: ChatResultNodeType;
}) {
  if (node.type === ChatResultNodeType.TOOL_USE && node.tool_use) {
    return {
      input: node.tool_use.input_json || "{}",
      toolCallId: node.tool_use.tool_use_id,
      toolName: node.tool_use.tool_name,
      type: "tool-call" as const,
    };
  }
  if (node.type === ChatResultNodeType.THINKING && node.thinking) {
    const text = node.thinking.content || node.thinking.summary || "";
    if (text) {
      return { text, type: "reasoning" as const };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AugmentLanguageModel
// ---------------------------------------------------------------------------

/**
 * A `LanguageModelV3` implementation that calls the Augment `/chat-stream` API
 * directly.
 */
export class AugmentLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "augment";
  readonly modelId: string;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly sessionId: string;
  private readonly debug: boolean;
  private readonly log: Logger;

  constructor(modelId: string, config: AugmentLanguageModelConfig, log: Logger) {
    this.modelId = modelId;
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.endsWith("/") ? config.apiUrl.slice(0, -1) : config.apiUrl;
    this.sessionId = crypto.randomUUID();
    this.debug = config.debug ?? false;
    this.log = log;
  }

  private getHeaders(requestId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Mode": "sdk",
      "X-Request-Id": requestId,
      "X-Request-Session-Id": this.sessionId,
      "conversation-id": this.sessionId,
    };
  }

  private buildPayload(options: LanguageModelV3CallOptions) {
    const { message, nodes, chatHistory, toolDefinitions } = buildChatRequest(
      options.prompt,
      options.tools
    );
    return {
      chat_history: chatHistory,
      conversation_id: this.sessionId,
      message,
      mode: "CLI_AGENT",
      model: this.modelId,
      nodes,
      tool_definitions: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    };
  }

  doGenerate(options: LanguageModelV3CallOptions): ReturnType<LanguageModelV3["doGenerate"]> {
    const run = async () => {
      const requestId = crypto.randomUUID();
      const url = `${this.apiUrl}/chat-stream`;
      const payload = this.buildPayload(options);

      trace("doGenerate.request", {
        modelId: this.modelId,
        promptLength: options.prompt.length,
        promptSummary: summarisePrompt(options.prompt),
      });

      if (this.debug && payload.tool_definitions) {
        this.log.debug(`Tools: ${payload.tool_definitions.map((t) => t.name).join(", ")}`);
      }

      const response = await fetch(url, {
        body: JSON.stringify(payload),
        headers: this.getHeaders(requestId),
        method: "POST",
        signal: options.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Augment API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const { content, finishReason, usage } = await this.parseStreamResponse(
        response.body,
        options.prompt
      );

      trace("doGenerate.response", {
        contentTypes: content.map((c) => c.type),
        finishReason,
        modelId: this.modelId,
        usage,
      });

      return { content, finishReason, usage, warnings: [] };
    };
    return run();
  }

  private async parseStreamResponse(
    body: ReadableStream<Uint8Array>,
    prompt: LanguageModelV3CallOptions["prompt"]
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let textBuffer = "";
    let accumulatedText = "";
    const content: Array<
      | { text: string; type: "text" }
      | { input: string; toolCallId: string; toolName: string; type: "tool-call" }
      | { text: string; type: "reasoning" }
    > = [];
    const estimatedInputTokens = estimateInputTokens(prompt);
    let usage: LanguageModelV3Usage = {
      inputTokens: {
        total: estimatedInputTokens,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    let stopReason: ChatStopReason | undefined;
    const toolCallsEmitted = new Set<string>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        while (textBuffer.includes("\n")) {
          const newLineIndex = textBuffer.indexOf("\n");
          const line = textBuffer.substring(0, newLineIndex);
          textBuffer = textBuffer.substring(newLineIndex + 1);
          const trimmed = line.trim();
          if (trimmed) {
            try {
              const chunk = JSON.parse(trimmed);
              if (chunk.text) {
                accumulatedText += chunk.text;
              }
              if (chunk.nodes) {
                for (const node of chunk.nodes) {
                  if (node.type === ChatResultNodeType.TOOL_USE && node.tool_use) {
                    if (!toolCallsEmitted.has(node.tool_use.tool_use_id)) {
                      toolCallsEmitted.add(node.tool_use.tool_use_id);
                      const toolContent = responseNodeToContent(node);
                      if (toolContent) {
                        content.push(toolContent);
                      }
                    }
                  } else if (node.type === ChatResultNodeType.THINKING) {
                    const thinkingContent = responseNodeToContent(node);
                    if (thinkingContent) {
                      content.push(thinkingContent);
                    }
                  } else if (node.type === ChatResultNodeType.TOKEN_USAGE && node.token_usage) {
                    trace("TOKEN_USAGE.raw_node", { node });
                    // Use estimated input tokens (API reports unreliable delta counts).
                    // Use API-reported output tokens which are accurate.
                    const outputTotal = node.token_usage.output_tokens as number | undefined;
                    usage = {
                      inputTokens: {
                        total: estimatedInputTokens,
                        noCache: undefined,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: outputTotal, text: undefined, reasoning: undefined },
                    };
                  } else if (node.type === ChatResultNodeType.BILLING_METADATA) {
                    trace("BILLING_METADATA.raw_node", { node });
                  }
                }
              }
              if (chunk.stop_reason !== undefined) {
                stopReason = chunk.stop_reason;
              }
            } catch {
              if (this.debug) this.log.debug(`JSON parse failed for line: ${trimmed}`);
            }
          }
        }
      }

      const finalChunk = decoder.decode();
      if (finalChunk) textBuffer += finalChunk;
      if (textBuffer.trim()) {
        try {
          const chunk = JSON.parse(textBuffer.trim());
          if (chunk.text) accumulatedText += chunk.text;
          if (chunk.stop_reason !== undefined) stopReason = chunk.stop_reason;
        } catch {
          if (this.debug) this.log.debug(`JSON parse failed for remaining: ${textBuffer.trim()}`);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (accumulatedText) {
      content.unshift({ text: accumulatedText, type: "text" as const });
    }

    return {
      content: content.filter((c): c is NonNullable<typeof c> => c !== null),
      finishReason: stopReasonToFinishReason(stopReason),
      usage,
    };
  }

  doStream(options: LanguageModelV3CallOptions): PromiseLike<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
  }> {
    const requestId = crypto.randomUUID();
    const url = `${this.apiUrl}/chat-stream`;
    const payload = this.buildPayload(options);

    trace("doStream.request", {
      modelId: this.modelId,
      promptLength: options.prompt.length,
      promptSummary: summarisePrompt(options.prompt),
    });

    const debug = this.debug;
    const log = this.log;
    const modelId = this.modelId;
    const estimatedInputTokens = estimateInputTokens(options.prompt);

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        try {
          const response = await fetch(url, {
            body: JSON.stringify(payload),
            headers: this.getHeaders(requestId),
            method: "POST",
            signal: options.abortSignal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Augment API error: ${response.status} ${response.statusText} - ${errorText}`
            );
          }

          if (!response.body) {
            throw new Error("Response body is null");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let textBuffer = "";
          let textStarted = false;
          const textId = crypto.randomUUID();
          let stopReason: ChatStopReason | undefined;
          const toolCallsEmitted = new Set<string>();
          let usage: LanguageModelV3Usage = {
            inputTokens: {
              total: estimatedInputTokens,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            textBuffer += decoder.decode(value, { stream: true });

            while (textBuffer.includes("\n")) {
              const newLineIndex = textBuffer.indexOf("\n");
              const line = textBuffer.substring(0, newLineIndex);
              textBuffer = textBuffer.substring(newLineIndex + 1);
              const trimmed = line.trim();
              if (trimmed) {
                try {
                  const chunk = JSON.parse(trimmed);

                  if (chunk.text) {
                    if (!textStarted) {
                      controller.enqueue({ id: textId, type: "text-start" });
                      textStarted = true;
                    }
                    controller.enqueue({ delta: chunk.text, id: textId, type: "text-delta" });
                  }

                  if (chunk.nodes) {
                    for (const node of chunk.nodes) {
                      if (node.type === ChatResultNodeType.TOOL_USE && node.tool_use) {
                        if (!toolCallsEmitted.has(node.tool_use.tool_use_id)) {
                          toolCallsEmitted.add(node.tool_use.tool_use_id);
                          const inputJson = node.tool_use.input_json || "{}";
                          controller.enqueue({
                            id: node.tool_use.tool_use_id,
                            toolName: node.tool_use.tool_name,
                            type: "tool-input-start",
                          });
                          controller.enqueue({
                            delta: inputJson,
                            id: node.tool_use.tool_use_id,
                            type: "tool-input-delta",
                          });
                          controller.enqueue({
                            id: node.tool_use.tool_use_id,
                            type: "tool-input-end",
                          });
                          controller.enqueue({
                            input: inputJson,
                            toolCallId: node.tool_use.tool_use_id,
                            toolName: node.tool_use.tool_name,
                            type: "tool-call",
                          });
                        }
                      } else if (node.type === ChatResultNodeType.THINKING && node.thinking) {
                        const text = node.thinking.content || node.thinking.summary || "";
                        if (text) {
                          const reasoningId = crypto.randomUUID();
                          controller.enqueue({ id: reasoningId, type: "reasoning-start" });
                          controller.enqueue({
                            delta: text,
                            id: reasoningId,
                            type: "reasoning-delta",
                          });
                          controller.enqueue({ id: reasoningId, type: "reasoning-end" });
                        }
                      } else if (node.type === ChatResultNodeType.TOKEN_USAGE && node.token_usage) {
                        trace("TOKEN_USAGE.raw_node", { node });
                        // Use estimated input tokens (API reports unreliable delta counts).
                        // Use API-reported output tokens which are accurate.
                        const outputTotal = node.token_usage.output_tokens as number | undefined;
                        usage = {
                          inputTokens: {
                            total: estimatedInputTokens,
                            noCache: undefined,
                            cacheRead: undefined,
                            cacheWrite: undefined,
                          },
                          outputTokens: {
                            total: outputTotal,
                            text: undefined,
                            reasoning: undefined,
                          },
                        };
                      } else if (node.type === ChatResultNodeType.BILLING_METADATA) {
                        trace("BILLING_METADATA.raw_node", { node });
                      }
                    }
                  }

                  if (chunk.stop_reason !== undefined) {
                    stopReason = chunk.stop_reason;
                  }
                } catch {
                  if (debug) log.debug(`JSON parse failed: ${trimmed}`);
                }
              }
            }
          }

          if (textStarted) {
            controller.enqueue({ id: textId, type: "text-end" });
          }

          controller.enqueue({
            finishReason: stopReasonToFinishReason(stopReason),
            type: "finish",
            usage,
          });

          trace("doStream.finish", {
            finishReason: stopReasonToFinishReason(stopReason),
            modelId,
            usage,
          });

          controller.close();
        } catch (error) {
          trace("doStream.error", {
            error:
              error instanceof Error
                ? { message: error.message, stack: error.stack }
                : String(error),
            modelId,
          });
          controller.enqueue({ error, type: "error" });
          controller.error(error);
        }
      },
    });

    return Promise.resolve({ stream });
  }
}
