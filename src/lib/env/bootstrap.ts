/**
 * Loads environment variables from .env files when running standalone scripts (tsx/node),
 * matching Next.js behavior (loads .env, .env.local, etc).
 *
 * Safe to import multiple times; it will just re-run loadEnvConfig.
 */

import { loadEnvConfig } from '@next/env';

// Use current working directory so it works when running from repo root.
loadEnvConfig(process.cwd());

