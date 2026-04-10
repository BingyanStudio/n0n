/**
 * Submit 完成提示音
 *
 * 默认关闭，通过 N0N_NOTIFY_SOUND=1 环境变量开启。
 * 可通过 N0N_NOTIFY_SOUND_PATH 指定自定义音频文件路径，
 * 未指定时使用程序内生成的短促电子音。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cachedDefaultPath: string | null = null;

/** 生成一段短促的电子提示音 WAV 数据（~0.15s, 880Hz 正弦波 + 衰减） */
function generateBeepWav(): Buffer {
	const sampleRate = 22050;
	const duration = 0.15;
	const frequency = 880;
	const numSamples = Math.floor(sampleRate * duration);
	const bitsPerSample = 16;
	const numChannels = 1;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = numSamples * blockAlign;

	const buffer = Buffer.alloc(44 + dataSize);
	let offset = 0;

	// RIFF header
	buffer.write("RIFF", offset); offset += 4;
	buffer.writeUInt32LE(36 + dataSize, offset); offset += 4;
	buffer.write("WAVE", offset); offset += 4;

	// fmt chunk
	buffer.write("fmt ", offset); offset += 4;
	buffer.writeUInt32LE(16, offset); offset += 4;
	buffer.writeUInt16LE(1, offset); offset += 2; // PCM
	buffer.writeUInt16LE(numChannels, offset); offset += 2;
	buffer.writeUInt32LE(sampleRate, offset); offset += 4;
	buffer.writeUInt32LE(byteRate, offset); offset += 4;
	buffer.writeUInt16LE(blockAlign, offset); offset += 2;
	buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

	// data chunk
	buffer.write("data", offset); offset += 4;
	buffer.writeUInt32LE(dataSize, offset); offset += 4;

	for (let i = 0; i < numSamples; i++) {
		const t = i / sampleRate;
		// 指数衰减的正弦波
		const envelope = Math.exp(-t * 20);
		const sample = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.8;
		const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
		buffer.writeInt16LE(intSample, offset);
		offset += 2;
	}

	return buffer;
}

/** 获取内置提示音的临时文件路径（懒生成，全局缓存） */
function getDefaultSoundPath(): string {
	if (cachedDefaultPath && existsSync(cachedDefaultPath)) {
		return cachedDefaultPath;
	}
	const dir = join(tmpdir(), "n0n");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const filePath = join(dir, "notify.wav");
	writeFileSync(filePath, generateBeepWav());
	cachedDefaultPath = filePath;
	return filePath;
}

/** 判断提示音是否启用 */
export function isNotifySoundEnabled(): boolean {
	const val = process.env.N0N_NOTIFY_SOUND;
	return val === "1" || val === "true";
}

/** 播放提示音（异步、不阻塞、失败静默） */
export function playNotifySound(): void {
	if (!isNotifySoundEnabled()) return;

	const customPath = process.env.N0N_NOTIFY_SOUND_PATH;
	const soundPath = customPath && existsSync(customPath)
		? customPath
		: getDefaultSoundPath();

	try {
		const platform = process.platform;
		if (platform === "win32") {
			Bun.spawn(
				["powershell", "-NoProfile", "-Command",
					`(New-Object Media.SoundPlayer '${soundPath}').PlaySync()`],
				{ stdout: "ignore", stderr: "ignore" },
			);
		} else if (platform === "darwin") {
			Bun.spawn(["afplay", soundPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
		} else {
			// Linux: 尝试 paplay (PulseAudio) → aplay (ALSA)
			const player = Bun.spawnSync(["which", "paplay"]).exitCode === 0
				? "paplay"
				: "aplay";
			Bun.spawn([player, soundPath], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}
	} catch {
		// 播放失败不应影响主流程
	}
}
