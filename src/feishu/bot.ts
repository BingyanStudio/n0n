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

export interface FeishuPostTextElement {
	tag: "text";
	text: string;
	un_escape?: boolean;
}

export interface FeishuPostLinkElement {
	tag: "a";
	text: string;
	href: string;
}

export interface FeishuPostAtElement {
	tag: "at";
	user_id: string;
	user_name?: string;
}

export type FeishuPostElement =
	| FeishuPostTextElement
	| FeishuPostLinkElement
	| FeishuPostAtElement;

export interface FeishuPostContent {
	title: string;
	lines: FeishuPostElement[][];
}

interface FeishuCardContent {
	schema: "2.0";
	config: {
		wide_screen_mode: boolean;
		enable_forward: boolean;
	};
	header: {
		template: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey";
		title: {
			tag: "plain_text";
			content: string;
		};
	};
	body: {
		elements: Array<
		| {
			tag: "markdown";
			content: string;
		}
		| {
			tag: "hr";
		}
		| {
			tag: "collapsible_panel";
			expanded?: boolean;
			header: {
				title: {
					tag: "plain_text" | "markdown";
					content: string;
				};
				icon?: {
					tag: "standard_icon";
					token: string;
					color?: string;
					size?: string;
				};
				icon_position?: "left" | "right" | "follow_text";
				icon_expanded_angle?: -180 | -90 | 90 | 180;
			};
			padding?: string;
			vertical_spacing?: string;
			elements: Array<{
				tag: "markdown";
				content: string;
			}>;
		}
		>;
	};
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

	async sendText(ctx: FeishuMessageContext, title: string, text: string): Promise<void> {
		const chunks = chunkText(text, 1800);
		for (const chunk of chunks) {
			await this.createTextMessage(ctx, chunk, title);
		}
	}

	async createTextMessage(
		ctx: FeishuMessageContext,
		text: string,
		title: string = "消息",
	): Promise<string> {
		const content = JSON.stringify(buildTextCard(title, text));
		const res = await this.client.im.message.create({
			params: {
				receive_id_type: ctx.recipient.receiveIdType,
			},
			data: {
				receive_id: ctx.recipient.receiveId,
				msg_type: "interactive",
				content,
			},
		});
		const messageId = (res as any)?.data?.message_id;
		if (!messageId) {
			throw new Error("Failed to create text message: missing message_id");
		}
		return String(messageId);
	}

	async editTextMessage(messageId: string, text: string, title: string = "消息"): Promise<void> {
		const content = JSON.stringify(buildTextCard(title, text));
		await this.client.im.message.patch({
			path: { message_id: messageId },
			data: {
				content,
			},
		});
	}

	async createPostMessage(
		ctx: FeishuMessageContext,
		post: FeishuPostContent,
	): Promise<string> {
		const content = JSON.stringify(buildPostCard(post));
		const res = await this.client.im.message.create({
			params: {
				receive_id_type: ctx.recipient.receiveIdType,
			},
			data: {
				receive_id: ctx.recipient.receiveId,
				msg_type: "interactive",
				content,
			},
		});
		const messageId = (res as any)?.data?.message_id;
		if (!messageId) {
			throw new Error("Failed to create post message: missing message_id");
		}
		return String(messageId);
	}

	async editPostMessage(messageId: string, post: FeishuPostContent): Promise<void> {
		const content = JSON.stringify(buildPostCard(post));
		await this.client.im.message.patch({
			path: { message_id: messageId },
			data: {
				content,
			},
		});
	}

	async createCollapsibleLogMessage(
		ctx: FeishuMessageContext,
		title: string,
		panelTitle: string,
		contentText: string,
	): Promise<string> {
		const content = JSON.stringify(
			buildCollapsibleLogCard(title, panelTitle, contentText),
		);
		const res = await this.client.im.message.create({
			params: {
				receive_id_type: ctx.recipient.receiveIdType,
			},
			data: {
				receive_id: ctx.recipient.receiveId,
				msg_type: "interactive",
				content,
			},
		});
		const messageId = (res as any)?.data?.message_id;
		if (!messageId) {
			throw new Error("Failed to create collapsible log message: missing message_id");
		}
		return String(messageId);
	}

	async editCollapsibleLogMessage(
		messageId: string,
		title: string,
		panelTitle: string,
		contentText: string,
	): Promise<void> {
		const content = JSON.stringify(
			buildCollapsibleLogCard(title, panelTitle, contentText),
		);
		await this.client.im.message.patch({
			path: { message_id: messageId },
			data: {
				content,
			},
		});
	}
}

function buildTextCard(title: string, text: string): FeishuCardContent {
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: true,
			enable_forward: true,
		},
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: title,
			},
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content: normalizeCardMarkdown(text),
				},
			],
		},
	};
}

function buildPostCard(post: FeishuPostContent): FeishuCardContent {
	const lines = post.lines.map((line) => postLineToMarkdown(line));
	const markdown = lines.join("\n\n");
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: true,
			enable_forward: true,
		},
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: post.title,
			},
		},
		body: {
			elements: [
				buildCollapsiblePanel("工具调用记录", markdown || "等待工具调用..."),
			],
		},
	};
}

function buildCollapsibleLogCard(
	title: string,
	panelTitle: string,
	contentText: string,
): FeishuCardContent {
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: true,
			enable_forward: true,
		},
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: title,
			},
		},
		body: {
			elements: [
				buildCollapsiblePanel(panelTitle, contentText || "(empty)"),
			],
		},
	};
}

function buildCollapsiblePanel(title: string, markdown: string) {
	return {
		tag: "collapsible_panel" as const,
		expanded: false,
		header: {
			title: {
				tag: "plain_text" as const,
				content: title,
			},
			icon: {
				tag: "standard_icon" as const,
				token: "down-small-ccm_outlined",
				size: "16px 16px",
			},
			icon_position: "right" as const,
			icon_expanded_angle: -180 as const,
		},
		vertical_spacing: "8px",
		padding: "8px 8px 8px 8px",
		elements: [
			{
				tag: "markdown" as const,
				content: normalizeCardMarkdown(markdown),
			},
		],
	};
}

function postLineToMarkdown(elements: FeishuPostElement[]): string {
	return elements
		.map((el) => {
			switch (el.tag) {
				case "text":
					return el.text;
				case "a":
					return `[${el.text}](${el.href})`;
				case "at":
					return el.user_name ? `@${el.user_name}` : "@用户";
			}
		})
		.join("");
}

function normalizeCardMarkdown(content: string): string {
	return content.trim() || "(empty)";
}

function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}
