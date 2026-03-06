/** 发送可爱猫猫图到飞书聊天 */
export default async function run() {
	try {
		// 1. 获取可爱猫猫图片
		const fetchCatCmd = [
			"bun",
			"run",
			"D:\\n0n\\workflows\\tasks\\fetch-cat-image.ts",
		];
		const fetchCatProcess = Bun.spawn(fetchCatCmd);
		const fetchCatOutput = await new Response(fetchCatProcess.stdout).text();

		// 提取图片保存路径
		const imagePathMatch = fetchCatOutput.match(/图片已保存到: (.+)/);
		if (!imagePathMatch) {
			throw new Error(
				`未能从输出中找到图片保存路径\n输出内容: ${fetchCatOutput}`,
			);
		}
		const imagePath = imagePathMatch[1]?.trim();
		if (!imagePath) {
			throw new Error("图片路径匹配结果为空");
		}

		// 2. 发送图片到飞书（使用位置参数）
		const sendImageCmd = [
			"bun",
			"run",
			"D:\\n0n\\workflows\\skills\\feishu-bot\\scripts\\send-image.ts",
			"chat_id",
			"oc_9e01ab1e37e42140fbfde30cf085909a",
			imagePath,
		];

		const sendImageProcess = Bun.spawn(sendImageCmd);
		const sendImageExitCode = await sendImageProcess.exited;

		if (sendImageExitCode !== 0) {
			const sendImageOutput = await new Response(
				sendImageProcess.stdout,
			).text();
			const sendImageError = await new Response(sendImageProcess.stderr).text();
			throw new Error(
				`发送图片失败，退出码: ${sendImageExitCode}\n输出: ${sendImageOutput}\n错误: ${sendImageError}`,
			);
		}

		return {
			type: "completed",
			result: "已成功将可爱猫猫图发送到你的飞书聊天窗口",
			summary: "完成发送可爱猫猫图到飞书",
		};
	} catch (error) {
		return {
			type: "error",
			error: `发送猫猫图失败: ${(error as Error).message}`,
		};
	}
}

// 自执行入口
if (import.meta.main) {
	run()
		.then((res) => console.log(JSON.stringify(res)))
		.catch((err) => console.error(err));
}
