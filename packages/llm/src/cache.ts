/**
 * Anthropic Prompt Caching — 断点选择与标记工具
 *
 * SSOT：缓存断点的选择逻辑集中在此文件，
 * adapter.ts（原生 Anthropic）和 provider.ts（litellm 代理）
 * 各自负责标记方式（providerOptions vs cache_control），共用断点选择。
 */

/**
 * 选择 Anthropic prompt caching 断点位置 — SSOT 纯函数。
 *
 * 返回应设置 cache_control 的消息索引列表。
 *
 * Anthropic 最多支持 4 个缓存断点（ephemeral），激进策略全部用满：
 * 1. 最后一条 system 消息 — 缓存稳定的 system prompt
 * 2. 倒数第三条 non-assistant 消息 — 较早历史兜底
 * 3. 倒数第二条 non-assistant 消息 — 中段历史缓存
 * 4. 最后一条 non-assistant 消息 — 最新历史缓存
 *
 * 激进策略：不跳过最后一条 non-assistant 消息，下一轮调用时它已是历史的一部分，
 * 提前标记可以让缓存在下一轮立即命中。
 */
export function selectCacheBreakpoints(
	messages: readonly { role: string }[],
): number[] {
	const breakpoints: number[] = [];

	// 断点 1：最后一条 system 消息
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "system") {
			breakpoints.push(i);
			break;
		}
	}

	// 断点 2-4：最后三条 non-assistant 消息
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "user" || role === "tool") {
			breakpoints.push(i);
			count++;
			if (count >= 3) break;
		}
	}

	return breakpoints;
}

/**
 * 为原生 Anthropic provider 创建 providerOptions（prompt caching）
 *
 * 用于 AI SDK @ai-sdk/anthropic 的 cacheControl 注入。
 * litellm 路径使用 cache_control 字段，不经过此函数。
 */
export function anthropicCacheControl(): {
	anthropic: { cacheControl: { type: "ephemeral" } };
} {
	return { anthropic: { cacheControl: { type: "ephemeral" } } };
}
