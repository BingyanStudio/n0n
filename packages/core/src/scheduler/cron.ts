/**
 * 极简 cron 解析器
 *
 * 支持标准 5 字段 cron: minute hour day month weekday
 * 不依赖外部库。
 */

export interface CronFields {
	minute: number[];
	hour: number[];
	day: number[];
	month: number[];
	weekday: number[];
}

function parseField(field: string, min: number, max: number): number[] {
	if (field === "*") {
		return Array.from({ length: max - min + 1 }, (_, i) => min + i);
	}

	const results = new Set<number>();

	for (const part of field.split(",")) {
		const slashIdx = part.indexOf("/");
		const range = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
		const step =
			slashIdx >= 0 ? Number.parseInt(part.slice(slashIdx + 1), 10) : 1;

		if (range === "*") {
			for (let i = min; i <= max; i += step) results.add(i);
		} else if (range.includes("-")) {
			const parts = range.split("-");
			const lo = Number.parseInt(parts[0] ?? "0", 10);
			const hi = Number.parseInt(parts[1] ?? "0", 10);
			for (let i = lo; i <= hi; i += step) results.add(i);
		} else {
			results.add(Number.parseInt(range, 10));
		}
	}

	return [...results].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
	const p = expr.trim().split(/\s+/);
	if (p.length !== 5) {
		throw new Error(`Invalid cron expression: "${expr}" (expected 5 fields)`);
	}

	return {
		minute: parseField(p[0] ?? "*", 0, 59),
		hour: parseField(p[1] ?? "*", 0, 23),
		day: parseField(p[2] ?? "*", 1, 31),
		month: parseField(p[3] ?? "*", 1, 12),
		weekday: parseField(p[4] ?? "*", 0, 6),
	};
}

export function cronMatches(fields: CronFields, date: Date): boolean {
	return (
		fields.minute.includes(date.getMinutes()) &&
		fields.hour.includes(date.getHours()) &&
		fields.day.includes(date.getDate()) &&
		fields.month.includes(date.getMonth() + 1) &&
		fields.weekday.includes(date.getDay())
	);
}
