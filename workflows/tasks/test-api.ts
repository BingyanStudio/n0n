/** Test API and write result to file */
export default async function run() {
	const result: any = {};

	try {
		// Try Danbooru
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 8000);

		const res = await fetch(
			"https://danbooru.donmai.us/posts.json?tags=large_breasts&limit=1",
			{
				headers: { "User-Agent": "n0n-workflow/1.0" },
				signal: controller.signal,
			},
		);

		result.danbooruStatus = res.status;
		if (res.ok) {
			const data = await res.json();
			result.danbooruCount = Array.isArray(data) ? data.length : 0;
			if (Array.isArray(data) && data.length > 0) {
				result.sampleUrl = data[0].file_url;
				result.sampleTags = data[0].tag_string;
			}
		}
	} catch (e) {
		result.danbooruError = String(e);
	}

	await Bun.write("api-test-result.json", JSON.stringify(result, null, 2));
	return result;
}
