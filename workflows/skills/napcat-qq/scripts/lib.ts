/**
 * Napcat WebSocket 共享库
 *
 * 提供配置读取和消息发送的通用逻辑。
 */

export interface NapcatConfig {
	host: string;
	port: number;
	token: string;
}

/** 从 workflows/memory/config/napcat.json 读取配置 */
export async function readConfig(): Promise<NapcatConfig> {
	const json = await Bun.file("workflows/memory/config/napcat.json").json();
	return {
		host: json.server_host ?? "127.0.0.1",
		port: Number(json.server_port ?? 9881),
		token: json.token ?? "",
	};
}

/** 通过 WebSocket 发送 OneBot 消息并等待响应 */
export async function sendMessage(
	config: NapcatConfig,
	payload: { action: string; params: Record<string, unknown> },
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	const wsUrls = [
		`ws://${config.host}:${config.port}/`,
		`ws://${config.host}:${config.port}/ws`,
	];

	for (const url of wsUrls) {
		try {
			const ws = new WebSocket(url);

			const connected = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 3000);
				ws.onopen = () => {
					clearTimeout(timeout);
					resolve(true);
				};
				ws.onerror = () => {
					clearTimeout(timeout);
					resolve(false);
				};
			});

			if (!connected) {
				ws.close();
				continue;
			}

			const echo = `msg_${Date.now()}`;
			const message = JSON.stringify({ ...payload, echo });
			ws.send(message);

			const response = await new Promise<Record<string, unknown>>((resolve) => {
				const handler = (event: MessageEvent) => {
					try {
						const data = JSON.parse(event.data as string);
						if (data.echo === echo) {
							ws.removeEventListener("message", handler);
							resolve(data as Record<string, unknown>);
						}
					} catch {
						/* ignore parse errors */
					}
				};
				ws.addEventListener("message", handler);
				setTimeout(() => {
					ws.removeEventListener("message", handler);
					resolve({ retcode: -1, status: "timeout" });
				}, 5000);
			});

			ws.close();

			return response.retcode === 0
				? { ok: true, data: response.data }
				: { ok: false, error: `retcode=${response.retcode}` };
		} catch {}
	}

	return { ok: false, error: "Failed to connect to Napcat WebSocket" };
}
