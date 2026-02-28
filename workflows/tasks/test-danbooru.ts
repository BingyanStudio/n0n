/** Test Danbooru API */
export default async function run() {
	console.log("Starting test...");

	// Try with shorter timeout
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		console.log("Aborting request...");
		controller.abort();
	}, 5000);

	try {
		console.log("Fetching from Danbooru...");
		const res = await fetch(
			"https://danbooru.donmai.us/posts.json?tags=large_breasts&limit=1",
			{
				headers: { "User-Agent": "n0n-workflow/1.0" },
				signal: controller.signal,
			},
		);
		clearTimeout(timeoutId);

		console.log("Got response, status:", res.status);
		const text = await res.text();
		console.log("Response length:", text.length);
		console.log("First 200 chars:", text.substring(0, 200));

		return { status: res.status, length: text.length };
	} catch (e) {
		clearTimeout(timeoutId);
		console.error("Error:", e);
		return { error: String(e) };
	}
}
