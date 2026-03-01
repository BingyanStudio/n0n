/** 获取可爱猫猫图片并保存到home目录 */
export default async function run() {
	console.log("正在获取猫猫图片...");

	// 从The Cat API获取随机猫猫图片
	const response = await fetch(
		"https://api.thecatapi.com/v1/images/search?limit=1&size=med",
		{
			headers: {
				"x-api-key": "demo-api-key",
				"User-Agent": "n0n-workflow/1.0",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`The Cat API请求失败: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as Array<{
		id: string;
		url: string;
		width: number;
		height: number;
	}>;

	if (!data || data.length === 0) {
		throw new Error("未获取到猫猫图片数据");
	}

	const catImage = data[0]!;
	console.log(
		`获取到猫猫图片: ${catImage.id} (${catImage.width}x${catImage.height})`,
	);
	console.log(`图片URL: ${catImage.url}`);

	// 下载图片
	const imageResponse = await fetch(catImage.url);
	if (!imageResponse.ok) {
		throw new Error(
			`下载图片失败: ${imageResponse.status} ${imageResponse.statusText}`,
		);
	}

	const imageBuffer = await imageResponse.arrayBuffer();
	const imageData = new Uint8Array(imageBuffer);

	// 确定home目录路径
	const homeDir =
		process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || ".";

	// 创建文件名
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const fileName = `cute-cat-${catImage.id}-${timestamp}.jpg`;
	// 使用path.join确保正确的路径分隔符
	const filePath = `${homeDir}\\${fileName}`;

	// 保存图片到home目录
	await Bun.write(filePath, imageData);

	console.log(`图片已保存到: ${filePath}`);
	console.log(`文件大小: ${imageData.length} bytes`);

	return {
		success: true,
		imageId: catImage.id,
		imageUrl: catImage.url,
		dimensions: {
			width: catImage.width,
			height: catImage.height,
		},
		savedPath: filePath,
		fileSize: imageData.length,
		timestamp: new Date().toISOString(),
	};
}
