import crypto from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';

interface ParsedPgConfig {
  signature: string;
  poolConfig: PoolConfig;
  fallbackSeed: string;
}

declare global {
  var _sgpPgPool: Pool | undefined;
  var _sgpPgPoolSig: string | undefined;
  var _sgpPgSchemaPromise: Promise<void> | undefined;
}

function getPgEnvUrl(): string {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.NEON_DATABASE_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
  ];
  for (const raw of candidates) {
    const val = String(raw || '').trim();
    if (!val) continue;
    if (val.startsWith('postgres://') || val.startsWith('postgresql://')) {
      return val;
    }
  }
  return '';
}

function resolveSslOption(
  sslModeRaw: string | null,
  host: string
): boolean | { rejectUnauthorized: boolean } {
  const mode = String(sslModeRaw || '').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  const lowerHost = host.toLowerCase();
  const isLocal =
    lowerHost === 'localhost' || lowerHost === '127.0.0.1' || lowerHost === '::1';
  if (isLocal && !mode) return false;
  return { rejectUnauthorized: true };
}

function getParsedPgConfig(): ParsedPgConfig | null {
  const rawUrl = getPgEnvUrl();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname;
      const database = parsed.pathname.replace(/^\/+/, '');
      const user = decodeURIComponent(parsed.username || '');
      const password = decodeURIComponent(parsed.password || '');
      const port = parsed.port ? Number(parsed.port) : 5432;
      if (host && database && user && Number.isFinite(port) && port > 0) {
        const ssl = resolveSslOption(parsed.searchParams.get('sslmode'), host);
        return {
          signature: `${host}:${port}/${database}:${user}:${String(ssl)}`,
          poolConfig: {
            host,
            port,
            user,
            password,
            database,
            ssl,
            max: 5,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 10000,
          },
          fallbackSeed: crypto.createHash('sha256').update(rawUrl, 'utf8').digest('hex'),
        };
      }
    } catch {
      // Ignore malformed connection URL
    }
  }

  const host = String(process.env.PGHOST || '').trim();
  const user = String(process.env.PGUSER || '').trim();
  const password = String(process.env.PGPASSWORD || '').trim();
  const database = String(process.env.PGDATABASE || '').trim();
  const port = Number(process.env.PGPORT || 5432);
  if (host && user && password && database && Number.isFinite(port) && port > 0) {
    const ssl = resolveSslOption(process.env.PGSSLMODE || null, host);
    return {
      signature: `${host}:${port}/${database}:${user}:${String(ssl)}`,
      poolConfig: {
        host,
        port,
        user,
        password,
        database,
        ssl,
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
      },
      fallbackSeed: crypto
        .createHash('sha256')
        .update(`${host}:${port}:${database}:${user}:${password}`, 'utf8')
        .digest('hex'),
    };
  }

  return null;
}

export function hasPostgresConfig(): boolean {
  return Boolean(getParsedPgConfig());
}

export function getPostgresFallbackSeed(): string {
  return getParsedPgConfig()?.fallbackSeed || '';
}

function getPool(): Pool | null {
  const cfg = getParsedPgConfig();
  if (!cfg) return null;
  if (!globalThis._sgpPgPool || globalThis._sgpPgPoolSig !== cfg.signature) {
    const prevPool = globalThis._sgpPgPool;
    if (prevPool) {
      void prevPool.end().catch(() => {});
    }
    const pool = new Pool(cfg.poolConfig);
    pool.on('error', (err) => {
      console.error('PostgreSQL pool error:', err instanceof Error ? err.message : 'unknown');
    });
    globalThis._sgpPgPool = pool;
    globalThis._sgpPgPoolSig = cfg.signature;
    globalThis._sgpPgSchemaPromise = undefined;
  }
  return globalThis._sgpPgPool;
}

async function ensureStoreTable(pool: Pool): Promise<void> {
  if (!globalThis._sgpPgSchemaPromise) {
    globalThis._sgpPgSchemaPromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS sgp_store (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      )
      .then(() => undefined)
      .catch((err) => {
        globalThis._sgpPgSchemaPromise = undefined;
        throw err;
      });
  }
  await globalThis._sgpPgSchemaPromise;
}

export async function pgGetJson<T>(key: string): Promise<{ hit: boolean; value: T | null }> {
  const pool = getPool();
  if (!pool) return { hit: false, value: null };
  try {
    await ensureStoreTable(pool);
    const result = await pool.query<{ value: unknown }>(
      'SELECT value FROM sgp_store WHERE key = $1 LIMIT 1',
      [key]
    );
    if (!result.rows.length) {
      return { hit: true, value: null };
    }
    const raw = result.rows[0].value;
    if (typeof raw === 'string') {
      return { hit: true, value: JSON.parse(raw) as T };
    }
    return { hit: true, value: (raw ?? null) as T | null };
  } catch (err) {
    console.error('PostgreSQL read error:', err instanceof Error ? err.message : 'unknown');
    return { hit: false, value: null };
  }
}

export async function pgSetJson(key: string, value: unknown): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await ensureStoreTable(pool);
    await pool.query(
      `INSERT INTO sgp_store (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (err) {
    console.error('PostgreSQL write error:', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

export async function pgSetNxJson(key: string, value: unknown): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await ensureStoreTable(pool);
    const res = await pool.query<{ key: string }>(
      `INSERT INTO sgp_store (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, JSON.stringify(value)]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('PostgreSQL write-if-absent error:', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}
