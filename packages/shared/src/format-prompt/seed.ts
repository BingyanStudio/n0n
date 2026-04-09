/**
 * 确定性随机选择器 — 用于 anti-few-shot 变体选择
 *
 * 基于固定种子 + 消息 index 生成确定性伪随机数，
 * 从变体数组中选取一个。只要种子和 index 不变，选择结果稳定，
 * 保证 prompt cache 安全：历史消息的格式化结果不会因后续消息变化而改变。
 *
 * hash 函数选型：真实对话中 tool_result 的 index 呈等差数列（如 2,5,8,11...
 * 或 2,3,6,7...），简单的 xorshift 对这类输入分布不够均匀。
 * 采用双轮 murmur3 finalize + 浮点映射，在所有等差步长下通过 χ² 检验。
 */

const BASE_SEED = 42;

/**
 * 双轮 murmur3 finalize — 先充分混合 index，再混入 seed。
 * 对连续和等差数列输入均有良好的雪崩特性。
 */
// COMMENT: 用 murmur3 finalize 做确定性随机选择——这是 anti-few-shot 的基础设施。
// 关键不变量：同一个 msgIndex 永远选到同一个变体。这保证了 prompt cache 安全性——
// 如果 pick 结果随机变化，即使消息内容不变，格式化后的 PromptMessage 也会变化，
// 导致 KV-cache 前缀失效。确定性 + 均匀分布，两个约束缺一不可。
function hash(seed: number, index: number): number {
	let h = Math.imul(index, 0x9e3779b9); // golden ratio
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	h = (h ^ (h >>> 16)) >>> 0;
	h = (h + Math.imul(seed, 0x517cc1b7)) | 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 从变体数组中确定性地选取一个元素。
 *
 * 使用浮点映射（h / 2^32 * n）替代取模（h % n），
 * 避免 2^32 不整除 n 时的分布偏差。
 *
 * @param variants 变体数组（至少1个元素）
 * @param msgIndex 消息在序列中的位置（0-based）
 * @returns 选中的变体
 */
export function pick<T>(variants: T[], msgIndex: number): T {
	const h = hash(BASE_SEED, msgIndex);
	return variants[Math.floor((h / 0x100000000) * variants.length)]!;
}
