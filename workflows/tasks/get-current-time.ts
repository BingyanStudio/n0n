/** Get current time and date */
export default async function run() {
	// Get current time
	const now = new Date();

	// Format time in different formats
	const isoString = now.toISOString();
	const localeString = now.toLocaleString();
	const timeString = now.toTimeString();
	const dateString = now.toDateString();

	// Get timezone
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	return {
		timestamp: isoString,
		local_time: localeString,
		time_only: timeString,
		date_only: dateString,
		timezone: timezone,
		hour: now.getHours(),
		minute: now.getMinutes(),
		second: now.getSeconds(),
		year: now.getFullYear(),
		month: now.getMonth() + 1, // JavaScript months are 0-indexed
		day: now.getDate(),
		day_of_week: [
			"Sunday",
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
			"Saturday",
		][now.getDay()],
		unix_timestamp: Math.floor(now.getTime() / 1000),
	};
}
