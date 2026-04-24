/**
 * DSL 解析 — 将 ## 标题格式的文本解析为结构化列表
 *
 * @n0n/shared 中不直接依赖 CLI UI，仅返回数据结构，渲染由调用方决定。
 *
 * 输入格式：
 *   ## label
 *   多行 detail，空行分隔不同项目
 *
 *   ## label2
 *   detail2
 */

export interface DslItem {
	label: string;
	detail: string;
}

/**
 * 解析 ## 格式的 DSL 文本为结构化列表。
 * 空字符串或仅空白返回空数组。
 */
export function parseDsl(input: string): DslItem[] {
	if (!input.trim()) return [];

	const items: DslItem[] = [];
	const lines = input.split("\n");
	let currentLabel = "";
	const currentDetail: string[] = [];

	for (const raw of lines) {
		const line = raw.trim();
		const match = /^##\s+(.+)$/.exec(line);
		if (match) {
			if (currentLabel) {
				items.push({ label: currentLabel, detail: currentDetail.join(" ").trim() });
			}
			currentLabel = match[1]!;
			currentDetail.length = 0;
		} else if (line && currentLabel) {
			currentDetail.push(line);
		}
	}
	if (currentLabel) {
		items.push({ label: currentLabel, detail: currentDetail.join(" ").trim() });
	}

	return items;
}
