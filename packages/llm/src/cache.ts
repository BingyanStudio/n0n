/**
 * Anthropic Prompt Caching — 断点选择工具
 *
 * SSOT：缓存断点的选择逻辑集中在此文件。
 * anthropic-client.ts（原生 Anthropic）和 openai-client.ts（litellm 代理）
 * 共用断点选择算法，各自负责 cache_control 注入方式。
 */

/**
 * 选择 Anthropic prompt caching 断点位置 — SSOT 纯函数。
 *
 * 返回应设置 cache_control 的消息索引列表。
 *
 * Anthropic 最多支持 4 个缓存断点（ephemeral），激进策略全部用满：
 * 1. 最后一条 system 消息 — 缓存稳定的 system prompt
 * 2. 倒数第二个 **真实 user** 消息 — 稳定缓存锚点
 *    在 Anthropic 格式中 tool_result 也是 role=user，但它们每轮都在增长，
 *    不适合做锚点。真正的 user_input 消息才是稳定的对话边界。
 *    使用 isRealUser 回调来区分；未提供时退化为按 role=user 匹配（向后兼容）。
 * 3-4. 从末尾向前补满剩余 non-assistant 消息 — 最新历史缓存
 *
 * 当只有 1 个真实 user 消息时（无 reminder），断点 2 不存在，
 * 退化为 system + 最后 3 条 non-assistant（与旧策略等价）。
 */
export function selectCacheBreakpoints(
	messages: readonly { role: string }[],
	isRealUser?: (index: number) => boolean,
): number[] {
	const selected = new Set<number>();

	// 断点 1：最后一条 system 消息
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "system") {
			selected.add(i);
			break;
		}
	}

	// 断点 2：倒数第二个真实 user 消息（稳定缓存锚点）
	// isRealUser 区分 user_input（稳定）和 tool_result→user（每轮增长）
	const checkUser = isRealUser ?? ((i: number) => messages[i]?.role === "user");
	let realUserCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (checkUser(i)) {
			realUserCount++;
			if (realUserCount === 2) {
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
