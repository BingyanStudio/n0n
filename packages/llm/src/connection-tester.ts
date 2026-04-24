/**
 * LLM 连通性测试工厂
 *
 * 生成 LLMConnectionTester 回调，供 bootstrap 流程使用。
 * 两个 app 入口（code、feishu）之前各维护一份相同的 testLLM 实现，
 * 现在统一为此工厂函数，一行调用替换 20+ 行 copy-paste。
 *
 * 放在 @n0n/llm 而非 @n0n/shared：后者不应依赖 @n0n/llm（避免循环），
 * 但调用方需要 buildLLMConfigFromEnv / createLLMClient，这两者都在本包内。
 */

import type { LLMConnectionTester } from "@n0n/shared";
import { buildLLMConfigFromEnv } from "./config-from-env.ts";
import { createLLMClient } from "./factory.ts";

/**
 * 创建 LLM 连通性测试回调。
 *
 * 流式调用 → 收到首个非 error 事件即判定连接正常，立即中断节省 token。
 * 捕获 401/403 认证错误、连接超时等常见失败并返回友好描述。
 */
export function createLLMConnectionTester(): LLMConnectionTester {
	return async () => {
		try {
			const config = buildLLMConfigFromEnv("LLM");
			const client = createLLMClient(config);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			try {
				for await (const event of client.stream(
					{ messages: [{ type: "generic_user_text", content: "hi" }] },
					controller.signal,
				)) {
					if (event.type === "error") {
						return { ok: false as const, error: event.error };
					}
					controller.abort();
					break;
				}
			} finally {
				clearTimeout(timeout);
			}
			return { ok: true as const };
		} catch (err) {
			if (err instanceof Error) {
				if (err.message.includes("401") || err.message.includes("403")) {
					return { ok: false as const, error: "认证失败，请检查 API Key" };
				}
				if (err.name === "TimeoutError" || err.message.includes("timeout")) {
					return {
						ok: false as const,
						error: "连接超时（15s），请检查网络或 API 地址",
					};
				}
				return { ok: false as const, error: err.message.slice(0, 200) };
			}
			return { ok: false as const, error: `连接失败: ${String(err)}` };
		}
	};
}
