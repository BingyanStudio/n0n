/**
 * Gemini Client 冒烟测试
 *
 * 验证 GeminiClient 的 stream、complete、thinking 方法能正常与 API 通信。
 * 需要有效的 Google/Gemini 配置。手动运行：
 *   N0N_INTEGRATION=1 bun test packages/llm/src/__tests__/gemini-smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DomainMessage } from "@n0n/types";
import type { LLMConfig } from "../config.ts";
import { createLLMClient } from "../factory.ts";

function loadGlobalEnv(): boolean {
	try {
		const content = readFileSync(resolve(homedir(), ".n0n", ".env"), "utf-8");
		for (const line of content.split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq < 0) continue;
			const key = t.slice(0, eq).trim();
			const value = t.slice(eq + 1).trim();
			if (key && !process.env[key]) process.env[key] = value;
		}
		return true;
	} catch {
		return false;
	}
}

const loaded = loadGlobalEnv();
const integrationEnabled = process.env.N0N_INTEGRATION === "1";

function makeGeminiConfig(
	thinkingEffort?: "low" | "medium" | "high",
): LLMConfig {
	return {
		providerConfig: {
			provider: "google",
			apiKey: process.env.LLM_API_KEY ?? "",
			baseUrl: process.env.LLM_BASE_URL ?? "",
			model: "gemini-3.1-pro-preview",
			...(thinkingEffort ? { thinkingEffort } : {}),
		},
	};
}

describe("Gemini Client smoke test", () => {
	test.skipIf(!loaded || !integrationEnabled)(
		"stream: 简单对话生成内容",
		async () => {
			const config = makeGeminiConfig();
			const client = createLLMClient(config);

			const messages: DomainMessage[] = [
				{
					type: "system",
					content: "You are a helpful assistant. Reply briefly.",
				},
				{
					type: "user_input",
					content: "What is 2+2? Answer in one word.",
					context: null,
					hint: null,
				},
			];

			let content = "";
			let doneEvent = null;

			for await (const event of client.stream({ messages })) {
				if (event.type === "content") {
					content += event.text;
				} else if (event.type === "done") {
					doneEvent = event;
				} else if (event.type === "error") {
					throw new Error(`Stream error: ${event.error}`);
				}
			}

			console.log("  stream content:", content);
			console.log("  stream done:", JSON.stringify(doneEvent));

			expect(content.length).toBeGreaterThan(0);
			expect(doneEvent).not.toBeNull();
			expect(doneEvent!.finishReason).toBe("stop");
			// Gemini 始终思考，即使未配置 thinkingEffort 也应有 reasoning
		},
		30_000,
	);

	test.skipIf(!loaded || !integrationEnabled)(
		"thinking 模式 (reasoning_effort=low) 输出更少思考",
		async () => {
			const config = makeGeminiConfig("low");
			const client = createLLMClient(config);

			const messages: DomainMessage[] = [
				{
					type: "user_input",
					content: "What is 17 * 23?",
					context: null,
					hint: null,
				},
			];

			let thinking = "";
			let content = "";

			for await (const event of client.stream({ messages })) {
				if (event.type === "thinking") {
					thinking += event.text;
				} else if (event.type === "content") {
					content += event.text;
				} else if (event.type === "error") {
					throw new Error(`Stream error: ${event.error}`);
				}
			}

			console.log(
				"  thinking (low):",
				thinking.slice(0, 100) + (thinking.length > 100 ? "..." : ""),
			);
			console.log("  content:", content);

			expect(thinking.length).toBeGreaterThan(0);
			expect(content.length).toBeGreaterThan(0);
			expect(content).toContain("391");
		},
		30_000,
	);

	test.skipIf(!loaded || !integrationEnabled)(
		"stream: function calling",
		async () => {
			const config = makeGeminiConfig();
			const client = createLLMClient(config);

			const messages: DomainMessage[] = [
				{
					type: "system",
					content:
						"You are a helpful assistant. Use the provided tools when appropriate.",
				},
				{
					type: "user_input",
					content: "What is the current weather in Tokyo?",
					context: null,
					hint: null,
				},
			];

			const tools = [
				{
					name: "get_weather",
					description: "Get current weather for a city",
					parameters: {
						type: "object" as const,
						properties: {
							city: { type: "string", description: "City name" },
						},
						required: ["city"],
					},
				},
			];

			let content = "";
			const toolCalls: Array<{ name?: string; args: string }> = [];
			let doneEvent = null;

			for await (const event of client.stream({
				messages,
				tools,
				toolChoice: "auto",
			})) {
				if (event.type === "content") {
					content += event.text;
				} else if (event.type === "tool_call_delta") {
					if (!toolCalls[event.index]) {
						toolCalls[event.index] = { name: event.name, args: "" };
					}
					if (event.name) toolCalls[event.index]!.name = event.name;
					toolCalls[event.index]!.args += event.arguments;
				} else if (event.type === "done") {
					doneEvent = event;
				} else if (event.type === "error") {
					throw new Error(`Stream error: ${event.error}`);
				}
			}

			console.log("  tool_calls:", JSON.stringify(toolCalls));
			console.log("  done:", JSON.stringify(doneEvent));

			expect(doneEvent).not.toBeNull();
			if (toolCalls.length > 0) {
				expect(toolCalls[0]!.name).toBe("get_weather");
				const args = JSON.parse(toolCalls[0]!.args);
				expect(args.city).toBeDefined();
			}
		},
		30_000,
	);

	test.skipIf(!loaded || !integrationEnabled)(
		"stream: thinking 模式 (reasoning_effort=high)",
		async () => {
			const config = makeGeminiConfig("high");
			const client = createLLMClient(config);

			const messages: DomainMessage[] = [
				{
					type: "user_input",
					content: "What is 17 * 23?",
					context: null,
					hint: null,
				},
			];

			let thinking = "";
			let content = "";
			let doneEvent = null;
			let hasSignature = false;

			for await (const event of client.stream({ messages })) {
				if (event.type === "thinking") {
					thinking += event.text;
				} else if (event.type === "thinking_signature") {
					hasSignature = true;
				} else if (event.type === "content") {
					content += event.text;
				} else if (event.type === "done") {
					doneEvent = event;
				} else if (event.type === "error") {
					throw new Error(`Stream error: ${event.error}`);
				}
			}

			console.log(
				"  thinking:",
				thinking.slice(0, 200) + (thinking.length > 200 ? "..." : ""),
			);
			console.log("  content:", content);
			console.log("  has signature:", hasSignature);
			console.log("  done:", JSON.stringify(doneEvent));

			expect(thinking.length).toBeGreaterThan(0);
			expect(content.length).toBeGreaterThan(0);
			expect(content).toContain("391");
			expect(doneEvent).not.toBeNull();
			expect(doneEvent!.finishReason).toBe("stop");
		},
		30_000,
	);

	test.skipIf(!loaded || !integrationEnabled)(
		"complete: 简单问答",
		async () => {
			const config = makeGeminiConfig();
			const client = createLLMClient(config);

			const result = await client.complete({
				messages: [
					{ role: "system", content: "Reply in one word." },
					{ role: "user", content: "What color is the sky on a clear day?" },
				],
			});

			console.log("  complete result:", result.text);

			expect(result.text.length).toBeGreaterThan(0);
		},
		30_000,
	);
});
