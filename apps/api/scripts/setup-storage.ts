/**
 * Creates the private bucket for local development (idempotent):
 *   pnpm --filter @tw/api storage:setup
 * Staging/production buckets are provisioned with infrastructure tooling, not this script.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv } from '../src/config/env';

const env = loadEnv();
if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
  console.error('storage:setup is for local development only');
  process.exit(1);
}

const client = new S3Client({
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

try {
  await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  console.log(`Bucket ${env.S3_BUCKET} already exists.`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  console.log(`Created private bucket ${env.S3_BUCKET}.`);
}
