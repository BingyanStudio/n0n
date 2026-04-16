/**
 * Submit 完成提示音
 *
 * 默认关闭，通过 N0N_NOTIFY_SOUND=1 环境变量开启。
 * 可通过 N0N_NOTIFY_SOUND_PATH 指定自定义音频文件路径，
 * 未指定时使用内置的 knock-knock.wav。
 */

import { existsSync } from "node:fs";
import defaultSoundPath from "./assets/knock-knock.wav" with { type: "file" };

/** 判断提示音是否启用 */
export function isNotifySoundEnabled(): boolean {
	const val = process.env.N0N_NOTIFY_SOUND;
	return val === "1" || val === "true";
}

/** 播放提示音（异步、不阻塞、失败静默） */
export function playNotifySound(): void {
	if (!isNotifySoundEnabled()) return;

	const customPath = process.env.N0N_NOTIFY_SOUND_PATH;
	const soundPath =
		customPath && existsSync(customPath) ? customPath : defaultSoundPath;

	try {
		const platform = process.platform;
		if (platform === "win32") {
			Bun.spawn(
				[
					"powershell",
					"-NoProfile",
					"-Command",
					`(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
		} else if (platform === "darwin") {
			Bun.spawn(["afplay", soundPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
		} else {
			// Linux: paplay (PulseAudio) → aplay (ALSA)
			const player =
				Bun.spawnSync(["which", "paplay"]).exitCode === 0 ? "paplay" : "aplay";
			Bun.spawn([player, soundPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}
	} catch {
		// 播放失败不应影响主流程
	}
}
