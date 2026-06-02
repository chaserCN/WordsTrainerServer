import "dotenv/config";

export type AppConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  adminApiKey: string;
  householdSyncToken: string;
  localMediaRoot: string;
  objectStorage: ObjectStorageConfig | null;
};

export type ObjectStorageConfig = {
  bucket: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string | null;
  forcePathStyle: boolean;
  uploadUrlExpiresSeconds: number;
};

const maxUploadUrlExpiresSeconds = 7 * 24 * 60 * 60;

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateUrl(value: string, name: string, allowedProtocols: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${name} must use one of: ${allowedProtocols.join(", ")}`);
  }
  return value;
}

function requiredSecretEnv(name: string, minLength: number): string {
  const value = requiredEnv(name);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters long`);
  }
  return value;
}

function requiredStorageEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required when object storage is configured`);
  }
  return value;
}

function optionalIntegerEnv(name: string, defaultValue: number, min: number, max?: number): number {
  const rawValue = optionalEnv(name);
  if (!rawValue) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || (max != null && value > max)) {
    const maxMessage = max == null ? "" : ` and <= ${max}`;
    throw new Error(`${name} must be an integer >= ${min}${maxMessage}`);
  }
  return value;
}

function loadObjectStorageConfig(): ObjectStorageConfig | null {
  const bucket = optionalEnv("OBJECT_STORAGE_BUCKET");
  const endpoint = optionalEnv("OBJECT_STORAGE_ENDPOINT");
  const publicBaseUrl = optionalEnv("OBJECT_STORAGE_PUBLIC_BASE_URL");
  const accessKeyId = optionalEnv("OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY");

  if (!bucket && !endpoint && !accessKeyId && !secretAccessKey) {
    return null;
  }

  return {
    bucket: requiredStorageEnv("OBJECT_STORAGE_BUCKET"),
    region: optionalEnv("OBJECT_STORAGE_REGION") ?? "auto",
    endpoint: endpoint ? validateUrl(endpoint, "OBJECT_STORAGE_ENDPOINT", ["http:", "https:"]) : null,
    accessKeyId: requiredStorageEnv("OBJECT_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: requiredStorageEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    publicBaseUrl: publicBaseUrl
      ? validateUrl(publicBaseUrl, "OBJECT_STORAGE_PUBLIC_BASE_URL", ["http:", "https:"])
      : null,
    forcePathStyle: (optionalEnv("OBJECT_STORAGE_FORCE_PATH_STYLE") ?? "true") !== "false",
    uploadUrlExpiresSeconds: optionalIntegerEnv(
      "UPLOAD_URL_EXPIRES_SECONDS",
      900,
      1,
      maxUploadUrlExpiresSeconds,
    ),
  };
}

export function loadConfig(): AppConfig {
  const databaseUrl = validateUrl(requiredEnv("DATABASE_URL"), "DATABASE_URL", ["postgres:", "postgresql:"]);
  const adminApiKey = requiredSecretEnv("ADMIN_API_KEY", 12);
  const householdSyncToken = requiredSecretEnv("HOUSEHOLD_SYNC_TOKEN", 16);

  return {
    databaseUrl,
    host: optionalEnv("HOST") ?? "0.0.0.0",
    port: optionalIntegerEnv("PORT", 3000, 1, 65535),
    adminApiKey,
    householdSyncToken,
    localMediaRoot: optionalEnv("LOCAL_MEDIA_ROOT") ?? "uploads",
    objectStorage: loadObjectStorageConfig(),
  };
}
