import { RedisClient } from "bun";
import { ICacheStore } from "../types/cache";

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
		// Test connection
		await this.client.ping();
	}

	public async get<T>(key: string): Promise<T | null> {
		const raw = await this.client.get(key);
		if (raw == null) return null;

		try {
			return JSON.parse(raw) as T;
		} catch {
			// Skip poisoned values to keep cache read path stable.
			await this.client.del(key);
			return null;
		}
	}

	public async set<T>(key: string, value: T, ttl: number): Promise<void> {
		const payload = JSON.stringify(value);
		if (payload.length > this.maxBodyBytes) return;

		let effectiveTtl = ttl;
		if (effectiveTtl <= 0) effectiveTtl = this.defaultTtl;

		await this.client.set(key, payload);
		if (effectiveTtl > 0) {
			await this.client.expire(key, effectiveTtl);
		}
	}

	public async delete(key: string): Promise<void> {
		await this.client.del(key);
	}

	/**
	 * 删除所有以 prefix 开头的缓存条目，返回删除数量。
	 */
	public async deleteByPrefix(prefix: string): Promise<number> {
		const pattern = `${prefix}*`;
		let cursor = "0";
		let deleted = 0;

		do {
			const resp = await this.client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "200"]);
			const nextCursor = String((resp as [string, string[]])[0]);
			const keys = ((resp as [string, string[]])[1] ?? []) as string[];

			if (keys.length > 0) {
				const n = await this.client.del(...keys);
				deleted += Number(n);
			}

			cursor = nextCursor;
		} while (cursor !== "0");

		return deleted;
	}

	public async size(): Promise<number> {
		const count = await this.client.send("DBSIZE", []);
		return Number(count) || 0;
	}

}