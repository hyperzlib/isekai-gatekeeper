import type { Context } from "koa";
import type { CloudflareHttp, CloudflareStringArrayMap } from "../types/cloudflare.ts";

function createMemo<T>(factory: () => T): () => T {
	let loaded = false;
	let cached!: T;
	return () => {
		if (!loaded) {
			cached = factory();
			loaded = true;
		}
		return cached;
	};
}

function createLazyProxy<T extends Record<string, unknown>>(
	base: T,
	lazyGetters: Record<string, () => unknown>,
): T {
	const resolved = new Set<string>();

	return new Proxy(base, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && prop in lazyGetters && !resolved.has(prop)) {
				const value = lazyGetters[prop]!();
				Reflect.set(target, prop, value);
				resolved.add(prop);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

function getHeader(ctx: Context, name: string): string {
	const value = ctx.request.headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] ?? "";
	return value ?? "";
}

function parseExtension(pathname: string): string {
	const lastSegment = pathname.split("/").pop() ?? "";
	const index = lastSegment.lastIndexOf(".");
	if (index <= 0 || index === lastSegment.length - 1) return "";
	return lastSegment.slice(index + 1).toLowerCase();
}

// 按 firewalker 思路保留原始 query 编码，不做 URL 解码与重编码
function parseQueryString(rawSearch: string): {
	args: CloudflareStringArrayMap;
	names: string[];
	values: string[];
} {
	const query = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
	if (!query) {
		return { args: {}, names: [], values: [] };
	}

	const args: CloudflareStringArrayMap = {};
	const names: string[] = [];
	const values: string[] = [];

	for (const pair of query.split("&")) {
		if (!pair) continue;
		const eqIndex = pair.indexOf("=");
		const key = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
		const value = eqIndex === -1 ? "" : pair.slice(eqIndex + 1);

		names.push(key);
		values.push(value);
		if (!args[key]) args[key] = [];
		args[key].push(value);
	}

	return { args, names, values };
}

function parseCookies(cookieHeader: string): CloudflareStringArrayMap {
	if (!cookieHeader) return {};

	const cookies: CloudflareStringArrayMap = {};
	for (const cookiePart of cookieHeader.split(";")) {
		const eqIndex = cookiePart.indexOf("=");
		if (eqIndex <= 0) continue;

		const rawKey = cookiePart.slice(0, eqIndex).trim();
		const value = cookiePart.slice(eqIndex + 1).trim();
		let key = rawKey;
		try {
			key = decodeURIComponent(rawKey);
		} catch {
			key = rawKey;
		}

		if (!cookies[key]) cookies[key] = [];
		const cookieValues = cookies[key] ?? (cookies[key] = []);
		cookieValues.push(value);
	}

	return cookies;
}

function parseHeaders(ctx: Context): {
	map: CloudflareStringArrayMap;
	names: string[];
	values: string[];
} {
	const map: CloudflareStringArrayMap = {};
	const names: string[] = [];
	const values: string[] = [];

	for (const [name, rawValue] of Object.entries(ctx.request.headers)) {
		if (rawValue === undefined) continue;
		const lowerName = name.toLowerCase();
		names.push(lowerName);

		if (Array.isArray(rawValue)) {
			map[lowerName] = rawValue;
			values.push(...rawValue);
		} else {
			map[lowerName] = [rawValue];
			values.push(rawValue);
		}
	}

	return { map, names, values };
}

export function toCloudflareHttp(ctx: Context): CloudflareHttp {
	const url = ctx.request.URL;
	const rawSearch = url.search;
	const query = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;

	const cookie = getHeader(ctx, "cookie");
	const referer = getHeader(ctx, "referer") || getHeader(ctx, "referrer");
	const userAgent = getHeader(ctx, "user-agent");
	const xForwardedFor = getHeader(ctx, "x-forwarded-for");
	const host = url.hostname || getHeader(ctx, "host");
	const method = (ctx.method || "GET").toUpperCase();
	const version = Number.parseFloat(ctx.req.httpVersion || "1.1") || 1.1;
	const fullUri = `${url.pathname}${url.search}`;

	const getParsedQuery = createMemo(() => parseQueryString(rawSearch));
	const getParsedCookies = createMemo(() => parseCookies(cookie));
	const getParsedHeaders = createMemo(() => parseHeaders(ctx));
	const getPathExtension = createMemo(() => parseExtension(url.pathname));

	const uri = createLazyProxy(
		{
			raw: fullUri,
			path: url.pathname,
			path_decoded: decodeURIComponent(url.pathname),
			query,
			path_extension: "",
			args: {},
			args_names: [],
			args_values: [],
		},
		{
			path_extension: () => getPathExtension(),
			args: () => getParsedQuery().args,
			args_names: () => getParsedQuery().names,
			args_values: () => getParsedQuery().values,
		},
	);

	const headers = createLazyProxy(
		{
			map: {},
			names: [],
			values: [],
			truncated: false,
		},
		{
			map: () => getParsedHeaders().map,
			names: () => getParsedHeaders().names,
			values: () => getParsedHeaders().values,
		},
	);

	const request = createLazyProxy(
		{
			full_uri: fullUri,
			method,
			version,
			uri,
			cookies: {},
			headers,
			body: {
				raw: "",
				truncated: false,
				size: 0,
				form: {},
				form_names: [],
				form_values: [],
				mime: getHeader(ctx, "content-type"),
			},
		},
		{
			cookies: () => getParsedCookies(),
		},
	);

	return {
		cookie,
		host,
		referer,
		user_agent: userAgent,
		x_forwarded_for: xForwardedFor,
		request: request as CloudflareHttp["request"],
	};
}
