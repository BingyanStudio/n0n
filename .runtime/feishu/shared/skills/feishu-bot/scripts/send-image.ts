/**
 * 上传图片并发送飞书消息
 *
 * 用法:
 * bun run workflows/skills/feishu-bot/scripts/send-image.ts <receive_id_type> <receive_id> <image_path>
 *
 * 示例:
 * bun run workflows/skills/feishu-bot/scripts/send-image.ts chat_id oc_xxx ./output/chart.png
 */

import {
	createFeishuClient,
	type ReceiveIdType,
	sendImageFromPath,
} from "./lib.ts";

const receiveIdType = Bun.argv[2] as ReceiveIdType | undefined;
const receiveId = Bun.argv[3];
const imagePath = Bun.argv[4];

if (!receiveIdType || !receiveId || !imagePath) {
	console.error(
		"Usage: bun run send-image.ts <receive_id_type> <receive_id> <image_path>",
	);
	process.exit(1);
}

if (receiveIdType !== "chat_id" && receiveIdType !== "open_id") {
	console.error("receive_id_type must be one of: chat_id, open_id");
	process.exit(1);
}

const client = createFeishuClient();

await sendImageFromPath(client, {
	receiveIdType,
	receiveId,
	imagePath,
});

console.log(
	JSON.stringify(
		{
			success: true,
			receiveIdType,
			receiveId,
			imagePath,
		},
		null,
		2,
	),
);
