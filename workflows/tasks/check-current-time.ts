/** Get current time in a simple, readable format */
export default async function run() {
	const now = new Date();

	// Format time
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");

	const time = `${hours}:${minutes}:${seconds}`;
	const date = now.toDateString();
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// Create a friendly message
	const message = `现在是 ${time} (${date}, ${timezone})`;

	return {
		success: true,
		message: message,
		data: {
			time: time,
			date: date,
			timezone: timezone,
			timestamp: now.toISOString(),
			unix_timestamp: Math.floor(now.getTime() / 1000),
		},
	};
}
