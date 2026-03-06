/**
 * Session — 飞书会话管理
 *
 * 管理每个用户/群聊的对话状态（history、当前任务、去重）。
 */

import type { DomainMessage } from "@n0n/types";
import type { FeishuMessageContext } from "./bot.ts";

// ── 类型 ──

export interface FeishuSession {
	history: DomainMessage[];
	ctx: FeishuMessageContext;
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
): FeishuSession {
	const existing = sessions.get(sessionKey);
	if (existing) {
		existing.ctx = ctx;
		return existing;
	}
	const session: FeishuSession = {
		history: createInitialHistory(systemPrompt, ctx),
		ctx,
		currentTask: null,
	};
	sessions.set(sessionKey, session);
	return session;
}

export function resetSession(
	sessionKey: string,
	ctx: FeishuMessageContext,
	systemPrompt: string,
): FeishuSession {
	const session: FeishuSession = {
		history: createInitialHistory(systemPrompt, ctx),
		ctx,
		currentTask: null,
	};
	sessions.set(sessionKey, session);
	return session;
}

export function deleteSession(sessionKey: string): void {
	sessions.delete(sessionKey);
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
): DomainMessage[] {
	return [
		{ type: "system", content: systemPrompt },
		{ type: "system", content: buildFeishuSystemContext(ctx) },
	];
}

function buildFeishuSystemContext(ctx: FeishuMessageContext): string {
	return [
		"Feishu runtime context (trusted):",
		`- source: feishu`,
		`- chat_id: ${ctx.chatId}`,
		`- chat_type: ${ctx.chatType}`,
		`- sender_open_id: ${ctx.senderOpenId ?? ""}`,
		`- sender_user_id: ${ctx.senderUserId ?? ""}`,
		`- sender_union_id: ${ctx.senderUnionId ?? ""}`,
		`- tenant_key: ${ctx.tenantKey ?? ""}`,
	].join("\n");
}
