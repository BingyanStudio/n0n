/** Listen for next message in QQ group 718824969, record it locally, and echo it back */

import { readConfig } from "../skills/napcat-qq/scripts/lib.ts";

interface GroupMessageEvent {
	post_type: "message";
	message_type: "group";
	time: number;
	self_id: number;
	sub_type: "normal" | "anonymous";
	user_id: number;
	message: string;
	raw_message: string;
	group_id: number;
	sender: {
		user_id: number;
		nickname: string;
		card: string;
	};
	message_id: number;
}

export default async function run() {
	const config = await readConfig();
	const targetGroupId = 718824969;
	const wsUrl = `ws://${config.host}:${config.port}/`;

	console.log(`Connecting to ${wsUrl}...`);
	console.log(`Listening for messages in group ${targetGroupId}...`);

	const ws = new WebSocket(wsUrl);

	return new Promise<{ success: boolean; message?: string; error?: string }>((resolve) => {
		const timeout = setTimeout(() => {
			ws.close();
			resolve({ success: false, error: "Timeout: No message received within 60 seconds" });
		}, 60000);

		ws.onopen = () => {
			console.log("WebSocket connected, waiting for group message...");
		};

		ws.onerror = (error) => {
			clearTimeout(timeout);
			console.error("WebSocket error:", error);
			resolve({ success: false, error: "WebSocket connection error" });
		};

		ws.onclose = () => {
			clearTimeout(timeout);
			console.log("WebSocket closed");
		};

		ws.onmessage = async (event) => {
			try {
				const data = JSON.parse(event.data as string);

				// Skip API responses (they have echo field)
				if (data.echo) return;

				// Check if it's a group message
				if (
					data.post_type === "message" &&
					data.message_type === "group" &&
					data.group_id === targetGroupId
				) {
					clearTimeout(timeout);

					const msg = data as GroupMessageEvent;
					console.log(`Received message from ${msg.sender.nickname}: ${msg.message}`);

					// Record to local file
					const recordFile = "workflows/memory/group-messages.json";
					let records: Array<{
						timestamp: string;
						group_id: number;
						user_id: number;
						nickname: string;
						message: string;
					}> = [];

					try {
						const existing = await Bun.file(recordFile).json();
						records = existing;
					} catch {
						// File doesn't exist, start fresh
					}

					records.push({
						timestamp: new Date().toISOString(),
						group_id: msg.group_id,
						user_id: msg.user_id,
						nickname: msg.sender.nickname,
						message: msg.message,
					});

					await Bun.write(recordFile, JSON.stringify(records, null, 2));
					console.log(`Message recorded to ${recordFile}`);

					// Echo the message back
					const echoPayload = {
						action: "send_group_msg",
						params: {
							group_id: targetGroupId,
							message: msg.message,
						},
						echo: `echo_${Date.now()}`,
					};

					ws.send(JSON.stringify(echoPayload));
					console.log("Message echoed back to group");

					// Wait a moment for send confirmation then close
					setTimeout(() => {
						ws.close();
						resolve({
							success: true,
							message: `Received and echoed: "${msg.message}" from ${msg.sender.nickname}`,
						});
					}, 1000);
				}
			} catch (e) {
				console.error("Failed to parse message:", e);
			}
		};
	});
}
