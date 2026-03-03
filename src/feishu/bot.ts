import * as lark from "@larksuiteoapi/node-sdk";

export type FeishuReceiveIdType = "chat_id" | "open_id";

export interface FeishuRecipient {
	receiveIdType: FeishuReceiveIdType;
	receiveId: string;
}

export interface FeishuMessageContext {
	chatId: string;
	chatType: string;
	senderOpenId: string | null;
	senderUserId: string | null;
	senderUnionId: string | null;
	tenantKey: string | null;
	messageId: string;
	recipient: FeishuRecipient;
}

export interface FeishuBotConfig {
	appId: string;
	appSecret: string;
	domain?: "feishu" | "lark";
}

export class FeishuBot {
	private readonly client: any;

	constructor(config: FeishuBotConfig) {
		this.client = new lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			domain:
				config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			appType: lark.AppType.SelfBuild,
		});
	}

	static buildContext(event: any): FeishuMessageContext | null {
		if (!event?.message) return null;

		const chatId = String(event.message.chat_id ?? "");
		const chatType = String(event.message.chat_type ?? "");
		const messageId = String(event.message.message_id ?? "");
		console.log(`Extracted chatId=${chatId}, chatType=${chatType}, messageId=${messageId}`);
		if (!chatId || !messageId) return null;

		const senderId = event.sender?.sender_id ?? {};
		const senderOpenId = senderId.open_id ? String(senderId.open_id) : null;
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

	static readText(data: any): string {
		const raw = data?.message?.content;
		if (!raw || typeof raw !== "string") return "";
		try {
			const parsed = JSON.parse(raw) as { text?: unknown };
			return typeof parsed.text === "string" ? parsed.text.trim() : "";
		} catch {
			return "";
		}
	}

	async sendText(ctx: FeishuMessageContext, text: string): Promise<void> {
		const chunks = chunkText(text, 1800);
		for (const chunk of chunks) {
			await this.client.im.message.create({
				params: {
					receive_id_type: ctx.recipient.receiveIdType,
				},
				data: {
					receive_id: ctx.recipient.receiveId,
					msg_type: "text",
					content: JSON.stringify({ text: chunk }),
				},
			});
		}
	}
}

function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}
