export interface UploadUrl {
  /** Presigned PUT - upload the file bytes here directly; the API never sees them. */
  uploadUrl: string;
  /** Where the object is readable once the upload completes. */
  publicUrl: string;
}

/** DI token: `StorageProvider` is an interface, so it needs one to bind to (see storage.module.ts). */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/**
 * Media storage (avatars today) behind one interface, so the vendor - S3Mock
 * in dev, S3/R2 in production, same API - is a config choice, not a code
 * change (plan §4.1). See docs/features/storage.md.
 */
export interface StorageProvider {
  /** A short-lived presigned upload for one object at `key`. */
  createUploadUrl(key: string, contentType: string): Promise<UploadUrl>;
  /** Where the object at `key` is readable. */
  publicUrl(key: string): string;
  /**
   * Deletes the objects behind these public URLs, skipping any that aren't this
   * bucket's. Best effort: a failure is logged, never thrown.
   */
  deleteUrls(urls: string[]): Promise<void>;
}
