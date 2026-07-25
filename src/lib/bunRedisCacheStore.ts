import { RedisClient } from "bun";
import { ICacheStore } from "../types/cache";

const TAG_KEY_PREFIX = "tagedCache:";

/** 解析 tag 索引条目 "expiresAt_ms cacheKey"，未过期返回 cacheKey，否则 null */
function parseTagEntry(entry: string): { cacheKey: string; expired: boolean } | null {
  const idx = entry.indexOf(" ");
  if (idx <= 0) return null;
  const expiresAt = Number(entry.slice(0, idx));
  const cacheKey = entry.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || !cacheKey) return null;
  return { cacheKey, expired: expiresAt <= Date.now() };
}

export class BunRedisCacheStore implements ICacheStore {
    private client: RedisClient;
	private readonly maxBodyBytes: number;
	private readonly defaultTtl: number;

	constructor(redisUrl: string, maxBodyBytes: number, defaultTtl: number = 300) {
		this.client = new RedisClient(redisUrl);
		this.maxBodyBytes = maxBodyBytes;
		this.defaultTtl = defaultTtl;
	}

	public async init(): Promise<void> {
		await this.client.ping();
	}

	public async get<T>(key: string): Promise<T | null> {
		const raw = await this.client.get(key);
		if (raw == null) return null;

		try {
			return JSON.parse(raw) as T;
		} catch {
			await this.client.del(key);
			return null;
		}
	}

	public async set<T>(key: string, value: T, ttl: number, tags?: string[]): Promise<void> {
		const payload = JSON.stringify(value);
		if (payload.length > this.maxBodyBytes) return;

		let effectiveTtl = ttl;
		if (effectiveTtl <= 0) effectiveTtl = this.defaultTtl;

		await this.client.set(key, payload);
		if (effectiveTtl > 0) {
			await this.client.expire(key, effectiveTtl);
		}

		// 写入 tag 索引
		if (tags && tags.length > 0) {
			const expiresAt = Date.now() + effectiveTtl * 1000;
			const entry = `${expiresAt} ${key}`;
			for (const tag of tags) {
				await this.client.send("RPUSH", [TAG_KEY_PREFIX + tag, entry]);
			}
		}
	}

	public async delete(key: string): Promise<void> {
		// 先读取缓存条目中的 tags 以清理索引
		await this.removeFromTagIndices(key);
		await this.client.del(key);
	}

	public async deleteByPrefix(prefix: string): Promise<number> {
		const pattern = `${prefix}*`;
		let cursor = "0";
		let deleted = 0;

		do {
			const resp = await this.client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "200"]);
			const nextCursor = String((resp as [string, string[]])[0]);
			const keys = ((resp as [string, string[]])[1] ?? []) as string[];

			if (keys.length > 0) {
				// 清理每个 key 的 tag 索引
				for (const k of keys) {
					await this.removeFromTagIndices(k);
				}
				const n = await this.client.del(...keys);
				deleted += Number(n);
			}

			cursor = nextCursor;
		} while (cursor !== "0");

		return deleted;
	}

	public async deleteByTag(tag: string): Promise<number> {
		const tagKey = TAG_KEY_PREFIX + tag;
		const items = await this.client.send("LRANGE", [tagKey, "0", "-1"]) as string[];
		if (!items || items.length === 0) {
			await this.client.del(tagKey);
			return 0;
		}

		let deleted = 0;
		const keysToDelete: string[] = [];
		for (const item of items) {
			const parsed = parseTagEntry(item);
			if (!parsed) continue;
			if (!parsed.expired) {
				keysToDelete.push(parsed.cacheKey);
			}
		}

		if (keysToDelete.length > 0) {
			// 清理各自剩余 tag 索引
			for (const k of keysToDelete) {
				await this.removeFromTagIndices(k);
			}
			const n = await this.client.del(...keysToDelete);
			deleted += Number(n);
		}

		await this.client.del(tagKey);
		return deleted;
	}

	public async listByTag(tag: string): Promise<string[]> {
		const tagKey = TAG_KEY_PREFIX + tag;
		const items = await this.client.send("LRANGE", [tagKey, "0", "-1"]) as string[];
		if (!items || items.length === 0) return [];

		const result: string[] = [];
		for (const item of items) {
			const parsed = parseTagEntry(item);
			if (parsed && !parsed.expired) {
				result.push(parsed.cacheKey);
			}
		}
		return result;
	}

	public async listByPrefix(prefix: string): Promise<string[]> {
		const pattern = `${prefix}*`;
		let cursor = "0";
		const keys: string[] = [];

		do {
			const resp = await this.client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "200"]);
			const nextCursor = String((resp as [string, string[]])[0]);
			const batch = ((resp as [string, string[]])[1] ?? []) as string[];
			keys.push(...batch);
			cursor = nextCursor;
		} while (cursor !== "0");

		return keys;
	}

	public async cleanExpiredTagIndices(): Promise<number> {
		const pattern = `${TAG_KEY_PREFIX}*`;
		let cursor = "0";
		let cleaned = 0;

		do {
			const resp = await this.client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "50"]);
			const nextCursor = String((resp as [string, string[]])[0]);
			const tagKeys = ((resp as [string, string[]])[1] ?? []) as string[];

			for (const tagKey of tagKeys) {
				const items = await this.client.send("LRANGE", [tagKey, "0", "-1"]) as string[];
				if (!items || items.length === 0) {
					await this.client.del(tagKey);
					continue;
				}

				const toRemove: string[] = [];
				for (const item of items) {
					const parsed = parseTagEntry(item);
					if (!parsed || parsed.expired) {
						toRemove.push(item);
					}
				}

				if (toRemove.length > 0) {
					for (const entry of toRemove) {
						// LREM count=1 精确值删除（值中不含空格的极端情况很少，LREM 精确匹配可行）
						await this.client.send("LREM", [tagKey, "1", entry]);
						cleaned++;
					}
				}

				// 列表变空则删除 tag key
				const remaining = await this.client.send("LLEN", [tagKey]) as number;
				if (remaining === 0) {
					await this.client.del(tagKey);
				}
			}

			cursor = nextCursor;
		} while (cursor !== "0");

		return cleaned;
	}

	public async size(): Promise<number> {
		const count = await this.client.send("DBSIZE", []);
		return Number(count) || 0;
	}

	/**
	 * 从所有关联的 tag 索引中移除指定 key。
	 * 通过扫描 tagedCache:* 并逐条 LREM 实现。
	 */
	private async removeFromTagIndices(key: string): Promise<void> {
		const pattern = `${TAG_KEY_PREFIX}*`;
		let cursor = "0";

		do {
			const resp = await this.client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "50"]);
			const nextCursor = String((resp as [string, string[]])[0]);
			const tagKeys = ((resp as [string, string[]])[1] ?? []) as string[];

			for (const tagKey of tagKeys) {
				const items = await this.client.send("LRANGE", [tagKey, "0", "-1"]) as string[];
				if (!items) continue;

				for (const item of items) {
					const parsed = parseTagEntry(item);
					if (parsed && parsed.cacheKey === key) {
						await this.client.send("LREM", [tagKey, "1", item]);
					}
				}

				// 清理空列表
				const remaining = await this.client.send("LLEN", [tagKey]) as number;
				if (remaining === 0) {
					await this.client.del(tagKey);
				}
			}

			cursor = nextCursor;
		} while (cursor !== "0");
	}
}