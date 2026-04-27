/**
 * DeepSeek Client — DeepSeek 原生 API 支持
 *
 * 走 OpenAI 兼容协议（https://api.deepseek.com），SSE 解析逻辑与 OpenAIClient 一致。
 * 区别：
 * - tagStyle 为 default，DSML 标签仅在 Client 内部按需使用
 * - 自定义 TagAdapter：对特定 tag name 可做特殊处理
 * - 默认启用 thinking 模式（thinking: { type: "enabled" }）
 * - 默认 base URL 指向 DeepSeek API
 *
 * 后续扩展点（Phase 2-4）：
 * - DSML 工具调用编码
 * - 扩展消息角色（latest_reminder、developer）
 * - Task Token 意图路由
 */

import { createTagAdapter, formatPrompt } from "@n0n/shared";
import type {
	CompleteRequest,
	CompleteResponse,
	LLMClient,
	PromptMessage,
	StreamEvent,
	StreamRequest,
	TagAdapter,
	TagStyle,
	TokenUsage,
	ToolDefinition,
} from "@n0n/types";
import type { DeepSeekProviderConfig } from "./config.ts";
import { isAbortError, LLMError } from "./errors.ts";

// ── 控制性 Tag 拦截 ──

/**
 * 控制性 tag 集合 — wrapTag 时拦截这些 tag 的内容，
 * 从消息正文中剥离，后续转为 developer / latest_reminder 消息。
 *
 * A 类（整条消息都是控制性内容）：
 *   system_warning, submit_rejected, turn_feedback, reminder
 * B 类（嵌在 user_input 中的控制性片段）：
 *   hint
 */
const DIRECTIVE_TAGS = new Set([
	"hint",
	"system_warning",
	"submit_rejected",
	"turn_feedback",
	"reminder",
	"edit_feedback",
	"diagnostic_hint",
	"output_hint",
]);

interface CollectedDirective {
	tag: string;
	content: string;
}

// 占位符：嵌入在 content 中保持位置信息，后处理时按位置提取为 developer 消息
const DIRECTIVE_PLACEHOLDER_RE = /🔮⟪DIR:(\d+)⟫🔮/g;

/**
 * 带 sideband 收集的 TagAdapter — DeepSeek 内部实现。
 *
 * wrapTag 时检查 tag name：
 * - 控制性 tag → 存入 collected，返回占位符（保持位置信息）
 * - 数据性 tag → 正常返回标准 XML 包裹内容
 *
 * 每次 stream() 调用新建一个实例。
 */
class DeepSeekCollectingAdapter implements TagAdapter {
	private readonly base: TagAdapter;
	private readonly collected: CollectedDirective[] = [];

	constructor(base: TagAdapter) {
		this.base = base;
	}

	wrapTag(name: string, content: string): string {
		if (DIRECTIVE_TAGS.has(name)) {
			const idx = this.collected.length;
			this.collected.push({ tag: name, content });
			return `🔮⟪DIR:${idx}⟫🔮`;
		}
		return this.base.wrapTag(name, content);
	}

	adaptTags(text: string): string {
		return this.base.adaptTags(text);
	}

	/** 返回收集到的全部控制性内容（不清空，供 injectDirectives 按索引引用） */
	directives(): readonly CollectedDirective[] {
		return this.collected;
	}
}

// ── OpenAI-compatible API Types (与 OpenAIClient 一致) ──

interface DeepSeekMessage {
	role: "system" | "user" | "assistant" | "tool" | "developer" | "latest_reminder";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: DeepSeekToolCall[];
	tool_call_id?: string;
	task?: string;
}

interface DeepSeekToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface DeepSeekToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface DeepSeekRequest {
	model: string;
	messages: DeepSeekMessage[];
	tools?: DeepSeekToolDef[];
	tool_choice?: "auto" | "none" | "required";
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	thinking?: { type: "enabled" | "disabled" };
}

interface SSEChunk {
	choices?: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
	};
}

function isSSEChunk(data: unknown): data is SSEChunk {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.choices) || obj.usage !== undefined;
}

// ── PromptMessage → DeepSeek Message 转换 ──

function toDeepSeekMessages(
	promptMessages: PromptMessage[],
	enableThinking: boolean,
): DeepSeekMessage[] {
	const result: DeepSeekMessage[] = [];

	for (const msg of promptMessages) {
		switch (msg.role) {
			case "system":
				result.push({ role: "system", content: msg.content });
				break;

			case "user":
				result.push({ role: "user", content: msg.content });
				break;

			case "assistant": {
				if (msg.toolCalls?.length) {
					const toolCalls: DeepSeekToolCall[] = msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.tool,
							arguments: JSON.stringify(tc.args),
						},
					}));
					result.push({
						role: "assistant",
						content: msg.content || null,
						...(enableThinking
							? { reasoning_content: msg.reasoning ?? "" }
							: {}),
						tool_calls: toolCalls,
					});
				} else {
					result.push({
						role: "assistant",
						content: msg.content || null,
						...(enableThinking
							? { reasoning_content: msg.reasoning ?? "" }
							: {}),
					});
				}
				break;
			}

			case "tool":
				result.push({
					role: "tool",
					content: msg.content,
					tool_call_id: msg.toolCallId,
				});
				break;
		}
	}

	return result;
}

function toDeepSeekTools(tools: ToolDefinition[]): DeepSeekToolDef[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

// ── 后处理：按占位符位置注入 developer / latest_reminder 消息 ──

/**
 * 扫描消息 content 中的占位符，按位置提取为 developer / latest_reminder 消息。
 *
 * - 占位符在 content 中保持了原始位置信息（与 wrapTag 调用顺序一致）
 * - 非 user 消息中的占位符（如 tool result 中的 C 类 directive）
 *   从 content 中移除，对应的 developer 消息紧跟在该消息之后
 * - user 消息中的占位符移除后如果 content 为空（A 类），用 developer 替换
 * - user 消息中的占位符移除后 content 非空（B 类），在 user 消息后追加 developer
 */
function injectDirectives(
	messages: DeepSeekMessage[],
	directives: readonly CollectedDirective[],
): DeepSeekMessage[] {
	if (directives.length === 0) return messages;

	const result: DeepSeekMessage[] = [];

	for (const msg of messages) {
		const content = msg.content ?? "";
		const found: CollectedDirective[] = [];
		const cleaned = content.replace(DIRECTIVE_PLACEHOLDER_RE, (_, idxStr) => {
			const d = directives[Number(idxStr)];
			if (d) found.push(d);
			return "";
		}).trim();

		if (found.length === 0) {
			// 无占位符，原样保留
			result.push(msg);
			continue;
		}

		// 有占位符：先 push 清理后的消息（如果非空），再追加 directive
		if (cleaned) {
			result.push({ ...msg, content: cleaned });
		}
		for (const d of found) {
			result.push({
				role: d.tag === "reminder" ? "latest_reminder" : "developer",
				content: d.content,
			});
		}
	}

	return result;
}

// ── Task Token 解析 ──

/**
 * 用户可在消息中输入 【【task_type】】 触发原生 task token。
 * 匹配后从消息内容中移除标记，在该消息上设置 task 字段。
 *
 * 支持的 task type（与 DeepSeek-V4 训练集一致）：
 * action, query, authority, domain, title, read_url
 */
const VALID_TASKS = new Set(["action", "query", "authority", "domain", "title", "read_url"]);
const TASK_PATTERN = /【【(\w+)】】/;

/**
 * 从所有 user 消息中剔除 【【task】】 标记并设置 task 字段。
 * 严格只匹配 role === "user"（用户手动输入），不匹配 developer 等系统消息。
 * 每条消息独立处理：有标记就剔除内容 + 设 task 字段，无标记则跳过。
 */
function applyTaskToken(messages: DeepSeekMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "user") continue;

		const match = (msg.content ?? "").match(TASK_PATTERN);
		if (!match) continue;

		msg.content = (msg.content ?? "").replace(TASK_PATTERN, "").trim();

		const taskType = match[1]!;
		if (VALID_TASKS.has(taskType)) {
			msg.task = taskType;
		}
	}
}

// ── DeepSeek Client ──

export class DeepSeekClient implements LLMClient {
	readonly modelId: string;
	readonly tagStyle: TagStyle = "default";
	readonly tags: TagAdapter;
	private readonly pc: DeepSeekProviderConfig;
	private readonly apiUrl: string;
	private readonly enableThinking: boolean;

	constructor(pc: DeepSeekProviderConfig) {
		this.pc = pc;
		this.modelId = this.pc.model;
		// 公共 tags 用于外部访问（如 LLMClient.tags）
		this.tags = createTagAdapter("default");
		this.enableThinking = this.pc.enableThinking ?? true;

		const base = this.pc.baseUrl ?? "https://api.deepseek.com";
		if (base.includes("/chat/completions")) {
			this.apiUrl = base;
		} else {
			const cleanBase = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
			this.apiUrl = `${cleanBase}/v1/chat/completions`;
		}
	}

	async *stream(
		request: StreamRequest,
		signal?: AbortSignal,
	): AsyncGenerator<StreamEvent> {
		// 每次 stream 新建 collecting adapter，拦截控制性 tag
		const adapter = new DeepSeekCollectingAdapter(this.tags);
		const promptMessages = formatPrompt(request.messages, adapter);
		const rawMessages = toDeepSeekMessages(promptMessages, this.enableThinking);
		const injected = injectDirectives(rawMessages, adapter.directives());

		// 解析 【【task】】 标记，直接透传 task 字段
		const apiMessages = [...injected];
		applyTaskToken(apiMessages);

		// 过滤无效消息：
		// - 空 user 消息（directive 提取后残留的空壳）
		// - 空 assistant 消息（只有 thinking 没有 content/tool_calls，回传会报错）
		const filteredMessages = apiMessages.filter((msg) => {
			if (msg.role === "user" && !(msg.content ?? "").trim()) return false;
			if (
				msg.role === "assistant" &&
				!msg.content?.trim() &&
				!msg.tool_calls?.length
			)
				return false;
			return true;
		});

		const body: DeepSeekRequest = {
			model: this.modelId,
			messages: filteredMessages,
			stream: true,
			stream_options: { include_usage: true },
		};

		if (request.tools?.length) {
			body.tools = toDeepSeekTools(request.tools);
			body.tool_choice = request.toolChoice ?? "auto";
		}

		// thinking 模式
		if (this.enableThinking) {
			body.thinking = { type: "enabled" };
		}

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.pc.apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (isAbortError(err)) return;
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
			};
			return;
		}

		if (!res.ok) {
			const text = await res.text();
			yield { type: "error", error: `DeepSeek API ${res.status}: ${text}` };
			return;
		}

		if (!res.body) {
			yield {
				type: "error",
				error: "DeepSeek streaming response has no body",
			};
			return;
		}

		let lastUsage: TokenUsage | null = null;
		let lastFinishReason: string | null = null;

		const processDataLine = function* (
			payload: string,
		): Generator<StreamEvent> {
			if (!payload || payload === "[DONE]") return;

			let chunk: unknown;
			try {
				chunk = JSON.parse(payload);
			} catch {
				return;
			}

			if (!isSSEChunk(chunk)) return;

			if (chunk.usage) {
				const u = chunk.usage;
				// 流式 usage 用 prompt_tokens_details.cached_tokens，
				// 非流式用 prompt_cache_hit_tokens —— 两种都要兼容
				const cacheReadTokens =
					u.prompt_tokens_details?.cached_tokens ??
					u.prompt_cache_hit_tokens ??
					0;
				const cacheWriteTokens = u.prompt_cache_miss_tokens ?? 0;
				const rawInput = u.prompt_tokens ?? 0;
				lastUsage = {
					inputTokens: rawInput - cacheReadTokens,
					outputTokens: u.completion_tokens ?? 0,
					totalTokens: u.total_tokens ?? 0,
					cacheReadTokens,
					cacheWriteTokens,
				};
			}

			const delta = chunk.choices?.[0]?.delta;
			if (delta) {
				if (delta.reasoning_content) {
					yield { type: "thinking", text: delta.reasoning_content };
				}
				if (delta.content) {
					yield { type: "content", text: delta.content };
				}
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						yield {
							type: "tool_call_delta",
							index: tc.index,
							id: tc.id,
							name: tc.function?.name,
							arguments: tc.function?.arguments ?? "",
						};
					}
				}
			}

			const finish = chunk.choices?.[0]?.finish_reason;
			if (finish) {
				lastFinishReason = finish;
			}
		};

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);

					for (const line of raw.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						const payload = line.slice(6);

						if (payload === "[DONE]") {
							if (lastFinishReason) {
								yield {
									type: "done",
									finishReason: lastFinishReason,
									usage: lastUsage,
								};
							}
							return;
						}

						yield* processDataLine(payload);
					}
					boundary = buffer.indexOf("\n\n");
				}
			}

			if (buffer.trim()) {
				for (const line of buffer.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6);
					if (payload === "[DONE]") break;
					yield* processDataLine(payload);
				}
			}

			if (lastFinishReason) {
				yield {
					type: "done",
					finishReason: lastFinishReason,
					usage: lastUsage,
				};
			}
		} catch (err) {
			if (!isAbortError(err)) {
				yield {
					type: "error",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		} finally {
			reader.releaseLock();
		}
	}

	async complete(request: CompleteRequest): Promise<CompleteResponse> {
		const messages: DeepSeekMessage[] = request.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));

		const body: DeepSeekRequest = {
			model: this.modelId,
			messages,
			stream: false,
		};

		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}

		const maxRetries = 3;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				await new Promise((r) => setTimeout(r, delay));
			}

			try {
				const res = await fetch(this.apiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.pc.apiKey}`,
					},
					body: JSON.stringify(body),
				});

				if (!res.ok) {
					const text = await res.text();
					if (res.status === 429 || res.status >= 500) {
						lastError = new LLMError(
							`DeepSeek API ${res.status}: ${text}`,
							res.status,
							text,
						);
						continue;
					}
					throw new LLMError(
						`DeepSeek API ${res.status}: ${text}`,
						res.status,
						text,
					);
				}

				const json = (await res.json()) as {
					choices?: Array<{
						message?: { content?: string | null };
					}>;
				};
				const text = json?.choices?.[0]?.message?.content ?? "";
				return { text };
			} catch (err) {
				if (err instanceof LLMError) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}

		throw lastError ?? new Error("DeepSeek request failed after retries");
	}

	async ping(): Promise<{ ok: boolean; error?: string }> {
		try {
			const modelsUrl = this.apiUrl.replace(
				/\/chat\/completions\/?$/,
				"/models",
			);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			const resp = await fetch(modelsUrl, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.pc.apiKey}`,
					"Content-Type": "application/json",
				},
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (resp.ok) return { ok: true as const };

			if (resp.status === 401 || resp.status === 403) {
				return { ok: false as const, error: "认证失败，请检查 API Key" };
			}
			const text = await resp.text().catch(() => "");
			return {
				ok: false as const,
				error: `API ${resp.status}: ${text.slice(0, 200)}`,
			};
		} catch (err) {
			if (err instanceof Error) {
				if (isAbortError(err) || err.name === "TimeoutError") {
					return {
						ok: false as const,
						error: "连接超时（15s），请检查网络或 API 地址",
					};
				}
				return { ok: false as const, error: err.message.slice(0, 200) };
			}
			return { ok: false as const, error: `连接失败: ${String(err)}` };
		}
	}
}
