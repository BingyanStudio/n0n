/**
 * LLM 有时会将本该是 array/object 的字段序列化为 JSON 字符串
 * （如 options: "[{...}]" 而非 options: [{...}]）。
 * 递归遍历值，尝试将形如 JSON array/object 的字符串解析为实际结构。
 */
export function deepParseJsonStrings(value: unknown): unknown {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (
			(trimmed.startsWith("[") && trimmed.endsWith("]")) ||
			(trimmed.startsWith("{") && trimmed.endsWith("}"))
		) {
			try {
				return deepParseJsonStrings(JSON.parse(trimmed));
			} catch {
				return value;
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(deepParseJsonStrings);
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = deepParseJsonStrings(v);
		}
		return result;
	}
	return value;
}
