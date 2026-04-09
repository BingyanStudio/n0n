/**
 * Anthropic Prompt Caching — 断点选择工具（已弃用）
 *
 * 手动断点选择已被 Anthropic 自动缓存替代。
 * 保留供外部引用兼容。
 */

// COMMENT: 这个文件是 prompt caching 演进的活化石。从手动选择断点到自动缓存，
// 说明 Anthropic API 在快速迭代中不断降低使用者的心智负担。
// 保留 @deprecated 代码是合理的——它记录了"为什么不再需要手动断点"这个设计决策。
// 但如果确认不再有外部引用，可以彻底移除并在 CHANGELOG 中记录。
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
