/* eslint-disable */
// Settings for the dev scripts: .env next to package.json (or the shell) - never built-in values.
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env: the variables may come from the shell instead.
}

/** The named settings, or exit with a message naming the missing ones. */
function requireEnv(...keys) {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    console.error(`Set ${missing.join(', ')} in .env (copy .env.example).`);
    process.exit(1);
  }
  return Object.fromEntries(keys.map((key) => [key, process.env[key].trim()]));
}

module.exports = { requireEnv };
