/**
 * 用户信息持久化 — 写入 memory/user-info.json
 *
 * 首次对话时通过飞书 API 获取用户详情并写入文件，
 * 后续 agent 可通过 import 该 JSON 使用用户数据。
 * 按 TTL 刷新，避免每次对话都调 API。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FeishuBot, FeishuUserInfo } from "./bot.ts";

const REFRESH_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * 确保用户信息文件存在且不过期。
 * 返回用户信息（用于注入 system prompt），或 null（API 失败时）。
 */
export async function ensureUserInfo(
	bot: FeishuBot,
	openId: string,
	memoryDir: string,
): Promise<FeishuUserInfo | null> {
	const filePath = resolve(memoryDir, "user-info.json");

	// 检查是否已有且未过期
	if (existsSync(filePath)) {
		try {
			const existing: unknown = JSON.parse(
				await Bun.file(filePath).text(),
			);
			if (!existing || typeof existing !== "object" || !("openId" in existing) || !("updatedAt" in existing)) throw new Error("invalid");
			const info = existing as FeishuUserInfo;
			const age = Date.now() - new Date(info.updatedAt).getTime();
			if (age < REFRESH_TTL_MS) return info;
		} catch {
			// 文件损坏，重新获取
		}
	}

	// 调用飞书 API 获取用户信息
	const info = await bot.getUserInfo(openId);
	if (!info) return null;

	// 写入文件
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	await Bun.write(filePath, JSON.stringify(info, null, 2));

	console.log(`[feishu] user info saved: ${openId} → ${filePath}`);
	return info;
}
