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
 * 2. 倒数第二个 user 消息 — **交错思考下的稳定缓存边界**
 *    （新 user 消息插入后，服务端会清空其与上一个 user 之间的 thinking content，
 *    导致 token 分布剧变。在上一个 user 处设 anchor，确保 S..prev_user 前缀仍可命中缓存）
 * 3-4. 从末尾向前补满剩余 non-assistant 消息 — 最新历史缓存
 *
 * 当只有 1 个 user 消息时（无 reminder），断点 2 不存在，
 * 退化为 system + 最后 3 条 non-assistant（与旧策略等价）。
 */
export function selectCacheBreakpoints(
	messages: readonly { role: string }[],
): number[] {
	const selected = new Set<number>();

	// 断点 1：最后一条 system 消息
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "system") {
			selected.add(i);
			break;
		}
	}

	// 断点 2：倒数第二个 user 消息（thinking 清空后的稳定缓存边界）
	let userCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			userCount++;
			if (userCount === 2) {
				selected.add(i);
				break;
			}
		}
	}

	// 断点 3-4（补满到 4 个）：从末尾向前取 non-assistant 消息，跳过已选中的
	for (let i = messages.length - 1; i >= 0 && selected.size < 4; i--) {
		if (selected.has(i)) continue;
		const role = messages[i]?.role;
		if (role === "user" || role === "tool") {
			selected.add(i);
		}
	}

	return [...selected];
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
