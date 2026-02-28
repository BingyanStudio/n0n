/** Get current time in a human-readable format */
export default async function run() {
	const now = new Date();

	// Format: 17:30:45 (Saturday, February 28, 2026)
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");

	const days = [
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	];
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];

	const time = `${hours}:${minutes}:${seconds}`;
	const date = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const result = `${time} (${date}, ${timezone})`;

	// Return both structured data and human-readable message
	return {
		time: time,
		date: date,
		timezone: timezone,
		message: result,
		full_info: {
			hour: now.getHours(),
			minute: now.getMinutes(),
			second: now.getSeconds(),
			day_of_week: days[now.getDay()],
			month: months[now.getMonth()],
			day: now.getDate(),
			year: now.getFullYear(),
		},
	};
}
