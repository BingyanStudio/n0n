/**
 * PPIO Web Search API 共享库
 *
 * 封装 https://api.ppio.com 的 Web Search 接口，
 * 提供类型安全的搜索函数，支持网页、图片、视频结果。
 *
 * 环境变量: WEB_SEARCH_API_KEY（Bearer token）
 */

// ── 请求类型 ──

export interface SearchOptions {
	/** 搜索关键词（必填） */
	query: string;
	/** 时间范围过滤，默认 noLimit */
	freshness?:
		| "noLimit"
		| "oneDay"
		| "oneWeek"
		| "oneMonth"
		| "oneYear"
		| (string & {});
	/** 是否返回文本摘要，默认 false */
	summary?: boolean;
	/** 限定搜索的域名，多个用 | 分隔 */
	include?: string;
	/** 排除搜索的域名，多个用 | 分隔 */
	exclude?: string;
	/** 返回结果数量，1-50，默认 10 */
	count?: number;
}

// ── 响应类型 ──

export interface SearchResponse {
	_type: "SearchResponse";
	queryContext: { originalQuery: string };
	webPages?: WebPages;
	images?: Images;
	videos?: Videos;
}

export interface WebPages {
	webSearchUrl: string;
	totalEstimatedMatches: number;
	value: WebPage[];
	someResultsRemoved?: boolean;
}

export interface WebPage {
	id: string;
	name: string;
	url: string;
	displayUrl: string;
	snippet: string;
	summary?: string;
	siteName: string;
	siteIcon: string;
	datePublished?: string;
	dateLastCrawled?: string;
	cachedPageUrl?: string;
	language?: string;
	isFamilyFriendly?: boolean;
	isNavigational?: boolean;
}

export interface Images {
	id: string;
	readLink: string;
	webSearchUrl: string;
	isFamilyFriendly: boolean;
	value: ImageResult[];
}

export interface ImageResult {
	webSearchUrl: string;
	name: string;
	thumbnailUrl: string;
	datePublished?: string;
	contentUrl: string;
	hostPageUrl: string;
	contentSize?: string;
	encodingFormat?: string;
	hostPageDisplayUrl?: string;
	width: number;
	height: number;
	thumbnail?: { width: number; height: number };
}

export interface Videos {
	id: string;
	readLink: string;
	webSearchUrl: string;
	isFamilyFriendly: boolean;
	scenario?: string;
	value: VideoResult[];
}

export interface VideoResult {
	webSearchUrl: string;
	name: string;
	description?: string;
	thumbnailUrl?: string;
	publisher?: { name: string }[];
	creator?: { name: string };
	contentUrl: string;
	hostPageUrl: string;
	encodingFormat?: string;
	hostPageDisplayUrl?: string;
	width?: number;
	height?: number;
	duration?: string;
	motionThumbnailUrl?: string;
	embedHtml?: string;
	allowHttpsEmbed?: boolean;
	viewCount?: number;
	thumbnail?: { width: number; height: number };
	allowMobileEmbed?: boolean;
	isSuperfresh?: boolean;
	datePublished?: string;
}

// ── API 配置 ──

const API_URL = "https://api.ppinfra.com/v3/web-search";

/** 从环境变量读取 API Key */
export function getApiKey(): string {
	const key = process.env.WEB_SEARCH_API_KEY;
	if (!key) {
		throw new Error("环境变量 WEB_SEARCH_API_KEY 未设置");
	}
	return key;
}

// ── 核心搜索函数 ──

/**
 * 执行 Web Search，返回完整的搜索响应
 *
 * @example
 * ```ts
 * const res = await webSearch({ query: "Bun runtime", count: 5, summary: true });
 * for (const page of res.webPages?.value ?? []) {
 *   console.log(page.name, page.url);
 * }
 * ```
 */
export async function webSearch(
	options: SearchOptions,
): Promise<SearchResponse> {
	const apiKey = getApiKey();

	const body: Record<string, unknown> = { query: options.query };
	if (options.freshness) body.freshness = options.freshness;
	if (options.summary !== undefined) body.summary = options.summary;
	if (options.include) body.include = options.include;
	if (options.exclude) body.exclude = options.exclude;
	if (options.count !== undefined) body.count = options.count;

	const resp = await fetch(API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(
			`Web Search API 请求失败: ${resp.status} ${resp.statusText} — ${text}`,
		);
	}

	const json = (await resp.json()) as {
		code: number;
		data: SearchResponse;
		msg?: string;
	};
	if (json.code !== 200) {
		throw new Error(
			`Web Search API 业务错误: code=${json.code} msg=${json.msg ?? ""}`,
		);
	}

	return json.data;
}

// ── 便捷函数 ──

/**
 * 仅搜索网页，返回 WebPage 数组
 */
export async function searchWeb(
	query: string,
	options?: Omit<SearchOptions, "query">,
): Promise<WebPage[]> {
	const res = await webSearch({ query, ...options });
	return res.webPages?.value ?? [];
}

/**
 * 搜索并返回带摘要的网页结果
 */
export async function searchWithSummary(
	query: string,
	options?: Omit<SearchOptions, "query" | "summary">,
): Promise<WebPage[]> {
	return searchWeb(query, { ...options, summary: true });
}
