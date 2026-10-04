import { z } from 'zod';

/**
 * Configuration. A missing secret is a refusal to boot, not a warning and not a generated default:
 * a half-working instance that hashes passwords with a pepper nobody chose looks healthy and is not.
 */

const PLACEHOLDERS = new Set(['change-me', 'changeme', 'secret', 'todo', 'xxx']);

/** 32 random bytes, base64 (`openssl rand -base64 32`). Anything shorter is not a key. */
const secret = (name: string) =>
  z
    .string()
    .min(1, `${name} is empty`)
    .refine((v) => !PLACEHOLDERS.has(v.trim().toLowerCase()), {
      message: `${name} is still the placeholder from .env.example`,
    })
    .refine((v) => Buffer.from(v, 'base64').length >= 32, {
      message: `${name} must decode to at least 32 bytes (openssl rand -base64 32)`,
    });

/** An empty string in an env file means "not set", which is how compose env files say it. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3400),
  /** The origin people reach the app at. Decides cookie security and the OIDC redirect URI. */
  PUBLIC_URL: z.url({ error: 'PUBLIC_URL must be an absolute URL' }),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
    }),

  /** Key-encryption key: wraps TOTP secrets at rest. */
  KEK: secret('KEK'),
  /** Server-side pepper mixed into every password hash; never stored beside the hash. */
  PEPPER: secret('PEPPER'),

  /**
   * Sign in with D3 Auth. Optional on purpose: unset, the app runs password-only and the sign-in
   * screen shows no D3 Auth button.
   */
  D3AUTH_ISSUER: optional(z.url()),
  D3AUTH_CLIENT_ID: optional(z.string()),
  D3AUTH_CLIENT_SECRET: optional(z.string()),

  /**
   * A one-time secret first-run setup must present. Set on any instance reachable from the internet
   * before it is first started, so the person who installs it — not whoever reaches the address
   * first — becomes the operator. Unset, setup is open, which is fine on a laptop.
   */
  SETUP_TOKEN: optional(z.string().min(24, { error: 'SETUP_TOKEN must be at least 24 characters' })),

  /** How long an invite link stays usable. Re-issued rather than extended once it lapses. */
  INVITE_TTL_HOURS: z.coerce.number().int().positive().max(720).default(168),

  /** Where the pre-migration dump is written on boot. */
  BACKUP_DIR: z.string().default('./backups'),
  /**
   * Take a pg_dump before applying migrations. On in the image, which carries a pinned client;
   * off in development, where a host pg_dump may not match the server's major version.
   */
  PREMIGRATION_DUMP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** The built editor. Set in the image; absent in development, where Vite serves it. */
  WEB_DIST: optional(z.string()),
});

export type Config = z.infer<typeof Env> & {
  /** True when all three D3 Auth settings are present. */
  readonly oidcConfigured: boolean;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration refused:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse an environment. Pure, so tests can vary one variable at a time. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.');
      if (name.length === 0) return issue.message;
      const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
      return missing ? `${name} is not set` : `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  const value = parsed.data;
  const present = [value.D3AUTH_ISSUER, value.D3AUTH_CLIENT_ID, value.D3AUTH_CLIENT_SECRET].filter(
    (v) => v !== undefined,
  ).length;
  // Half-configured is worse than unconfigured: it fails at the redirect rather than at boot.
  if (present !== 0 && present !== 3) {
    throw new ConfigError([
      'D3AUTH_ISSUER, D3AUTH_CLIENT_ID and D3AUTH_CLIENT_SECRET must be set together, or not at all',
    ]);
  }
  return { ...value, oidcConfigured: present === 3 };
}

/** True when cookies must carry `Secure` — everywhere but local HTTP. */
export function isSecureOrigin(config: Pick<Config, 'PUBLIC_URL'>): boolean {
  return config.PUBLIC_URL.startsWith('https://');
}
