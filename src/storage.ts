import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorageConfig } from "./config.js";
import { serviceUnavailable } from "./http.js";

export type UploadUrlRequest = {
  storageKey: string;
  mimeType: string;
};

export type UploadUrl = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresInSeconds: number;
  publicUrl: string | null;
};

export class ObjectStorageService {
  private readonly client: S3Client | null;

  constructor(private readonly config: ObjectStorageConfig | null) {
    this.client = config
      ? new S3Client({
          region: config.region,
          endpoint: config.endpoint ?? undefined,
          forcePathStyle: config.forcePathStyle,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        })
      : null;
  }

  async createUploadUrl(request: UploadUrlRequest): Promise<UploadUrl> {
    if (!this.config || !this.client) {
      serviceUnavailable("object storage is not configured");
    }

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: request.storageKey,
      ContentType: request.mimeType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.config.uploadUrlExpiresSeconds,
    });

    return {
      url,
      method: "PUT",
      headers: {
        "Content-Type": request.mimeType,
      },
      expiresInSeconds: this.config.uploadUrlExpiresSeconds,
      publicUrl: this.publicUrl(request.storageKey),
    };
  }

  async createDownloadUrl(storageKey: string): Promise<string | null> {
    if (!this.config || !this.client) {
      return null;
    }

    const publicUrl = this.publicUrl(storageKey);
    if (publicUrl) {
      return publicUrl;
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.config.uploadUrlExpiresSeconds,
    });
  }

  publicUrl(storageKey: string): string | null {
    if (!this.config?.publicBaseUrl) {
      return null;
    }
    return `${this.config.publicBaseUrl.replace(/\/+$/, "")}/${storageKey}`;
  }
}
