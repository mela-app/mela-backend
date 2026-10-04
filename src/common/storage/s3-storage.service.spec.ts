import { ConfigService } from '@nestjs/config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3StorageProvider } from './s3-storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('S3StorageProvider', () => {
  const values: Record<string, string> = {
    S3_BUCKET: 'avatars',
    S3_PUBLIC_URL_BASE: 'http://localhost:9000/avatars',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
  };
  const config = (overrides: Record<string, string> = {}) => {
    const get = (key: string) => overrides[key] ?? values[key];
    const getOrThrow = (key: string) => {
      const value = get(key);
      if (value === undefined) throw new Error(`${key} is not set`);
      return value;
    };
    return { get, getOrThrow } as unknown as ConfigService;
  };

  beforeEach(() => jest.clearAllMocks());

  it('returns a presigned upload url and the eventual public url', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://signed.example/put');

    const result = await new S3StorageProvider(config()).createUploadUrl(
      'avatars/u1/abc.jpg',
      'image/jpeg',
    );

    expect(result).toEqual({
      uploadUrl: 'https://signed.example/put',
      publicUrl: 'http://localhost:9000/avatars/avatars/u1/abc.jpg',
    });
  });

  it('never double-slashes when the public url base has a trailing slash', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://signed.example/put');

    const result = await new S3StorageProvider(
      config({ S3_PUBLIC_URL_BASE: `${values.S3_PUBLIC_URL_BASE}/` }),
    ).createUploadUrl('a/b.jpg', 'image/jpeg');

    expect(result.publicUrl).toBe('http://localhost:9000/avatars/a/b.jpg');
  });

  it('knows where an object is readable without signing anything', () => {
    expect(new S3StorageProvider(config()).publicUrl('chat-images/live/x.jpg')).toBe(
      'http://localhost:9000/avatars/chat-images/live/x.jpg',
    );
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs an Amazon S3 upload without pinning a body checksum', async () => {
    const actual = jest.requireActual<{ getSignedUrl: typeof getSignedUrl }>(
      '@aws-sdk/s3-request-presigner',
    );
    (getSignedUrl as jest.Mock).mockImplementationOnce(actual.getSignedUrl);

    const { uploadUrl } = await new S3StorageProvider(config({ S3_ENDPOINT: '' })).createUploadUrl(
      'avatars/u1/abc.jpg',
      'image/jpeg',
    );

    const params = [...new URL(uploadUrl).searchParams.keys()];
    expect(params).toContain('X-Amz-Signature');
    expect(params.filter((key) => key.toLowerCase().includes('checksum'))).toEqual([]);
  });
});
