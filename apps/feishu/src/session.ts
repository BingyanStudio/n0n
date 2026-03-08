/**
 * Session — 飞书会话管理
 *
 * 管理每个用户/群聊的对话状态（history、当前任务、去重）。
 */

import type { WorkspacePaths } from "@n0n/core";
import type { DomainMessage } from "@n0n/types";
import type { FeishuMessageContext, FeishuUserInfo } from "./bot.ts";

// ── 类型 ──

export interface FeishuSession {
	history: DomainMessage[];
	ctx: FeishuMessageContext;
	paths: WorkspacePaths;
	currentTask: {
		abortController: AbortController;
		startedAt: number;
	} | null;
}

// ── 会话存储 ──

const sessions = new Map<string, FeishuSession>();

export function buildSessionKey(ctx: FeishuMessageContext): string {
	return [
		ctx.chatId ?? "unknown",
		ctx.senderOpenId ?? ctx.senderUserId ?? "unknown",
	].join(":");
}

export function getOrCreateSession(
	sessionKey: string,
	ctx: FeishuMessageContext,
	systemPrompt: string,
	paths: WorkspacePaths,
	userInfo?: FeishuUserInfo | null,
): FeishuSession {
	const existing = sessions.get(sessionKey);
	if (existing) {
		existing.ctx = ctx;
		existing.paths = paths;
		return existing;
	}
	const session: FeishuSession = {
		history: createInitialHistory(systemPrompt, ctx, paths, userInfo),
		ctx,
		paths: paths,
		currentTask: null,
	};
	sessions.set(sessionKey, session);
	return session;
}

export function resetSession(
	sessionKey: string,
	ctx: FeishuMessageContext,
	systemPrompt: string,
	paths: WorkspacePaths,
	userInfo?: FeishuUserInfo | null,
): FeishuSession {
	const session: FeishuSession = {
		history: createInitialHistory(systemPrompt, ctx, paths, userInfo),
		ctx,
		paths: paths,
		currentTask: null,
	};
	sessions.set(sessionKey, session);
	return session;
}

export function deleteSession(sessionKey: string): void {
	sessions.delete(sessionKey);
}

/**
 * 根据用户 ID 查找所有关联的 session key。
 * 用于菜单事件等缺少 chatId 的场景，通过 senderOpenId 后缀匹配。
 */
export function findSessionKeysByUser(senderOpenId: string): string[] {
	const suffix = `:${senderOpenId}`;
	const keys: string[] = [];
	for (const key of sessions.keys()) {
		if (key.endsWith(suffix)) keys.push(key);
	}
	return keys;
}

/**
 * 重置指定用户的所有会话（跨 chat）。
 * 当菜单事件无 chatId 时，遍历该用户所有 session 并重置。
 */
export function resetSessionsByUser(
	senderOpenId: string,
	systemPrompt: string,
): number {
	const keys = findSessionKeysByUser(senderOpenId);
	for (const key of keys) {
		const existing = sessions.get(key);
		if (!existing) continue;
		if (existing.currentTask) {
			existing.currentTask.abortController.abort();
			existing.currentTask = null;
		}
		existing.history = [
			{ type: "system", content: systemPrompt },
			{
				type: "system",
				content: buildFeishuSystemContext(existing.ctx, existing.paths),
			},
		];
	}
	return keys.length;
}

/**
 * 中断指定用户所有会话的当前任务。
 * 当菜单事件无 chatId 时，遍历该用户所有 session 并 abort。
 */
export function abortSessionsByUser(senderOpenId: string): number {
	const keys = findSessionKeysByUser(senderOpenId);
	let aborted = 0;
	for (const key of keys) {
		const existing = sessions.get(key);
		if (!existing?.currentTask) continue;
		existing.currentTask.abortController.abort();
		existing.currentTask = null;
		aborted++;
	}
	return aborted;
}

// ── 消息去重 ──

const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX_SIZE = 10_000;

export function shouldProcessMessage(ctx: FeishuMessageContext): boolean {
	const now = Date.now();
	const key = ctx.messageId ?? "";
	if (!key) return true;
	const seenAt = processedMessages.get(key);
	if (seenAt && now - seenAt < DEDUP_TTL_MS) return false;

	processedMessages.set(key, now);

	// 清理过期条目
	for (const [msgKey, ts] of processedMessages) {
		if (now - ts >= DEDUP_TTL_MS) processedMessages.delete(msgKey);
	}

	// 溢出保护
	if (processedMessages.size > DEDUP_MAX_SIZE) {
		const overflow = processedMessages.size - DEDUP_MAX_SIZE;
		let removed = 0;
		for (const msgKey of processedMessages.keys()) {
			processedMessages.delete(msgKey);
			if (++removed >= overflow) break;
		}
	}

	return true;
}

// ── 内部 ──

function createInitialHistory(
	systemPrompt: string,
	ctx: FeishuMessageContext,
	paths: WorkspacePaths,
	userInfo?: FeishuUserInfo | null,
): DomainMessage[] {
	return [
		{ type: "system", content: systemPrompt },
		{ type: "system", content: buildFeishuSystemContext(ctx, paths, userInfo) },
	];
}

function buildFeishuSystemContext(
	ctx: FeishuMessageContext,
	paths: WorkspacePaths,
	userInfo?: FeishuUserInfo | null,
): string {
	const lines: string[] = ["Feishu runtime context (trusted):"];

	// 用户可读信息
	if (userInfo?.name) lines.push(`- user_name: ${userInfo.name}`);
	if (userInfo?.nickname) lines.push(`- nickname: ${userInfo.nickname}`);
	if (userInfo?.jobTitle) lines.push(`- job_title: ${userInfo.jobTitle}`);
	if (ctx.chatType) lines.push(`- chat_type: ${ctx.chatType}`);

	// 引导模型通过文件获取完整数据
	lines.push(
		"",
		"User identity details (open_id, chat_id, tenant_key, etc.) and full profile",
		`are stored in: ${paths.memory}/user-info.json`,
		"Import this JSON file when you need to use these values in code or API calls.",
	);

	return lines.join("\n");
}
