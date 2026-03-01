/**
 * 多语言问候生成器
 *
 * 用法: bun run workflows/skills/example-greeting/scripts/greet.ts <name> [language]
 */

const GREETINGS: Record<string, { casual: string; formal: string }> = {
	en: { casual: "Hello, {name}!", formal: "Dear {name}, how do you do?" },
	zh: { casual: "你好，{name}！", formal: "{name}，您好！很高兴见到您。" },
	ja: {
		casual: "こんにちは、{name}さん！",
		formal: "{name}様、ご機嫌いかがでしょうか。",
	},
	ko: { casual: "안녕하세요, {name}님!", formal: "{name}님, 만나서 반갑습니다." },
	es: { casual: "¡Hola, {name}!", formal: "Estimado/a {name}, ¿cómo está?" },
	fr: { casual: "Bonjour, {name} !", formal: "Cher/Chère {name}, comment allez-vous ?" },
	de: { casual: "Hallo, {name}!", formal: "Sehr geehrte/r {name}, wie geht es Ihnen?" },
};

const name = Bun.argv[2] ?? "World";
const lang = Bun.argv[3] ?? "en";

const templates = GREETINGS[lang] ?? GREETINGS.en!;

const result = {
	name,
	language: lang,
	greeting: templates.casual.replace("{name}", name),
	formal: templates.formal.replace("{name}", name),
};

console.log(JSON.stringify(result, null, 2));
