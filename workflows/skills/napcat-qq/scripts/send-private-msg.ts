/**
 * 发送 QQ 私聊消息 via Napcat WebSocket
 *
 * 用法: bun run workflows/skills/napcat-qq/scripts/send-private-msg.ts <user_id> "message"
 */

import { readConfig, sendMessage } from "./lib.ts";

const userId = Number(Bun.argv[2]);
const message = Bun.argv[3];

if (!userId || !message) {
	console.error("Usage: bun run send-private-msg.ts <user_id> \"message\"");
	process.exit(1);
}

const config = await readConfig();
const result = await sendMessage(config, {
	action: "send_private_msg",
	params: { user_id: userId, message },
});

console.log(JSON.stringify(result, null, 2));
