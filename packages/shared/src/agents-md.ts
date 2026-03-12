/**
 * AGENTS.md 加载 — 从 workspace 根目录读取项目级 agent 指令
 *
 * 如果 workspace 根目录存在 AGENTS.md，其内容将被注入到 system prompt 中，
 * 为 agent 提供项目级的行为约束和上下文。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 从指定 workspace 目录加载 AGENTS.md 内容。
 * 不存在时返回 null。
 */
export async function loadAgentsMd(workspace: string): Promise<string | null> {
	const filePath = resolve(workspace, "AGENTS.md");
	if (!existsSync(filePath)) return null;
	try {
		const content = await Bun.file(filePath).text();
		return content.trim() || null;
	} catch {
		return null;
	}
}

/**
 * 将 AGENTS.md 内容格式化为 system prompt 片段。
 */
export function formatAgentsMdPrompt(content: string): string {
	return ["## Project Instructions (from AGENTS.md)", "", content].join("\n");
}
