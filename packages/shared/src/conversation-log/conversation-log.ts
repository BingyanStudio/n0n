/**
 * 对话日志的序列化与反序列化
 *
 * 提供 saveConversation / loadConversation 两个核心函数，
 * 负责 DomainMessage[] 与 JSON 文件之间的转换。
 *
 * 文件名格式：n0n-conversation-{timestamp}.json
 * 其中 timestamp 为紧凑格式（如 20250320-181500）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DomainMessage } from "@n0n/types";
import type { ConversationLog } from "./types.ts";

/**
 * 生成紧凑时间戳字符串，用于文件名
 * 格式：20250320-181500
 */
function compactTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		"-",
		pad(now.getHours()),
		pad(now.getMinutes()),
		pad(now.getSeconds()),
	].join("");
}

/**
 * 生成对话日志的默认文件名
 */
export function generateLogFileName(): string {
	return `n0n-conversation-${compactTimestamp()}.json`;
}

/**
 * 保存对话历史到 JSON 文件
 *
 * @param history 完整的 DomainMessage 历史
 * @param workspace 当前工作区路径
 * @param outputDir 输出目录（通常为工作区根目录）
 * @param fileName 可选的文件名，默认自动生成带时间戳的文件名
 * @returns 写入的文件绝对路径
 */
export function saveConversation(
	history: DomainMessage[],
	workspace: string,
	outputDir: string,
	fileName?: string,
): string {
	const log: ConversationLog = {
		version: 1,
		humanReadable: {
			savedAt: new Date().toISOString(),
			workspace,
			messageCount: history.length,
		},
		history,
	};

	const name = fileName ?? generateLogFileName();
	const filePath = resolve(outputDir, name);
	writeFileSync(filePath, JSON.stringify(log, null, 2), "utf-8");
	return filePath;
}

/**
 * 从 JSON 文件加载对话历史
 *
 * @param filePath 对话日志文件路径
 * @returns 解析后的对话日志（含元数据和历史）
 * @throws 文件不存在、JSON 格式错误或版本不兼容时抛出异常
 */
export function loadConversation(filePath: string): ConversationLog {
	const absPath = resolve(filePath);
	const raw = readFileSync(absPath, "utf-8");
	const parsed = JSON.parse(raw);

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Invalid conversation log: not a JSON object`);
	}

	if (parsed.version !== 1) {
		throw new Error(
			`Unsupported conversation log version: ${parsed.version} (expected 1)`,
		);
	}

	if (!Array.isArray(parsed.history)) {
		throw new Error(`Invalid conversation log: missing history array`);
	}

	return parsed as ConversationLog;
}
