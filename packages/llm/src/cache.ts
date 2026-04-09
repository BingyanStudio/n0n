/**
 * Anthropic Prompt Caching — 断点选择工具（已弃用）
 *
 * 手动断点选择已被 Anthropic 自动缓存替代。
 * 保留供外部引用兼容。
 */

// TODO: 确认无外部引用后彻底移除此 deprecated 代码。
/** @deprecated 已被 Anthropic 自动缓存替代，不再被 client 调用。 */
export function selectCacheBreakpoints(
	messages: readonly { role: string }[],
	isRealUser?: (index: number) => boolean,
): number[] {
	const selected = new Set<number>();

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "system") {
			selected.add(i);
			break;
		}
	}

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

	for (let i = messages.length - 1; i >= 0 && selected.size < 4; i--) {
		if (selected.has(i)) continue;
		const role = messages[i]?.role;
		if (role === "user" || role === "tool") {
			selected.add(i);
		}
	}

	return [...selected];
}
