import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { loadConfig } from "./config.js";
import { optionalUUID, unauthorized } from "./http.js";

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    unauthorized("Bearer token is required");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    unauthorized("Bearer token is required");
  }
  return token;
}

export function requireAdmin(request: FastifyRequest): void {
  const token = bearerToken(request);
  const expected = loadConfig().adminApiKey;
  if (!constantTimeEqual(token, expected)) {
    unauthorized("Invalid admin token");
  }
}

export function requireHouseholdSync(request: FastifyRequest): void {
  const token = bearerToken(request);
  const expected = loadConfig().householdSyncToken;
  if (!constantTimeEqual(token, expected)) {
    unauthorized("Invalid household sync token");
  }
}

export function selectedUserHeader(request: FastifyRequest): string | null {
  const value = request.headers["x-flashgame-user-id"];
  if (Array.isArray(value)) {
    return optionalUUID(value[0], "x-flashgame-user-id");
  }
  return optionalUUID(value, "x-flashgame-user-id");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
