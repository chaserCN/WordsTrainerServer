export type ApiError = {
  error: string;
  message: string;
};

export class HttpError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export function notImplemented(message: string): ApiError {
  return {
    error: "not_implemented",
    message,
  };
}

export function badRequest(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

export function notFound(message: string): never {
  throw new HttpError(404, "not_found", message);
}

export function unauthorized(message = "Unauthorized"): never {
  throw new HttpError(401, "unauthorized", message);
}

export function tooManyRequests(message = "Too many requests"): never {
  throw new HttpError(429, "rate_limited", message);
}

export function serviceUnavailable(message: string): never {
  throw new HttpError(503, "service_unavailable", message);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    badRequest(`${field} is required`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    badRequest(`${field} must be a string`);
  }
  return value.trim();
}

export function optionalNumber(value: unknown, field: string): number | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    badRequest(`${field} must be a finite number`);
  }
  return value;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requiredUUID(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!uuidPattern.test(text)) {
    badRequest(`${field} must be a UUID`);
  }
  return text.toLowerCase();
}

export function optionalUUID(value: unknown, field: string): string | null {
  const text = optionalString(value, field);
  if (text == null) {
    return null;
  }
  if (!uuidPattern.test(text)) {
    badRequest(`${field} must be a UUID`);
  }
  return text.toLowerCase();
}
