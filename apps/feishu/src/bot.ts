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
}
