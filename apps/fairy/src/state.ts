/**
 * State — fairy 状态管理
 *
 * 管理全局对话记录（history.json）的读写。
 * 使用 JSON 文件存储，优先可视化和可调试性。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DomainMessage } from "@n0n/types";

/** fairy 工作区路径 */
export interface FairyPaths {
	/** 工作区根目录 */
	workspace: string;
	/** 临时文件目录 */
	temp: string;
	/** 全局对话记录 */
	historyFile: string;
	/** 角色设定 */
	identityFile: string;
	/** 长期记忆 */
	memoryFile: string;
}

export function resolveFairyPaths(workspace: string): FairyPaths {
	const ws = resolve(workspace);
	return {
		workspace: ws,
		temp: resolve(ws, ".temp"),
		historyFile: resolve(ws, "history.json"),
		identityFile: resolve(ws, "identity.md"),
		memoryFile: resolve(ws, "memory.md"),
	};
}

/** 确保所有必要目录和文件存在 */
// COMMENT: 默认的 identity.md 模板是个很好的起步点，但它也暴露了 fairy 的定位模糊：
// "helpful fairy companion" 既不是一个鲜明的角色（不像梅比乌斯那样有故事和性格），
// 也不是一个功能化的助手描述。对于陪伴场景，用户希望的是一个"有个性的存在"；
// 对于工程场景，用户希望的是一个"高效的执行者"。
// 建议：提供几个预设模板（角色扮演模板、工程助手模板、日记伙伴模板），
// 让用户在首次启动时选择，而非给一个折中的默认值。
export function ensureFairyFiles(paths: FairyPaths): void {
	// 确保目录
	for (const dir of [paths.workspace, paths.temp]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	// 确保 history.json
	if (!existsSync(paths.historyFile)) {
		writeFileSync(paths.historyFile, "[]", "utf-8");
	}

	// 确保 identity.md（默认模板）
	if (!existsSync(paths.identityFile)) {
		const dir = dirname(paths.identityFile);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			paths.identityFile,
			[
				"# Identity",
				"",
				"You are a helpful fairy companion.",
				"You have your own personality and can remember past conversations.",
				"",
				"## Traits",
				"",
				"- Friendly and curious",
				"- Proactive — you don't just answer, you anticipate needs",
				"- You maintain your own goals and follow up on them",
			].join("\n"),
			"utf-8",
		);
	}

	// 确保 memory.md
	if (!existsSync(paths.memoryFile)) {
		writeFileSync(
			paths.memoryFile,
			[
				"# Memory",
				"",
				"(No memories yet. Edit this file to add long-term memories.)",
			].join("\n"),
			"utf-8",
		);
	}
}

/** 读取全局对话记录 */
export function loadHistory(paths: FairyPaths): DomainMessage[] {
	if (!existsSync(paths.historyFile)) return [];
	const raw = readFileSync(paths.historyFile, "utf-8");
	try {
		return JSON.parse(raw) as DomainMessage[];
	} catch {
		return [];
	}
}

/** 保存全局对话记录 */
export function saveHistory(paths: FairyPaths, history: DomainMessage[]): void {
	writeFileSync(paths.historyFile, JSON.stringify(history, null, 2), "utf-8");
}

/** 读取 markdown 文件内容 */
export function loadMarkdown(filePath: string): string {
	if (!existsSync(filePath)) return "";
	return readFileSync(filePath, "utf-8");
}
