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

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function requiredStorageEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required when object storage is configured`);
  }
  return value;
}

function loadObjectStorageConfig(): ObjectStorageConfig | null {
  const bucket = optionalEnv("OBJECT_STORAGE_BUCKET");
  const endpoint = optionalEnv("OBJECT_STORAGE_ENDPOINT");
  const accessKeyId = optionalEnv("OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY");

  if (!bucket && !endpoint && !accessKeyId && !secretAccessKey) {
    return null;
  }

  return {
    bucket: requiredStorageEnv("OBJECT_STORAGE_BUCKET"),
    region: optionalEnv("OBJECT_STORAGE_REGION") ?? "auto",
    endpoint,
    accessKeyId: requiredStorageEnv("OBJECT_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: requiredStorageEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    publicBaseUrl: optionalEnv("OBJECT_STORAGE_PUBLIC_BASE_URL"),
    forcePathStyle: (optionalEnv("OBJECT_STORAGE_FORCE_PATH_STYLE") ?? "true") !== "false",
    uploadUrlExpiresSeconds: Number(optionalEnv("UPLOAD_URL_EXPIRES_SECONDS") ?? 900),
  };
}

export function loadConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new Error("ADMIN_API_KEY is required");
  }
  const householdSyncToken = process.env.HOUSEHOLD_SYNC_TOKEN;
  if (!householdSyncToken) {
    throw new Error("HOUSEHOLD_SYNC_TOKEN is required");
  }

  return {
    databaseUrl,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    adminApiKey,
    householdSyncToken,
    localMediaRoot: optionalEnv("LOCAL_MEDIA_ROOT") ?? "uploads",
    objectStorage: loadObjectStorageConfig(),
  };
}
