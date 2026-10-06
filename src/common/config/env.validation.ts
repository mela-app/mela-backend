// Where things are and who may call - no built-in value for any of them.
const REQUIRED = [
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'CORS_ORIGIN',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'APP_URL_SCHEME',
  'ANDROID_APP_PACKAGE_NAME',
  'S3_REGION',
  // Checks sign-up identity tokens (docs/features/auth.md) - every new account needs one.
  'FIREBASE_PROJECT_ID',
] as const;

// The sample values in .env.example and the LiveKit dev server's key pair.
const PLACEHOLDER = /change-me|devsecret|development-only/i;
const MIN_SECRET_LENGTH = 32;

/**
 * Fails fast at boot (ConfigModule `validate`) rather than on the first
 * request. Production must also replace every sample secret.
 */
export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  const value = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  const problems = REQUIRED.filter((key) => !value(key)).map((key) => `${key} is not set`);

  if (value('NODE_ENV') === 'production') {
    const secrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'LIVEKIT_API_SECRET'];
    for (const key of secrets) {
      const secret = value(key);
      if (secret && (PLACEHOLDER.test(secret) || secret.length < MIN_SECRET_LENGTH)) {
        problems.push(
          `${key} must be a random value of at least ${MIN_SECRET_LENGTH} characters, not a sample`,
        );
      }
    }
    if (value('JWT_ACCESS_SECRET') && value('JWT_ACCESS_SECRET') === value('JWT_REFRESH_SECRET')) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment:\n - ${problems.join('\n - ')}`);
  }
  return env;
}
