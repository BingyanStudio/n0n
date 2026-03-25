/**
 * 上传文件并发送飞书消息
 *
 * 用法:
 * bun run workflows/skills/feishu-bot/scripts/send-file.ts <receive_id_type> <receive_id> <file_path> [file_name]
 *
 * 示例:
 * bun run workflows/skills/feishu-bot/scripts/send-file.ts open_id ou_xxx ./output/report.pdf report.pdf
 */

import {
	createFeishuClient,
	type ReceiveIdType,
	sendFileFromPath,
} from "./lib.ts";

const receiveIdType = Bun.argv[2] as ReceiveIdType | undefined;
const receiveId = Bun.argv[3];
const filePath = Bun.argv[4];
const fileName = Bun.argv[5];

if (!receiveIdType || !receiveId || !filePath) {
	console.error(
		"Usage: bun run send-file.ts <receive_id_type> <receive_id> <file_path> [file_name]",
	);
	process.exit(1);
}

if (receiveIdType !== "chat_id" && receiveIdType !== "open_id") {
	console.error("receive_id_type must be one of: chat_id, open_id");
	process.exit(1);
}

const client = createFeishuClient();

await sendFileFromPath(client, {
	receiveIdType,
	receiveId,
	filePath,
	...(fileName ? { fileName } : {}),
});

console.log(
	JSON.stringify(
		{
			success: true,
			receiveIdType,
			receiveId,
			filePath,
			...(fileName ? { fileName } : {}),
		},
		null,
		2,
	),
);
