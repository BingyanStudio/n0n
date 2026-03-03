import * as lark from "@larksuiteoapi/node-sdk";
import { basename } from "node:path";

export type ReceiveIdType = "chat_id" | "open_id";

export interface Recipient {
	receiveIdType: ReceiveIdType;
	receiveId: string;
}

export interface TextPayload extends Recipient {
	text: string;
}

export interface ImagePathPayload extends Recipient {
	imagePath: string;
}

export interface FilePathPayload extends Recipient {
	filePath: string;
	fileName?: string;
}

type FeishuClient = any;

export function createFeishuClient(): FeishuClient {
	const appId = process.env.FEISHU_APP_ID;
	const appSecret = process.env.FEISHU_APP_SECRET;
	if (!appId || !appSecret) {
		throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
	}
	const domain = process.env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
	return new lark.Client({
		appId,
		appSecret,
		appType: lark.AppType.SelfBuild,
		domain,
	});
}

export async function sendText(
	client: FeishuClient,
	payload: TextPayload,
): Promise<void> {
	await client.im.message.create({
		params: {
			receive_id_type: payload.receiveIdType,
		},
		data: {
			receive_id: payload.receiveId,
			msg_type: "text",
			content: JSON.stringify({ text: payload.text }),
		},
	});
}

export async function uploadImageFromPath(
	client: FeishuClient,
	imagePath: string,
): Promise<string> {
	const image = await Bun.file(imagePath).arrayBuffer();
	const res = await client.im.image.create({
		data: {
			image_type: "message",
			image: Buffer.from(image),
		},
	});
	const imageKey = (res as any)?.image_key;
	if (!imageKey) throw new Error("Failed to upload image: missing image_key");
	return String(imageKey);
}

export async function sendImage(
	client: FeishuClient,
	payload: Recipient & { imageKey: string },
): Promise<void> {
	await client.im.message.create({
		params: {
			receive_id_type: payload.receiveIdType,
		},
		data: {
			receive_id: payload.receiveId,
			msg_type: "image",
			content: JSON.stringify({ image_key: payload.imageKey }),
		},
	});
}

export async function sendImageFromPath(
	client: FeishuClient,
	payload: ImagePathPayload,
): Promise<void> {
	const imageKey = await uploadImageFromPath(client, payload.imagePath);
	await sendImage(client, {
		receiveIdType: payload.receiveIdType,
		receiveId: payload.receiveId,
		imageKey,
	});
}

export async function uploadFileFromPath(
	client: FeishuClient,
	filePath: string,
	fileName?: string,
): Promise<string> {
	const bytes = await Bun.file(filePath).arrayBuffer();
	const finalName = fileName ?? basename(filePath);
	const ext = finalName.includes(".") ? finalName.split(".").pop() ?? "stream" : "stream";
	const res = await client.im.file.create({
		data: {
			file_type: ext,
			file_name: finalName,
			file: Buffer.from(bytes),
		},
	});
	const fileKey = (res as any)?.file_key;
	if (!fileKey) throw new Error("Failed to upload file: missing file_key");
	return String(fileKey);
}

export async function sendFile(
	client: FeishuClient,
	payload: Recipient & { fileKey: string },
): Promise<void> {
	await client.im.message.create({
		params: {
			receive_id_type: payload.receiveIdType,
		},
		data: {
			receive_id: payload.receiveId,
			msg_type: "file",
			content: JSON.stringify({ file_key: payload.fileKey }),
		},
	});
}

export async function sendFileFromPath(
	client: FeishuClient,
	payload: FilePathPayload,
): Promise<void> {
	const fileKey = await uploadFileFromPath(client, payload.filePath, payload.fileName);
	await sendFile(client, {
		receiveIdType: payload.receiveIdType,
		receiveId: payload.receiveId,
		fileKey,
	});
}
