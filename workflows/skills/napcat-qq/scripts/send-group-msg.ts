/**
 * 发送 QQ 群消息 via Napcat WebSocket
 *
 * 用法: bun run workflows/skills/napcat-qq/scripts/send-group-msg.ts <group_id> "message"
 */

import { readConfig, sendMessage } from "./lib.ts";

const groupId = Number(Bun.argv[2]);
const message = Bun.argv[3];

if (!groupId || !message) {
	console.error("Usage: bun run send-group-msg.ts <group_id> \"message\"");
	process.exit(1);
}

const config = await readConfig();
const result = await sendMessage(config, {
	action: "send_group_msg",
	params: { group_id: groupId, message },
});

console.log(JSON.stringify(result, null, 2));
