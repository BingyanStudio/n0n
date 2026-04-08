/**
 * 确定性随机选择器 — 用于 anti-few-shot 变体选择
 *
 * 基于固定种子 + 消息 index 生成确定性伪随机数，
 * 从变体数组中选取一个。只要种子和 index 不变，选择结果稳定，
 * 保证 prompt cache 安全：历史消息的格式化结果不会因后续消息变化而改变。
 */

const BASE_SEED = 42;

/**
 * 简单整数 hash（xorshift 变体），将 seed+index 映射到均匀分布的整数。
 * 不需要密码学强度，只需要分布均匀、结果稳定。
 */
function hash(seed: number, index: number): number {
	let h = seed ^ (index * 2654435761); // Knuth multiplicative hash
	h = ((h >>> 16) ^ h) * 0x45d9f3b;
	h = ((h >>> 16) ^ h) * 0x45d9f3b;
	h = (h >>> 16) ^ h;
	return h >>> 0; // ensure unsigned
}

/**
 * 从变体数组中确定性地选取一个元素。
 *
 * @param variants 变体数组（至少1个元素）
 * @param msgIndex 消息在序列中的位置（0-based）
 * @returns 选中的变体
 */
export function pick<T>(variants: T[], msgIndex: number): T {
	const h = hash(BASE_SEED, msgIndex);
	return variants[h % variants.length]!;
}
