import { describe, expect, it } from 'vitest';
import { S3ObjectStorage } from './object-storage';

// Presigning is a local computation: no network or bucket is needed for these checks.
const storage = new S3ObjectStorage({
  S3_ENDPOINT: 'http://localhost:8333',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'unit-test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_FORCE_PATH_STYLE: true,
});

describe('S3ObjectStorage.presignPut', () => {
  it('does not embed a body checksum (it would never match the real upload)', async () => {
    const { url } = await storage.presignPut('avatars/u/1.jpg', {
      contentType: 'image/jpeg',
      contentLength: 1234,
      expiresInSeconds: 300,
    });
    const params = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase());
    expect(params.some((k) => k.startsWith('x-amz-checksum'))).toBe(false);
    expect(params).not.toContain('x-amz-sdk-checksum-algorithm');
  });

  it('signs content type and length, so a different file cannot reuse the URL', async () => {
    const { url, headers } = await storage.presignPut('avatars/u/1.jpg', {
      contentType: 'image/jpeg',
      contentLength: 1234,
      expiresInSeconds: 300,
    });
    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toEqual(expect.arrayContaining(['content-type', 'content-length']));
    expect(headers).toEqual({ 'content-type': 'image/jpeg', 'content-length': '1234' });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
  });
});
