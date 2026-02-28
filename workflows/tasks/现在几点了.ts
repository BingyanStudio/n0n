/** 获取当前时间（中文版） */
export default async function run() {
	const now = new Date();

	// 获取中文日期和时间组件
	const year = now.getFullYear();
	const month = now.getMonth() + 1; // JavaScript 月份是 0-indexed
	const day = now.getDate();
	const hour = now.getHours();
	const minute = now.getMinutes();
	const second = now.getSeconds();

	// 星期几的中文名称
	const weekdays = [
		"星期日",
		"星期一",
		"星期二",
		"星期三",
		"星期四",
		"星期五",
		"星期六",
	];
	const weekday = weekdays[now.getDay()];

	// 月份的中文名称
	const months = [
		"一月",
		"二月",
		"三月",
		"四月",
		"五月",
		"六月",
		"七月",
		"八月",
		"九月",
		"十月",
		"十一月",
		"十二月",
	];
	const monthName = months[now.getMonth()];

	// 时间格式化（24小时制）
	const hourStr = String(hour).padStart(2, "0");
	const minuteStr = String(minute).padStart(2, "0");
	const secondStr = String(second).padStart(2, "0");

	// 创建友好的中文消息
	const time24 = `${hourStr}:${minuteStr}:${secondStr}`;
	const time12 = format12Hour(hour, minute, second);
	const dateStr = `${year}年${month}月${day}日 ${weekday}`;

	// 时区信息
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// 问候语
	const greeting = getGreeting(hour);

	const message = `${greeting}，现在时间是 ${time24}（${time12}）\n今天是 ${dateStr}\n时区：${timezone}`;

	return {
		chinese_message: message,
		time: {
			time_24h: time24,
			time_12h: time12,
			hour: hour,
			minute: minute,
			second: second,
		},
		date: {
			year: year,
			month: month,
			month_chinese: monthName,
			day: day,
			weekday: weekday,
		},
		timezone: timezone,
		timestamps: {
			iso: now.toISOString(),
			unix: Math.floor(now.getTime() / 1000),
			local_string: now.toLocaleString("zh-CN"),
		},
		greeting: greeting,
	};
}

/** 将24小时制时间转换为12小时制 */
function format12Hour(hour: number, minute: number, second: number): string {
	const period = hour < 12 ? "上午" : "下午";
	const hour12 = hour % 12 || 12; // 0点转换为12点
	return `${period} ${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/** 根据时间获取问候语 */
function getGreeting(hour: number): string {
	if (hour >= 5 && hour < 9) return "早上好";
	if (hour >= 9 && hour < 12) return "上午好";
	if (hour >= 12 && hour < 14) return "中午好";
	if (hour >= 14 && hour < 18) return "下午好";
	if (hour >= 18 && hour < 22) return "晚上好";
	return "您好";
}
