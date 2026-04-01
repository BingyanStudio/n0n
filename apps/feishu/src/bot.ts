/**
 * FeishuBot — 飞书 API 客户端
 *
 * 职责：封装飞书 OpenAPI 调用（消息创建/编辑），
 * 以及从事件数据中提取上下文信息。
 * 卡片构建逻辑已移至 cards/ 模块。
 */

import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuCardContent } from "./cards/index.ts";

// ── 类型定义 ──

export type FeishuMessageEventData = Parameters<
	NonNullable<lark.EventHandles["im.message.receive_v1"]>
>[0];
export type FeishuMenuEventData = Parameters<
	NonNullable<lark.EventHandles["application.bot.menu_v6"]>
>[0];

export type FeishuReceiveIdType = "chat_id" | "open_id";

export interface FeishuRecipient {
	receiveIdType: FeishuReceiveIdType;
	receiveId: string;
}

export interface FeishuMessageContext {
	chatId: string | null;
	chatType: string | null;
	senderOpenId: string;
	senderUserId: string | null;
	senderUnionId: string | null;
	tenantKey: string | null;
	messageId: string | null;
	recipient: FeishuRecipient;
}

export interface FeishuUserInfo {
	openId: string;
	name: string | null;
	enName: string | null;
	nickname: string | null;
	avatar: string | null;
	email: string | null;
	mobile: string | null;
	departmentIds: string[];
	jobTitle: string | null;
	updatedAt: string;
}

export interface FeishuBotConfig {
	appId: string;
	appSecret: string;
	domain?: "feishu" | "lark";
}

// ── Bot 客户端 ──

export class FeishuBot {
	private readonly client: lark.Client;

	constructor(config: FeishuBotConfig) {
		this.client = new lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			domain: config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			appType: lark.AppType.SelfBuild,
		});
	}

	// ── 事件上下文提取（静态） ──

	static buildContext(
		event: FeishuMessageEventData,
	): FeishuMessageContext | null {
		if (!event?.message) return null;
		const chatId = String(event.message.chat_id ?? "");
		const chatType = String(event.message.chat_type ?? "");
		const messageId = String(event.message.message_id ?? "");
		if (!chatId || !messageId) return null;

		const senderId = event.sender?.sender_id ?? {};
		const senderOpenId = String(senderId.open_id ?? "");
		const senderUserId = senderId.user_id ? String(senderId.user_id) : null;
		const senderUnionId = senderId.union_id ? String(senderId.union_id) : null;
		const tenantKey = event.sender?.tenant_key
			? String(event.sender.tenant_key)
			: null;

		const recipient: FeishuRecipient =
			chatType === "p2p" && senderOpenId
				? { receiveIdType: "open_id", receiveId: senderOpenId }
				: { receiveIdType: "chat_id", receiveId: chatId };

		return {
			chatId,
			chatType,
			senderOpenId,
			senderUserId,
			senderUnionId,
			tenantKey,
			messageId,
			recipient,
		};
	}

	static buildContextForMenu(
		event: FeishuMenuEventData,
	): FeishuMessageContext | null {
		const eventId = String(event.event_id ?? "");
		if (!eventId) return null;

		const operatorId = event.operator?.operator_id ?? {};
		const senderOpenId = String(operatorId.open_id ?? "");
		const senderUserId = operatorId.user_id ? String(operatorId.user_id) : null;
		const senderUnionId = operatorId.union_id
			? String(operatorId.union_id)
			: null;
		const tenantKey = event.tenant_key ? String(event.tenant_key) : null;

		return {
			chatId: null,
			chatType: null,
			senderOpenId,
			senderUserId,
			senderUnionId,
			tenantKey,
			messageId: null,
			recipient: { receiveIdType: "open_id", receiveId: senderOpenId },
		};
	}

	// TODO 群聊消息中的 @mention 占位符（如 @_user_1）未清理，
	// 应在返回前用正则去除，避免下游收到原始占位符文本
	static readText(data: FeishuMessageEventData): string {
		const raw = data?.message?.content;
		if (!raw || typeof raw !== "string") return "";
		try {
			const parsed = JSON.parse(raw) as { text?: unknown };
			return typeof parsed.text === "string" ? parsed.text.trim() : "";
		} catch {
			return "";
		}
	}

	// ── 消息 API ──

	/** 创建卡片消息，返回 message_id */
	async createCardMessage(
		ctx: FeishuMessageContext,
		card: FeishuCardContent,
	): Promise<string> {
		const content = JSON.stringify(card);
		const res = await this.client.im.message.create({
			params: { receive_id_type: ctx.recipient.receiveIdType },
			data: {
				receive_id: ctx.recipient.receiveId,
				msg_type: "interactive",
				content,
			},
		});
		const messageId = res?.data?.message_id;
		if (!messageId) {
			throw new Error("Failed to create card message: missing message_id");
		}
		return String(messageId);
	}

	/** 编辑已有卡片消息 */
	async editCardMessage(
		messageId: string,
		card: FeishuCardContent,
	): Promise<void> {
		const content = JSON.stringify(card);
		await this.client.im.message.patch({
			path: { message_id: messageId },
			data: { content },
		});
	}

	// ── CardKit API（流式卡片） ──

	/** 创建卡片实体，返回 card_id */
	async createCardEntity(card: FeishuCardContent): Promise<string> {
		const res = await this.client.cardkit.v1.card.create({
			data: {
				type: "card_json",
				data: JSON.stringify(card),
			},
		});
		const cardId = res?.data?.card_id;
		if (!cardId) {
			throw new Error("Failed to create card entity: missing card_id");
		}
		return String(cardId);
	}

	/** 发送卡片实体消息（通过 card_id），返回 message_id */
	async sendCardEntity(
		ctx: FeishuMessageContext,
		cardId: string,
	): Promise<string> {
		const content = JSON.stringify({
			type: "card",
			data: { card_id: cardId },
		});
		const res = await this.client.im.message.create({
			params: { receive_id_type: ctx.recipient.receiveIdType },
			data: {
				receive_id: ctx.recipient.receiveId,
				msg_type: "interactive",
				content,
			},
		});
		const messageId = res?.data?.message_id;
		if (!messageId) {
			throw new Error("Failed to send card entity: missing message_id");
		}
		return String(messageId);
	}

	/** 流式更新卡片文本元素（打字机效果） */
	async streamCardElementContent(
		cardId: string,
		elementId: string,
		content: string,
		sequence: number,
	): Promise<void> {
		await this.client.cardkit.v1.cardElement.content({
			path: { card_id: cardId, element_id: elementId },
			data: { content, sequence },
		});
	}

	/** 全量更新卡片实体 */
	async updateCardEntity(
		cardId: string,
		card: FeishuCardContent,
		sequence: number,
	): Promise<void> {
		await this.client.cardkit.v1.card.update({
			path: { card_id: cardId },
			data: {
				card: { type: "card_json", data: JSON.stringify(card) },
				sequence,
			},
		});
	}

	// ── 用户信息 API ──

	/**
	 * 通过 open_id 获取用户详细信息（姓名、头像、部门等）。
	 * 需要 contact:user.base:readonly 权限。
	 */
	async getUserInfo(openId: string): Promise<FeishuUserInfo | null> {
		try {
			const res = await this.client.contact.v3.user.get({
				path: { user_id: openId },
				params: { user_id_type: "open_id" },
			});
			const user = res?.data?.user;
			if (!user) return null;
			return {
				openId,
				name: user.name ?? null,
				enName: user.en_name ?? null,
				nickname: user.nickname ?? null,
				avatar: user.avatar?.avatar_origin ?? user.avatar?.avatar_240 ?? null,
				email: user.email ?? null,
				mobile: user.mobile ?? null,
				departmentIds: (user.department_ids ?? []) as string[],
				jobTitle: user.job_title ?? null,
				updatedAt: new Date().toISOString(),
			};
		} catch (err) {
			console.error(`[feishu] getUserInfo failed for ${openId}:`, err);
			return null;
		}
	}

	/** 更新卡片配置（如开关流式模式） */
	async updateCardSettings(
		cardId: string,
		settings: Record<string, unknown>,
		sequence: number,
	): Promise<void> {
		await this.client.cardkit.v1.card.settings({
			path: { card_id: cardId },
			data: {
				settings: JSON.stringify(settings),
				sequence,
			},
		});
	}
}
