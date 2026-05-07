/**
 * 用户侧消息类型
 */

// ── 通用系统消息 ──
export interface GenericSystemMessage {
	type: "system";
	content: string;
}

// ── 通用用户文本消息 ──
export interface GenericUserTextMessage {
	type: "generic_user_text";
	content: string;
}

/** 真实用户输入（交互模式），adapter 负责包装为设计线索并拼接上下文 */
export interface UserInputMessage {
	type: "user_input";
	content: string;
	context: string | null;
	/** 注入到用户消息末尾的行为引导提示，各 app 自行定义。null 时 adapter 不追加额外提示。 */
	hint: string | null;
}

export interface UserImageMessage {
	type: "user_image";
	text: string;
	imagePath: string;
	focusX: number;
	focusY: number;
	scale: number;
}
