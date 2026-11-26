import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../../config/env';

export interface ObjectMetadata {
  contentType: string | undefined;
  contentLength: number | undefined;
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

/**
 * Private object storage. Clients never get bucket credentials: uploads and downloads use
 * short-lived presigned URLs scoped to a single object.
 */
export interface ObjectStorage {
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  head(key: string): Promise<ObjectMetadata | null>;
  delete(key: string): Promise<void>;
  /** Every object under a prefix (paginated internally). For maintenance jobs, not requests. */
  list(prefix: string): Promise<StoredObject[]>;
}

export type StorageConfig = Pick<
  Env,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
>;

/** AWS S3 or any S3-compatible service (MinIO locally, Cloudflare R2, Scaleway, ...). */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      // The SDK's default ("WHEN_SUPPORTED") embeds a CRC32 of the request body in presigned
      // PUT URLs. At signing time the body is empty, so every real upload would then fail with
      // BadDigest (on AWS S3 as well). Only compute checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      // Without explicit keys the SDK uses the default chain (e.g. an IAM role in production).
      ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });
    // Content-Type and Content-Length are part of the signature: the upload must match them.
    const url = await getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      headers: {
        'content-type': options.contentType,
        'content-length': String(options.contentLength),
      },
    };
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { contentType: result.ContentType, contentLength: result.ContentLength };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === 'NotFound')
        return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key && o.LastModified) objects.push({ key: o.Key, lastModified: o.LastModified });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }
}

/** Test double. `put` simulates the client's direct upload to the presigned URL. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, ObjectMetadata>();
  private readonly modified = new Map<string, Date>();

  put(key: string, metadata: ObjectMetadata, lastModified: Date = new Date()): void {
    this.objects.set(key, metadata);
    this.modified.set(key, lastModified);
  }

  presignPut(
    key: string,
    options: { contentType: string; contentLength: number },
  ): Promise<{ url: string; headers: Record<string, string> }> {
    return Promise.resolve({
      url: `https://storage.test/${encodeURIComponent(key)}?signature=put`,
      headers: {
        'content-type': options.contentType,
        'content-length': String(options.contentLength),
      },
    });
  }

  presignGet(key: string): Promise<string> {
    return Promise.resolve(`https://storage.test/${encodeURIComponent(key)}?signature=get`);
  }

  head(key: string): Promise<ObjectMetadata | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.modified.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<StoredObject[]> {
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, lastModified: this.modified.get(key) ?? new Date(0) })),
    );
  }
}
