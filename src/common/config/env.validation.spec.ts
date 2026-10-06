import { validateEnv } from './env.validation';

const DEV = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'change-me-access-secret',
  JWT_REFRESH_SECRET: 'change-me-refresh-secret',
  APP_URL_SCHEME: 'gamblinglive',
  ANDROID_APP_PACKAGE_NAME: 'com.gamblinglive.app',
  S3_REGION: 'us-east-1',
  FIREBASE_PROJECT_ID: 'mela-dev',
};

const PROD = {
  ...DEV,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://db/prod',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CORS_ORIGIN: 'https://admin.example.com',
};

describe('validateEnv', () => {
  it('accepts the sample secrets during development', () => {
    expect(() => validateEnv(DEV)).not.toThrow();
  });

  it('reports every missing required variable', () => {
    expect(() => validateEnv({})).toThrow(
      /PORT is not set[\s\S]*DATABASE_URL is not set[\s\S]*REDIS_URL is not set[\s\S]*CORS_ORIGIN is not set[\s\S]*JWT_ACCESS_SECRET is not set[\s\S]*APP_URL_SCHEME is not set[\s\S]*ANDROID_APP_PACKAGE_NAME is not set[\s\S]*S3_REGION is not set[\s\S]*FIREBASE_PROJECT_ID is not set/,
    );
  });

  it('has no built-in address or origin: each one must be set, in development too', () => {
    for (const key of [
      'PORT',
      'REDIS_URL',
      'CORS_ORIGIN',
      'APP_URL_SCHEME',
      'ANDROID_APP_PACKAGE_NAME',
      'S3_REGION',
      'FIREBASE_PROJECT_ID',
    ]) {
      expect(() => validateEnv({ ...DEV, [key]: ' ' })).toThrow(new RegExp(`${key} is not set`));
    }
  });

  it('accepts a properly configured production environment', () => {
    expect(() => validateEnv(PROD)).not.toThrow();
  });

  it('refuses sample or short secrets in production', () => {
    expect(() => validateEnv({ ...PROD, JWT_ACCESS_SECRET: 'change-me-access-secret' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() =>
      validateEnv({ ...PROD, LIVEKIT_API_SECRET: 'devsecret-for-local-development-only' }),
    ).toThrow(/LIVEKIT_API_SECRET/);
    expect(() => validateEnv({ ...PROD, JWT_REFRESH_SECRET: 'short' })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('refuses one secret for both token kinds in production', () => {
    expect(() => validateEnv({ ...PROD, JWT_REFRESH_SECRET: PROD.JWT_ACCESS_SECRET })).toThrow(
      /must differ/,
    );
  });

  it('requires the allowed browser origins in production', () => {
    expect(() => validateEnv({ ...PROD, CORS_ORIGIN: '' })).toThrow(/CORS_ORIGIN is not set/);
  });
});
