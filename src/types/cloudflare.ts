export type CloudflareStringArrayMap = Record<string, string[]>;

export interface CloudflareHttpUri {
	/** path + query（不含协议与 host） */
	raw: string;
	path: string;
	/** 经过 urldecode 后的path */
	path_decoded: string;
	/** 不带前导 ?，保留原始编码 */
	query: string;
	path_extension: string;
	args: CloudflareStringArrayMap;
	args_names: string[];
	args_values: string[];
}

export interface CloudflareHttpHeaders {
	map: CloudflareStringArrayMap;
	names: string[];
	values: string[];
	truncated: boolean;
}

export interface CloudflareHttpBody {
	raw: string;
	truncated: boolean;
	size: number;
	form: CloudflareStringArrayMap;
	form_names: string[];
	form_values: string[];
	mime: string;
}

export interface CloudflareHttpRequest {
	full_uri: string;
	method: string;
	version: number;
	uri: CloudflareHttpUri;
	cookies: CloudflareStringArrayMap;
	headers: CloudflareHttpHeaders;
	body: CloudflareHttpBody;
}

/**
 * Cloudflare WAF 兼容的 http 命名空间（以嵌套对象暴露）。
 * 示例：http.request.uri.path
 */
export interface CloudflareHttp {
	cookie: string;
	host: string;
	referer: string;
	user_agent: string;
	x_forwarded_for: string;
	request: CloudflareHttpRequest;
}

