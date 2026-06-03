import type { FastifyRequest } from "fastify";
import { tooManyRequests } from "./http.js";

export const bodyLimits = {
  defaultJson: 1 * 1024 * 1024,
  syncEvents: 2 * 1024 * 1024,
  mediaUpload: 25 * 1024 * 1024,
} as const;

export const endpointRateLimits = {
  admin: { name: "admin", max: 10_000, windowMs: 60_000 },
  mediaUpload: { name: "media_upload", max: 10_000, windowMs: 60_000 },
  syncEvents: { name: "sync_events", max: 120, windowMs: 60_000 },
  syncReads: { name: "sync_reads", max: 240, windowMs: 60_000 },
} as const;

type RateLimitOptions = {
  name: string;
  max: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function rateLimitIdentity(request: FastifyRequest): string {
  const authorization = headerValue(request.headers.authorization);
  const selectedUserId = headerValue(request.headers["x-flashgame-user-id"] as string | string[] | undefined);
  return `${request.ip}:${authorization}:${selectedUserId}`;
}

export function createRateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let nextCleanupAt = Date.now() + options.windowMs;

  return async (request: FastifyRequest): Promise<void> => {
    const now = Date.now();
    if (now >= nextCleanupAt) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
      nextCleanupAt = now + options.windowMs;
    }

    const key = `${options.name}:${rateLimitIdentity(request)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      return;
    }

    bucket.count += 1;
    if (bucket.count <= options.max) {
      return;
    }

    tooManyRequests(`too many ${options.name} requests`);
  };
}
