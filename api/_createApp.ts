import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { getPostgresFallbackSeed, hasPostgresConfig, pgCasWarehouseState, pgGetJson, pgSetJson, pgSetNxJson } from './_postgres.js';

type AppRole = 'admin' | 'super_admin';
type AppAuthRole = 'stockkeeper' | AppRole;
export type StorageMode = 'postgres' | 'redis' | 'file' | 'ephemeral';

interface StoredPinRecord {
  adminHash: string;
  superAdminHash: string;
  updatedAt: string;
}

interface StoredAuthRecord {
  email: string;
  passwordHash: string;
  updatedAt: string;
}

interface StoredOperatorUser {
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

interface EnvOperatorUser {
  email: string;
  password: string;
  name: string;
}

interface WarehouseMetaRecord {
  id: string;
  nama: string;
  legacy?: boolean;
}

interface SharedWarehouseState {
  revision: number;
  updatedAt: number;
  updatedBy: string;
  warehousesMeta: WarehouseMetaRecord[];
  warehouses: Record<string, Record<string, unknown>>;
}

interface PinSessionPayload {
  role: AppRole;
  iat: number;
  exp: number;
}

interface AppAuthSessionPayload {
  sub: string;
  role: AppAuthRole;
  iat: number;
  exp: number;
  remember?: boolean;
  pwv?: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEVICE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SLIDING_RENEWAL_INTERVAL_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_RATE_ENTRIES = 5000;

let cachedSessionSecret: Buffer | null = null;
const ephemSessionSecret = crypto.randomBytes(32);
let memoryPinStore: StoredPinRecord | null = null;
let memoryAuthStore: StoredAuthRecord | null = null;
let memoryOperatorUsers: StoredOperatorUser[] | null = null;
let memoryWarehouseState: SharedWarehouseState | null = null;
const failedAttempts = new Map<string, { count: number; resetAt: number }>();

const DEFAULT_WAREHOUSE_STATE: SharedWarehouseState = {
  revision: 0,
  updatedAt: 0,
  updatedBy: '',
  warehousesMeta: [],
  warehouses: {},
};

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function getKvConfig(): { url: string; token: string } | null {
  const candidates: Array<{ url: string; token: string }> = [
    {
      url: String(process.env.KV_REST_API_URL || '').trim(),
      token: String(process.env.KV_REST_API_TOKEN || '').trim(),
    },
    {
      url: String(process.env.UPSTASH_REDIS_REST_URL || '').trim(),
      token: String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim(),
    },
  ];

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envVal) continue;
    if (envKey.endsWith('_REST_API_URL')) {
      const prefix = envKey.slice(0, -'_REST_API_URL'.length);
      if (prefix === 'KV' || prefix === 'UPSTASH_REDIS') continue;
      const tokenVal = String(process.env[`${prefix}_REST_API_TOKEN`] || '').trim();
      if (tokenVal) {
        candidates.push({ url: String(envVal).trim(), token: tokenVal });
      }
    } else if (envKey.endsWith('_REST_URL')) {
      const prefix = envKey.slice(0, -'_REST_URL'.length);
      if (prefix === 'UPSTASH_REDIS') continue;
      const tokenVal = String(process.env[`${prefix}_REST_TOKEN`] || '').trim();
      if (tokenVal) {
        candidates.push({ url: String(envVal).trim(), token: tokenVal });
      }
    }
  }

  for (const item of candidates) {
    if (!item.url || !item.token) continue;
    try {
      const parsed = new URL(item.url);
      if (parsed.protocol === 'https:') {
        return { url: parsed.toString().replace(/\/+$/, ''), token: item.token };
      }
    } catch {
      // Ignore malformed candidate URL
    }
  }
  return null;
}

function getStorageMode(): StorageMode {
  if (hasPostgresConfig()) return 'postgres';
  if (getKvConfig()) return 'redis';
  if (process.env.VERCEL) return 'ephemeral';
  return 'file';
}

function hasStrongSessionSecret(): boolean {
  const configured = String(process.env.PIN_SESSION_SECRET || process.env.SESSION_SECRET || '').trim();
  return configured.length >= 16 || hasPostgresConfig() || Boolean(getKvConfig());
}

async function kvGetJson<T>(key: string): Promise<{ hit: boolean; value: T | null }> {
  const kv = getKvConfig();
  if (!kv) return { hit: false, value: null };
  try {
    const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${kv.token}`,
      },
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
    });
    if (!res.ok) return { hit: false, value: null };
    const payload = (await res.json()) as { result?: unknown };
    if (payload.result === null || payload.result === undefined) {
      return { hit: true, value: null };
    }
    if (typeof payload.result === 'string') {
      return { hit: true, value: JSON.parse(payload.result) as T };
    }
    return { hit: true, value: payload.result as T };
  } catch {
    return { hit: false, value: null };
  }
}

async function kvSetJson(key: string, value: unknown): Promise<boolean> {
  const kv = getKvConfig();
  if (!kv) return false;
  try {
    const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kv.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: JSON.stringify(value),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function kvSetNxJson(key: string, value: unknown): Promise<boolean> {
  const kv = getKvConfig();
  if (!kv) return false;
  try {
    const res = await fetch(kv.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kv.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', key, JSON.stringify(value), 'NX']),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
    });
    if (!res.ok) return false;
    const payload = (await res.json().catch(() => ({}))) as { result?: unknown };
    return payload.result === 'OK';
  } catch {
    return false;
  }
}

async function getSessionSecretAsync(): Promise<Buffer> {
  const configured = String(process.env.PIN_SESSION_SECRET || process.env.SESSION_SECRET || '').trim();
  if (configured.length >= 16) {
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
  }
  if (cachedSessionSecret) return cachedSessionSecret;

  // 1. Jika Neon/PostgreSQL terhubung, gunakan secret persisten bersama di Postgres
  if (hasPostgresConfig()) {
    const existingPg = await pgGetJson<{ hex?: string }>('sgp:system:session_secret');
    if (existingPg.hit && existingPg.value && typeof existingPg.value.hex === 'string' && /^[0-9a-f]{64}$/i.test(existingPg.value.hex)) {
      cachedSessionSecret = Buffer.from(existingPg.value.hex, 'hex');
      return cachedSessionSecret;
    }
    if (existingPg.hit) {
      const candidateHex = crypto.randomBytes(32).toString('hex');
      await pgSetNxJson('sgp:system:session_secret', { hex: candidateHex });
      const confirmPg = await pgGetJson<{ hex?: string }>('sgp:system:session_secret');
      if (confirmPg.hit && confirmPg.value && typeof confirmPg.value.hex === 'string' && /^[0-9a-f]{64}$/i.test(confirmPg.value.hex)) {
        cachedSessionSecret = Buffer.from(confirmPg.value.hex, 'hex');
        return cachedSessionSecret;
      }
      await pgSetJson('sgp:system:session_secret', { hex: candidateHex });
      cachedSessionSecret = Buffer.from(candidateHex, 'hex');
      return cachedSessionSecret;
    }
    const pgSeed = getPostgresFallbackSeed();
    if (pgSeed) {
      return crypto
        .createHmac('sha256', pgSeed)
        .update('scarlett-warehouse-pg-fallback-v1')
        .digest();
    }
  }

  // 2. Jika Redis/Vercel KV terhubung, gunakan secret persisten bersama di Redis agar semua lambda Vercel konsisten
  const kvCfg = getKvConfig();
  if (kvCfg) {
    let existingKv = await kvGetJson<{ hex?: string }>('sgp:system:session_secret');
    if (!existingKv.hit) {
      await new Promise((r) => setTimeout(r, 150));
      existingKv = await kvGetJson<{ hex?: string }>('sgp:system:session_secret');
    }
    if (existingKv.hit && existingKv.value && typeof existingKv.value.hex === 'string' && /^[0-9a-f]{64}$/i.test(existingKv.value.hex)) {
      cachedSessionSecret = Buffer.from(existingKv.value.hex, 'hex');
      return cachedSessionSecret;
    }
    if (existingKv.hit) {
      const candidateHex = crypto.randomBytes(32).toString('hex');
      await kvSetNxJson('sgp:system:session_secret', { hex: candidateHex });
      const confirmKv = await kvGetJson<{ hex?: string }>('sgp:system:session_secret');
      if (confirmKv.hit && confirmKv.value && typeof confirmKv.value.hex === 'string' && /^[0-9a-f]{64}$/i.test(confirmKv.value.hex)) {
        cachedSessionSecret = Buffer.from(confirmKv.value.hex, 'hex');
        return cachedSessionSecret;
      }
      await kvSetJson('sgp:system:session_secret', { hex: candidateHex });
      cachedSessionSecret = Buffer.from(candidateHex, 'hex');
      return cachedSessionSecret;
    }
    // Fallback deterministik berbasis KV token hanya jika koneksi Redis sempat gagal sementara
    return crypto
      .createHmac('sha256', kvCfg.token)
      .update('scarlett-warehouse-kv-fallback-v1')
      .digest();
  }

  // 2. Fallback file persisten lokal (.data / /tmp)
  const diskSecret = readJsonFromPaths<{ hex?: string }>('session-secret.json', 'sgp-session-secret.json');
  if (diskSecret && typeof diskSecret.hex === 'string' && /^[0-9a-f]{64}$/i.test(diskSecret.hex)) {
    cachedSessionSecret = Buffer.from(diskSecret.hex, 'hex');
    return cachedSessionSecret;
  }

  // 3. Jika di environment tanpa Redis dan tanpa file persisten, turunkan dari secret env server bila tersedia
  const envSeedParts = [
    String(process.env.APP_LOGIN_PASSWORD || '').trim(),
    String(process.env.APP_USERS_JSON || '').trim(),
    String(process.env.SUPER_ADMIN_BACKUP_PIN || '').trim(),
    String(process.env.ADMIN_BACKUP_PIN || '').trim(),
  ].filter(Boolean);
  if (envSeedParts.length > 0 && process.env.VERCEL) {
    cachedSessionSecret = crypto
      .createHmac('sha256', envSeedParts.join('|'))
      .update('scarlett-warehouse-session-v1')
      .digest();
    return cachedSessionSecret;
  }

  const generatedHex = crypto.randomBytes(32).toString('hex');
  writeJsonToPaths('session-secret.json', 'sgp-session-secret.json', { hex: generatedHex });
  cachedSessionSecret = Buffer.from(generatedHex, 'hex');
  return cachedSessionSecret || ephemSessionSecret;
}

function resolveDataPaths(primaryFilename: string, tmpFilename: string): [string, string] {
  const baseDir = path.resolve(process.cwd(), '.data');
  const primary = path.resolve(baseDir, primaryFilename);
  if (!primary.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid storage path');
  }
  const tmpBase = path.resolve('/tmp');
  const tmpPath = path.resolve(tmpBase, tmpFilename);
  if (!tmpPath.startsWith(tmpBase + path.sep)) {
    throw new Error('Invalid temporary storage path');
  }
  return [primary, tmpPath];
}

function readJsonFromPaths<T>(primaryFilename: string, tmpFilename: string): T | null {
  const paths = resolveDataPaths(primaryFilename, tmpFilename);
  for (const filePath of paths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      // Ignore unreadable or non-persistent path
    }
  }
  return null;
}

function writeJsonToPaths(primaryFilename: string, tmpFilename: string, value: unknown): void {
  const [primaryPath, tmpPath] = resolveDataPaths(primaryFilename, tmpFilename);
  const serialized = JSON.stringify(value);
  try {
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.writeFileSync(primaryPath, serialized, { mode: 0o600 });
    return;
  } catch {
    // Fallback to /tmp on read-only serverless filesystems
  }
  try {
    fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  } catch {
    // Keep in-memory copy if filesystem is locked
  }
}

function getEnvPins(): { adminPin: string; superAdminPin: string } | null {
  const adminPin = String(process.env.ADMIN_BACKUP_PIN || '').trim();
  const superAdminPin = String(process.env.SUPER_ADMIN_BACKUP_PIN || '').trim();
  if (adminPin.length >= 4 && superAdminPin.length >= 4 && adminPin !== superAdminPin) {
    return { adminPin, superAdminPin };
  }
  return null;
}

async function readStoredPins(): Promise<StoredPinRecord | null> {
  if (hasPostgresConfig()) {
    const pgRes = await pgGetJson<Partial<StoredPinRecord>>('sgp:pin:config');
    if (pgRes.hit) {
      const parsed = pgRes.value;
      if (
        parsed &&
        typeof parsed.adminHash === 'string' &&
        typeof parsed.superAdminHash === 'string' &&
        parsed.adminHash.includes(':') &&
        parsed.superAdminHash.includes(':')
      ) {
        memoryPinStore = {
          adminHash: parsed.adminHash,
          superAdminHash: parsed.superAdminHash,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
        return memoryPinStore;
      }
      memoryPinStore = null;
      return null;
    }
  }
  if (getKvConfig()) {
    const kvRes = await kvGetJson<Partial<StoredPinRecord>>('sgp:pin:config');
    if (kvRes.hit) {
      const parsed = kvRes.value;
      if (
        parsed &&
        typeof parsed.adminHash === 'string' &&
        typeof parsed.superAdminHash === 'string' &&
        parsed.adminHash.includes(':') &&
        parsed.superAdminHash.includes(':')
      ) {
        memoryPinStore = {
          adminHash: parsed.adminHash,
          superAdminHash: parsed.superAdminHash,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
        return memoryPinStore;
      }
      memoryPinStore = null;
      return null;
    }
  }
  if (memoryPinStore) return memoryPinStore;
  const parsed = readJsonFromPaths<Partial<StoredPinRecord>>('pin-config.json', 'sgp-pin-config.json');
  if (
    parsed &&
    typeof parsed.adminHash === 'string' &&
    typeof parsed.superAdminHash === 'string' &&
    parsed.adminHash.includes(':') &&
    parsed.superAdminHash.includes(':')
  ) {
    memoryPinStore = {
      adminHash: parsed.adminHash,
      superAdminHash: parsed.superAdminHash,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
    return memoryPinStore;
  }
  return null;
}

async function writeStoredPins(record: StoredPinRecord): Promise<void> {
  if (hasPostgresConfig()) {
    const ok = await pgSetJson('sgp:pin:config', record);
    if (!ok) {
      throw new Error('Gagal menyimpan PIN ke database PostgreSQL. Silakan coba lagi.');
    }
  } else if (getKvConfig()) {
    const ok = await kvSetJson('sgp:pin:config', record);
    if (!ok) {
      throw new Error('Gagal menyimpan PIN ke Redis / KV. Silakan coba lagi.');
    }
  }
  memoryPinStore = record;
  writeJsonToPaths('pin-config.json', 'sgp-pin-config.json', record);
}

async function writeStoredPinsIfAbsent(record: StoredPinRecord): Promise<boolean> {
  if (hasPostgresConfig()) {
    const existing = await pgGetJson<Partial<StoredPinRecord>>('sgp:pin:config');
    if (!existing.hit) {
      throw new Error('Koneksi ke database PostgreSQL sedang bermasalah. Silakan coba lagi.');
    }
    if (existing.value) return false;
    const claimed = await pgSetNxJson('sgp:pin:config', record);
    if (!claimed) return false;
  } else if (getKvConfig()) {
    const claimed = await kvSetNxJson('sgp:pin:config', record);
    if (!claimed) return false;
  } else if (memoryPinStore || readJsonFromPaths<Partial<StoredPinRecord>>('pin-config.json', 'sgp-pin-config.json')) {
    return false;
  }
  memoryPinStore = record;
  writeJsonToPaths('pin-config.json', 'sgp-pin-config.json', record);
  return true;
}

function getEnvAuth(): { email: string; password: string } | null {
  const email = String(process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.APP_LOGIN_PASSWORD || '').replace(/[\r\n]+/g, '');
  if (email.includes('@') && password.length >= 6) {
    return { email, password };
  }
  return null;
}

function getEnvUsers(): EnvOperatorUser[] {
  const raw = String(process.env.APP_USERS_JSON || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: EnvOperatorUser[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const email = String(rec.email || '').trim().toLowerCase();
      const password = String(rec.password || '').replace(/[\r\n]+/g, '');
      const name = String(rec.name || '').trim() || email.split('@')[0] || 'Operator';
      if (!email.includes('@') || password.length < 6 || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, password, name });
    }
    return out;
  } catch {
    return [];
  }
}

async function readStoredAuth(): Promise<StoredAuthRecord | null> {
  if (hasPostgresConfig()) {
    const pgRes = await pgGetJson<Partial<StoredAuthRecord>>('sgp:auth:primary');
    if (pgRes.hit) {
      const parsed = pgRes.value;
      if (
        parsed &&
        typeof parsed.email === 'string' &&
        parsed.email.includes('@') &&
        typeof parsed.passwordHash === 'string' &&
        parsed.passwordHash.includes(':')
      ) {
        memoryAuthStore = {
          email: parsed.email.trim().toLowerCase(),
          passwordHash: parsed.passwordHash,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
        return memoryAuthStore;
      }
      memoryAuthStore = null;
      return null;
    }
  }
  if (getKvConfig()) {
    const kvRes = await kvGetJson<Partial<StoredAuthRecord>>('sgp:auth:primary');
    if (kvRes.hit) {
      const parsed = kvRes.value;
      if (
        parsed &&
        typeof parsed.email === 'string' &&
        parsed.email.includes('@') &&
        typeof parsed.passwordHash === 'string' &&
        parsed.passwordHash.includes(':')
      ) {
        memoryAuthStore = {
          email: parsed.email.trim().toLowerCase(),
          passwordHash: parsed.passwordHash,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
        return memoryAuthStore;
      }
      memoryAuthStore = null;
      return null;
    }
  }
  if (memoryAuthStore) return memoryAuthStore;
  const parsed = readJsonFromPaths<Partial<StoredAuthRecord>>('auth-config.json', 'sgp-auth-config.json');
  if (
    parsed &&
    typeof parsed.email === 'string' &&
    parsed.email.includes('@') &&
    typeof parsed.passwordHash === 'string' &&
    parsed.passwordHash.includes(':')
  ) {
    memoryAuthStore = {
      email: parsed.email.trim().toLowerCase(),
      passwordHash: parsed.passwordHash,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
    return memoryAuthStore;
  }
  return null;
}

async function writeStoredAuthIfAbsent(record: StoredAuthRecord): Promise<boolean> {
  if (hasPostgresConfig()) {
    const existing = await pgGetJson<Partial<StoredAuthRecord>>('sgp:auth:primary');
    if (!existing.hit) {
      throw new Error('Koneksi ke database PostgreSQL sedang bermasalah. Silakan coba lagi.');
    }
    if (existing.value) return false;
    const claimed = await pgSetNxJson('sgp:auth:primary', record);
    if (!claimed) return false;
  } else if (getKvConfig()) {
    const claimed = await kvSetNxJson('sgp:auth:primary', record);
    if (!claimed) return false;
  } else if (memoryAuthStore || readJsonFromPaths<Partial<StoredAuthRecord>>('auth-config.json', 'sgp-auth-config.json')) {
    return false;
  }
  memoryAuthStore = record;
  writeJsonToPaths('auth-config.json', 'sgp-auth-config.json', record);
  return true;
}

function sanitizeOperatorUsers(raw: unknown): StoredOperatorUser[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredOperatorUser[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<StoredOperatorUser>;
    const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
    const passwordHash = typeof rec.passwordHash === 'string' ? rec.passwordHash : '';
    if (!email.includes('@') || !passwordHash.includes(':') || seen.has(email)) continue;
    seen.add(email);
    const now = new Date().toISOString();
    out.push({
      email,
      name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : email.split('@')[0],
      passwordHash,
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : now,
    });
  }
  return out;
}

async function readOperatorUsers(): Promise<StoredOperatorUser[]> {
  if (hasPostgresConfig()) {
    const pgRes = await pgGetJson<unknown>('sgp:auth:users');
    if (pgRes.hit) {
      const cleaned = sanitizeOperatorUsers(pgRes.value);
      memoryOperatorUsers = cleaned;
      return cleaned;
    }
  }
  if (getKvConfig()) {
    const kvRes = await kvGetJson<unknown>('sgp:auth:users');
    if (kvRes.hit) {
      const cleaned = sanitizeOperatorUsers(kvRes.value);
      memoryOperatorUsers = cleaned;
      return cleaned;
    }
  }
  if (memoryOperatorUsers) return memoryOperatorUsers;
  const fromDisk = readJsonFromPaths<unknown>('operator-users.json', 'sgp-operator-users.json');
  const cleaned = sanitizeOperatorUsers(fromDisk);
  memoryOperatorUsers = cleaned;
  return cleaned;
}

async function writeOperatorUsers(users: StoredOperatorUser[]): Promise<void> {
  if (hasPostgresConfig()) {
    const ok = await pgSetJson('sgp:auth:users', users);
    if (!ok) {
      throw new Error('Gagal menyimpan daftar operator ke database PostgreSQL.');
    }
  } else if (getKvConfig()) {
    const ok = await kvSetJson('sgp:auth:users', users);
    if (!ok) {
      throw new Error('Gagal menyimpan daftar operator ke Redis / KV.');
    }
  }
  memoryOperatorUsers = users;
  writeJsonToPaths('operator-users.json', 'sgp-operator-users.json', users);
}

function sanitizeWarehouseState(raw: unknown): SharedWarehouseState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_WAREHOUSE_STATE };
  }
  const obj = raw as Partial<SharedWarehouseState>;
  const revision =
    typeof obj.revision === 'number' && Number.isFinite(obj.revision) && obj.revision >= 0
      ? Math.floor(obj.revision)
      : 0;
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt >= 0
      ? obj.updatedAt
      : 0;
  const updatedBy = typeof obj.updatedBy === 'string' ? obj.updatedBy : '';
  const warehousesMeta: WarehouseMetaRecord[] = Array.isArray(obj.warehousesMeta)
    ? obj.warehousesMeta
        .filter((m): m is WarehouseMetaRecord => Boolean(m && typeof m.id === 'string' && typeof m.nama === 'string'))
        .map((m) => ({
          id: m.id.trim(),
          nama: m.nama.trim(),
          legacy: Boolean(m.legacy),
        }))
    : [];
  const warehouses: Record<string, Record<string, unknown>> = {};
  if (obj.warehouses && typeof obj.warehouses === 'object' && !Array.isArray(obj.warehouses)) {
    for (const [wid, wdata] of Object.entries(obj.warehouses)) {
      if (wdata && typeof wdata === 'object' && !Array.isArray(wdata)) {
        warehouses[wid] = wdata as Record<string, unknown>;
      }
    }
  }
  return { revision, updatedAt, updatedBy, warehousesMeta, warehouses };
}

async function readSharedWarehouseState(): Promise<SharedWarehouseState> {
  if (hasPostgresConfig()) {
    const pgRes = await pgGetJson<unknown>('sgp:warehouse:state');
    if (!pgRes.hit) {
      throw new Error('Koneksi ke database PostgreSQL sedang bermasalah. Coba beberapa saat lagi.');
    }
    const cleaned = sanitizeWarehouseState(pgRes.value);
    memoryWarehouseState = cleaned;
    return cleaned;
  }
  if (getKvConfig()) {
    const kvRes = await kvGetJson<unknown>('sgp:warehouse:state');
    if (kvRes.hit) {
      const cleaned = sanitizeWarehouseState(kvRes.value);
      memoryWarehouseState = cleaned;
      return cleaned;
    }
  }
  if (memoryWarehouseState) return memoryWarehouseState;
  const fromDisk = readJsonFromPaths<unknown>('warehouse-state.json', 'sgp-warehouse-state.json');
  const cleaned = sanitizeWarehouseState(fromDisk);
  memoryWarehouseState = cleaned;
  return cleaned;
}

async function writeSharedWarehouseState(state: SharedWarehouseState): Promise<void> {
  if (hasPostgresConfig()) {
    const ok = await pgSetJson('sgp:warehouse:state', state);
    if (!ok) {
      throw new Error('Gagal menyimpan data gudang ke database PostgreSQL.');
    }
  } else if (getKvConfig()) {
    const ok = await kvSetJson('sgp:warehouse:state', state);
    if (!ok) {
      throw new Error('Gagal menyimpan data gudang ke Redis / KV.');
    }
  }
  memoryWarehouseState = state;
  writeJsonToPaths('warehouse-state.json', 'sgp-warehouse-state.json', state);
}

async function writeSharedWarehouseStateCas(
  expectedRevision: number,
  state: SharedWarehouseState
): Promise<{ conflict: boolean }> {
  if (hasPostgresConfig()) {
    const cas = await pgCasWarehouseState('sgp:warehouse:state', expectedRevision, state);
    if (cas.conflict) return { conflict: true };
    if (!cas.ok) {
      throw new Error('Gagal menyimpan data gudang ke database PostgreSQL.');
    }
    memoryWarehouseState = state;
    writeJsonToPaths('warehouse-state.json', 'sgp-warehouse-state.json', state);
    return { conflict: false };
  }
  await writeSharedWarehouseState(state);
  return { conflict: false };
}

function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifySecretHash(secret: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hexDigest] = parts;
  if (!salt || !hexDigest) return false;
  const expected = Buffer.from(hexDigest, 'hex');
  const actual = crypto.scryptSync(secret, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function verifyPlainSecret(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function issueSessionToken(role: AppRole, secret: Buffer): { token: string; role: AppRole; expiresAt: number } {
  const now = Date.now();
  const payload: PinSessionPayload = {
    role,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, role, expiresAt: payload.exp };
}

function verifySessionToken(rawToken: string | null | undefined, secret: Buffer): PinSessionPayload | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PinSessionPayload;
    if (
      !parsed ||
      (parsed.role !== 'admin' && parsed.role !== 'super_admin') ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function computePasswordVersion(credentialMaterial: string): string {
  return crypto.createHash('sha256').update(`pwv:${credentialMaterial}`, 'utf8').digest('hex').slice(0, 16);
}

function issueAppAuthToken(
  email: string,
  role: AppAuthRole,
  secret: Buffer,
  rememberDevice = true,
  pwv = ''
): { token: string; email: string; role: AppAuthRole; expiresAt: number; rememberDevice: boolean } {
  const now = Date.now();
  const ttl = rememberDevice ? DEVICE_SESSION_TTL_MS : SESSION_TTL_MS;
  const payload: AppAuthSessionPayload = {
    sub: email.trim().toLowerCase(),
    role,
    iat: now,
    exp: now + ttl,
    remember: rememberDevice,
    ...(pwv ? { pwv } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`app:${body}`).digest('base64url');
  return { token: `${body}.${sig}`, email: payload.sub, role, expiresAt: payload.exp, rememberDevice };
}

function verifyAppAuthToken(rawToken: string | null | undefined, secret: Buffer): AppAuthSessionPayload | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', secret).update(`app:${body}`).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AppAuthSessionPayload;
    if (
      !parsed ||
      typeof parsed.sub !== 'string' ||
      !parsed.sub.includes('@') ||
      (parsed.role !== 'stockkeeper' && parsed.role !== 'admin' && parsed.role !== 'super_admin') ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const APP_AUTH_COOKIE_NAME = 'sgp_app_auth';

function parseCookies(req: Request): Record<string, string> {
  const header = String(req.headers.cookie || '');
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return proto.includes('https');
}

function setAuthCookie(res: Response, req: Request, token: string, persistent = true): void {
  const maxAgeSec = Math.floor(DEVICE_SESSION_TTL_MS / 1000);
  const https = isHttpsRequest(req);
  const parts = [
    `${APP_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
  ];
  if (persistent) {
    parts.push(`Max-Age=${maxAgeSec}`);
    parts.push(`Expires=${new Date(Date.now() + DEVICE_SESSION_TTL_MS).toUTCString()}`);
  }
  parts.push(https ? 'SameSite=None' : 'SameSite=Lax');
  if (https) {
    parts.push('Secure');
    parts.push('Partitioned');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res: Response, req: Request): void {
  const https = isHttpsRequest(req);
  const parts = [
    `${APP_AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) {
    parts.push('Secure');
    parts.push('Partitioned');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function extractBearerToken(req: Request): string | null {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  return null;
}

function hasExplicitAuthOrCustomHeader(req: Request): boolean {
  return Boolean(
    (typeof req.headers['x-app-auth'] === 'string' && req.headers['x-app-auth'].trim()) ||
      extractBearerToken(req) ||
      (typeof req.headers['x-requested-with'] === 'string' && req.headers['x-requested-with'].trim())
  );
}

function isOriginSafeForCookieMutation(req: Request): boolean {
  const origin = String(req.headers.origin || '').trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (origin && host) {
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  if (hasExplicitAuthOrCustomHeader(req)) return true;
  return !origin;
}

function extractValidAppAuthSession(req: Request, secret: Buffer): AppAuthSessionPayload | null {
  const candidates: Array<string | null> = [
    typeof req.headers['x-app-auth'] === 'string' ? req.headers['x-app-auth'].trim() : null,
    extractBearerToken(req),
    parseCookies(req)[APP_AUTH_COOKIE_NAME] || null,
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const verified = verifyAppAuthToken(cand, secret);
    if (verified) return verified;
  }
  return null;
}

function extractPinToken(req: Request): string | null {
  const custom = req.headers['x-pin-token'];
  if (typeof custom === 'string' && custom.trim()) {
    return custom.trim();
  }
  return extractBearerToken(req);
}

async function getConfiguredAccountsInfo(): Promise<{
  configured: boolean;
  envManaged: boolean;
  activeEmails: Set<string>;
  activeVersions: Map<string, string>;
}> {
  const envAuth = getEnvAuth();
  const envUsers = getEnvUsers();
  const [storedAuth, operatorUsers] = await Promise.all([readStoredAuth(), readOperatorUsers()]);
  const activeEmails = new Set<string>();
  const activeVersions = new Map<string, string>();
  if (envAuth) {
    const em = envAuth.email.toLowerCase();
    activeEmails.add(em);
    activeVersions.set(em, computePasswordVersion(envAuth.password));
  }
  for (const u of envUsers) {
    const em = u.email.toLowerCase();
    activeEmails.add(em);
    if (!activeVersions.has(em)) {
      activeVersions.set(em, computePasswordVersion(u.password));
    }
  }
  if (storedAuth) {
    const em = storedAuth.email.toLowerCase();
    activeEmails.add(em);
    if (!activeVersions.has(em)) {
      activeVersions.set(em, computePasswordVersion(storedAuth.passwordHash));
    }
  }
  for (const u of operatorUsers) {
    const em = u.email.toLowerCase();
    activeEmails.add(em);
    if (!activeVersions.has(em)) {
      activeVersions.set(em, computePasswordVersion(u.passwordHash));
    }
  }
  return {
    configured: activeEmails.size > 0,
    envManaged: Boolean(envAuth),
    activeEmails,
    activeVersions,
  };
}

function isSessionActiveForAccounts(
  rawSession: AppAuthSessionPayload | null,
  accounts: { configured: boolean; activeEmails: Set<string>; activeVersions: Map<string, string> }
): AppAuthSessionPayload | null {
  if (!rawSession) return null;
  if (!accounts.configured) return rawSession;
  const emailLower = rawSession.sub.toLowerCase();
  if (!accounts.activeEmails.has(emailLower)) return null;
  const expectedPwv = accounts.activeVersions.get(emailLower);
  if (expectedPwv && rawSession.pwv !== expectedPwv) return null;
  return rawSession;
}

async function getAppAuthSessionIfAllowed(req: Request): Promise<{ satisfied: boolean; session: AppAuthSessionPayload | null }> {
  const [accounts, secret] = await Promise.all([getConfiguredAccountsInfo(), getSessionSecretAsync()]);
  const rawSession = extractValidAppAuthSession(req, secret);
  const activeSession = isSessionActiveForAccounts(rawSession, accounts);
  if (!accounts.configured) {
    return { satisfied: true, session: activeSession };
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isOriginSafeForCookieMutation(req)) {
    return { satisfied: false, session: null };
  }
  return { satisfied: Boolean(activeSession), session: activeSession };
}

function getClientKey(req: Request): string {
  const realIp = typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : '';
  return req.ip || realIp || req.socket?.remoteAddress || 'unknown';
}

function pruneFailedAttempts(now: number): void {
  for (const [k, entry] of failedAttempts.entries()) {
    if (now > entry.resetAt) {
      failedAttempts.delete(k);
    }
  }
  while (failedAttempts.size >= MAX_RATE_ENTRIES) {
    const oldestKey = failedAttempts.keys().next().value;
    if (oldestKey === undefined) break;
    failedAttempts.delete(oldestKey);
  }
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (now > entry.resetAt) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    if (failedAttempts.size >= MAX_RATE_ENTRIES) {
      pruneFailedAttempts(now);
    }
    failedAttempts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(key: string): void {
  failedAttempts.delete(key);
}

const setupPinSchema = z.object({
  superAdminPin: z.string().trim().min(4, 'PIN Super Admin minimal 4 karakter').max(24),
  adminPin: z.string().trim().min(4, 'PIN Admin minimal 4 karakter').max(24),
  currentSuperAdminPin: z.string().trim().max(24).optional(),
});

const verifyPinSchema = z.object({
  targetRole: z.enum(['admin', 'super_admin']),
  pin: z.string().trim().min(1).max(24),
});

const appAuthCredsSchema = z.object({
  email: z.string().trim().email('Format email tidak valid').max(254),
  password: z.string().min(6, 'Password minimal 6 karakter').max(128),
  rememberDevice: z.boolean().optional().default(true),
});

const appLoginSchema = z.object({
  email: z.string().trim().email('Format email tidak valid').max(254),
  password: z.string().min(1, 'Password wajib diisi').max(128),
  rememberDevice: z.boolean().optional().default(true),
});

const upsertOperatorSchema = z.object({
  email: z.string().trim().email('Format email tidak valid').max(254),
  name: z.string().trim().max(80).optional().default(''),
  password: z.string().min(6, 'Password minimal 6 karakter').max(128),
});

const deleteOperatorSchema = z.object({
  email: z.string().trim().email('Format email tidak valid').max(254),
});

const warehouseMetaSchema = z.object({
  id: z.string().trim().min(1).max(64),
  nama: z.string().trim().min(1).max(120),
  legacy: z.boolean().optional(),
});

const saveWarehouseStateSchema = z.object({
  baseRevision: z.number().int().min(0),
  warehousesMeta: z.array(warehouseMetaSchema).min(1).max(50),
  warehouses: z.record(z.string().trim().min(1).max(64), z.record(z.string(), z.unknown())),
  forceOverwrite: z.boolean().optional(),
});

const csvLineSchema = z.object({
  sku: z.string().max(128).optional().default(''),
  nama: z.string().max(256).optional().default(''),
  sysQty: z.number().finite().optional(),
  stokWms: z.number().finite().optional(),
  physQty: z.number().finite().nullable().optional(),
  stokFisik: z.number().finite().nullable().optional(),
  prevDiff: z.number().finite().nullable().optional(),
  selisihSebelumnya: z.number().finite().nullable().optional(),
});

const csvExportSchema = z.object({
  lines: z.array(csvLineSchema).max(5000),
  tgl: z.string().trim().max(32).optional().default(''),
  warehouseName: z.string().trim().max(120).optional().default('ONLINE WAREHOUSE'),
});

const INDO_MONTHS = [
  'JANUARI',
  'FEBRUARI',
  'MARET',
  'APRIL',
  'MEI',
  'JUNI',
  'JULI',
  'AGUSTUS',
  'SEPTEMBER',
  'OKTOBER',
  'NOVEMBER',
  'DESEMBER',
];

function formatIndoDateUpper(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return String(iso || '').toUpperCase();
  const year = match[1];
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  const monthName = INDO_MONTHS[monthIdx] || match[2];
  return `${day} ${monthName} ${year}`;
}

function csvSafeCell(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) {
    text = "'" + text;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      storageMode: getStorageMode(),
      hasSessionSecret: hasStrongSessionSecret(),
    });
  });

  app.get(
    '/api/auth/status',
    asyncHandler(async (req: Request, res: Response) => {
      const [accounts, secret] = await Promise.all([getConfiguredAccountsInfo(), getSessionSecretAsync()]);
      const rawSession = extractValidAppAuthSession(req, secret);
      const session = isSessionActiveForAccounts(rawSession, accounts);

      let refreshedToken: string | null = null;
      const rememberDevice = session ? session.remember !== false : true;
      if (session && rememberDevice) {
        const shouldRenew = session.remember === undefined || Date.now() - session.iat > SLIDING_RENEWAL_INTERVAL_MS;
        if (shouldRenew) {
          const pwv = accounts.activeVersions.get(session.sub.toLowerCase()) || '';
          const issued = issueAppAuthToken(session.sub, session.role, secret, true, pwv);
          refreshedToken = issued.token;
          setAuthCookie(res, req, issued.token, true);
        }
      }

      res.json({
        configured: accounts.configured,
        envManaged: accounts.envManaged,
        authenticated: Boolean(session),
        email: session?.sub ?? null,
        role: session?.role ?? null,
        rememberDevice,
        token: refreshedToken,
        storageMode: getStorageMode(),
        hasSessionSecret: hasStrongSessionSecret(),
      });
    })
  );

  app.post(
    '/api/auth/setup',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isOriginSafeForCookieMutation(req)) {
        res.status(403).json({ error: 'Permintaan lintas origin tidak diizinkan.' });
        return;
      }

      const envAuth = getEnvAuth();
      if (envAuth) {
        res.status(409).json({
          error: 'Akun login dikelola melalui environment variable server (APP_LOGIN_EMAIL & APP_LOGIN_PASSWORD).',
          envManaged: true,
        });
        return;
      }

      const parsed = appAuthCredsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Email atau password tidak valid.' });
        return;
      }

      const emailLower = parsed.data.email.trim().toLowerCase();
      const passwordHash = hashSecret(parsed.data.password);
      const claimed = await writeStoredAuthIfAbsent({
        email: emailLower,
        passwordHash,
        updatedAt: new Date().toISOString(),
      });
      if (!claimed) {
        res.status(409).json({ error: 'Akun login awal sudah dibuat. Silakan langsung masuk.' });
        return;
      }

      const secret = await getSessionSecretAsync();
      const rememberDevice = parsed.data.rememberDevice !== false;
      const issued = issueAppAuthToken(emailLower, 'stockkeeper', secret, rememberDevice, computePasswordVersion(passwordHash));
      setAuthCookie(res, req, issued.token, rememberDevice);
      res.json(issued);
    })
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req: Request, res: Response) => {
      if (!isOriginSafeForCookieMutation(req)) {
        res.status(403).json({ error: 'Permintaan lintas origin tidak diizinkan.' });
        return;
      }

      const parsed = appLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Email atau password tidak valid.' });
        return;
      }

      const rateKey = `${getClientKey(req)}:app_login`;
      if (isRateLimited(rateKey)) {
        res.status(429).json({
          error: 'Terlalu banyak percobaan login gagal. Tunggu 5 menit sebelum mencoba lagi.',
        });
        return;
      }

      const emailLower = parsed.data.email.trim().toLowerCase();
      const password = parsed.data.password;

      const envAuth = getEnvAuth();
      const envUsers = getEnvUsers();
      const storedAuth = await readStoredAuth();
      const operatorUsers = await readOperatorUsers();

      const hasAnyAccount = Boolean(envAuth || envUsers.length > 0 || storedAuth || operatorUsers.length > 0);
      if (!hasAnyAccount) {
        res.status(400).json({
          needsSetup: true,
          error: 'Akun login belum dikonfigurasi. Silakan buat akun login awal terlebih dahulu.',
        });
        return;
      }

      let matchedEmail: string | null = null;
      let matchedPwv = '';

      if (envAuth && verifyPlainSecret(emailLower, envAuth.email) && verifyPlainSecret(password, envAuth.password)) {
        matchedEmail = envAuth.email;
        matchedPwv = computePasswordVersion(envAuth.password);
      }

      if (!matchedEmail) {
        for (const u of envUsers) {
          if (verifyPlainSecret(emailLower, u.email) && verifyPlainSecret(password, u.password)) {
            matchedEmail = u.email;
            matchedPwv = computePasswordVersion(u.password);
            break;
          }
        }
      }

      if (
        !matchedEmail &&
        storedAuth &&
        verifyPlainSecret(emailLower, storedAuth.email) &&
        verifySecretHash(password, storedAuth.passwordHash)
      ) {
        matchedEmail = storedAuth.email;
        matchedPwv = computePasswordVersion(storedAuth.passwordHash);
      }

      if (!matchedEmail) {
        for (const u of operatorUsers) {
          if (verifyPlainSecret(emailLower, u.email) && verifySecretHash(password, u.passwordHash)) {
            matchedEmail = u.email;
            matchedPwv = computePasswordVersion(u.passwordHash);
            break;
          }
        }
      }

      if (!matchedEmail) {
        recordFailure(rateKey);
        res.status(401).json({ error: 'Email atau password salah.' });
        return;
      }

      clearFailures(rateKey);
      const secret = await getSessionSecretAsync();
      const rememberDevice = parsed.data.rememberDevice !== false;
      const issued = issueAppAuthToken(matchedEmail, 'stockkeeper', secret, rememberDevice, matchedPwv);
      setAuthCookie(res, req, issued.token, rememberDevice);
      res.json(issued);
    })
  );

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    if (!isOriginSafeForCookieMutation(req)) {
      res.status(403).json({ error: 'Permintaan lintas origin tidak diizinkan.' });
      return;
    }
    clearAuthCookie(res, req);
    res.json({ ok: true });
  });

  app.get(
    '/api/auth/users',
    asyncHandler(async (req: Request, res: Response) => {
      const [authState, secret] = await Promise.all([getAppAuthSessionIfAllowed(req), getSessionSecretAsync()]);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req), secret);
      if (!pinSession || pinSession.role !== 'super_admin') {
        res.status(403).json({ error: 'Hanya Super Admin yang dapat mengelola daftar akun operator.' });
        return;
      }

      const envAuth = getEnvAuth();
      const envUsers = getEnvUsers();
      const primaryStored = await readStoredAuth();
      const operatorUsers = await readOperatorUsers();

      res.json({
        storageMode: getStorageMode(),
        primaryEmail: envAuth?.email || primaryStored?.email || null,
        primarySource: envAuth ? 'env' : primaryStored ? 'stored' : null,
        envUsers: envUsers.map((u) => ({ email: u.email, name: u.name, source: 'env' })),
        users: operatorUsers.map((u) => ({
          email: u.email,
          name: u.name,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          source: 'stored',
        })),
      });
    })
  );

  app.post(
    '/api/auth/users',
    asyncHandler(async (req: Request, res: Response) => {
      const [authState, secret] = await Promise.all([getAppAuthSessionIfAllowed(req), getSessionSecretAsync()]);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req), secret);
      if (!pinSession || pinSession.role !== 'super_admin') {
        res.status(403).json({ error: 'Hanya Super Admin yang dapat menambah atau memperbarui akun operator.' });
        return;
      }

      const parsed = upsertOperatorSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Data akun operator tidak valid.' });
        return;
      }

      const emailLower = parsed.data.email.trim().toLowerCase();
      const envAuth = getEnvAuth();
      const envUsers = getEnvUsers();
      const primaryStored = await readStoredAuth();

      if (
        (envAuth && envAuth.email === emailLower) ||
        envUsers.some((u) => u.email === emailLower) ||
        (primaryStored && primaryStored.email === emailLower)
      ) {
        res.status(409).json({ error: 'Email tersebut sudah terdaftar sebagai akun utama atau akun environment.' });
        return;
      }

      const current = await readOperatorUsers();
      const now = new Date().toISOString();
      const existingIdx = current.findIndex((u) => u.email === emailLower);
      if (existingIdx >= 0) {
        current[existingIdx] = {
          ...current[existingIdx],
          name: parsed.data.name.trim() || current[existingIdx].name || emailLower.split('@')[0],
          passwordHash: hashSecret(parsed.data.password),
          updatedAt: now,
        };
      } else {
        if (current.length >= 100) {
          res.status(400).json({ error: 'Batas maksimal 100 akun operator tercapai.' });
          return;
        }
        current.push({
          email: emailLower,
          name: parsed.data.name.trim() || emailLower.split('@')[0],
          passwordHash: hashSecret(parsed.data.password),
          createdAt: now,
          updatedAt: now,
        });
      }

      await writeOperatorUsers(current);
      res.json({
        ok: true,
        storageMode: getStorageMode(),
        users: current.map((u) => ({
          email: u.email,
          name: u.name,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          source: 'stored',
        })),
      });
    })
  );

  app.delete(
    '/api/auth/users',
    asyncHandler(async (req: Request, res: Response) => {
      const [authState, secret] = await Promise.all([getAppAuthSessionIfAllowed(req), getSessionSecretAsync()]);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req), secret);
      if (!pinSession || pinSession.role !== 'super_admin') {
        res.status(403).json({ error: 'Hanya Super Admin yang dapat menghapus akun operator.' });
        return;
      }

      const parsed = deleteOperatorSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Email akun yang ingin dihapus tidak valid.' });
        return;
      }

      const emailLower = parsed.data.email.trim().toLowerCase();
      const current = await readOperatorUsers();
      const next = current.filter((u) => u.email !== emailLower);
      if (next.length === current.length) {
        res.status(404).json({ error: 'Akun operator tidak ditemukan.' });
        return;
      }

      await writeOperatorUsers(next);
      res.json({
        ok: true,
        storageMode: getStorageMode(),
        users: next.map((u) => ({
          email: u.email,
          name: u.name,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          source: 'stored',
        })),
      });
    })
  );

  app.get(
    '/api/pin/status',
    asyncHandler(async (req: Request, res: Response) => {
      const envPins = getEnvPins();
      const [stored, authState, secret] = await Promise.all([
        readStoredPins(),
        getAppAuthSessionIfAllowed(req),
        getSessionSecretAsync(),
      ]);
      const token = extractPinToken(req);
      const session = authState.satisfied ? verifySessionToken(token, secret) : null;
      res.json({
        configured: Boolean(envPins || stored),
        envManaged: Boolean(envPins),
        hasAdminPin: Boolean(envPins || stored?.adminHash),
        hasSuperAdminPin: Boolean(envPins || stored?.superAdminHash),
        sessionValid: Boolean(session),
        sessionRole: session?.role ?? null,
      });
    })
  );

  app.post(
    '/api/pin/setup',
    asyncHandler(async (req: Request, res: Response) => {
      const [authState, secret] = await Promise.all([getAppAuthSessionIfAllowed(req), getSessionSecretAsync()]);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }

      const envPins = getEnvPins();
      if (envPins) {
        res.status(409).json({
          error: 'PIN dikelola melalui environment variable server (ADMIN_BACKUP_PIN & SUPER_ADMIN_BACKUP_PIN).',
          envManaged: true,
        });
        return;
      }

      const parsed = setupPinSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Format PIN tidak valid.' });
        return;
      }

      const { superAdminPin, adminPin, currentSuperAdminPin } = parsed.data;
      if (superAdminPin === adminPin) {
        res.status(400).json({ error: 'PIN Super Admin dan PIN Admin tidak boleh sama.' });
        return;
      }

      const existing = await readStoredPins();
      if (existing) {
        const token = extractPinToken(req);
        const session = verifySessionToken(token, secret);
        const hasValidSession = session?.role === 'super_admin';
        const hasValidCurrentPin =
          typeof currentSuperAdminPin === 'string' &&
          currentSuperAdminPin.length > 0 &&
          verifySecretHash(currentSuperAdminPin, existing.superAdminHash);

        if (!hasValidSession && !hasValidCurrentPin) {
          res.status(403).json({
            error: 'Masukkan PIN Super Admin lama atau aktifkan sesi Super Admin terlebih dahulu.',
          });
          return;
        }
      }

      const nextPinRecord: StoredPinRecord = {
        adminHash: hashSecret(adminPin),
        superAdminHash: hashSecret(superAdminPin),
        updatedAt: new Date().toISOString(),
      };

      if (!existing) {
        const claimed = await writeStoredPinsIfAbsent(nextPinRecord);
        if (!claimed) {
          res.status(409).json({
            error: 'PIN sudah diatur oleh pengguna lain secara bersamaan. Masukkan PIN Super Admin yang aktif.',
          });
          return;
        }
      } else {
        await writeStoredPins(nextPinRecord);
      }

      const issued = issueSessionToken('super_admin', secret);
      res.json(issued);
    })
  );

  app.post(
    '/api/pin/verify',
    asyncHandler(async (req: Request, res: Response) => {
      const [authState, secret] = await Promise.all([getAppAuthSessionIfAllowed(req), getSessionSecretAsync()]);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }

      const parsed = verifyPinSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Permintaan verifikasi PIN tidak valid.' });
        return;
      }

      const { targetRole, pin } = parsed.data;
      const rateKey = `${getClientKey(req)}:${targetRole}`;
      if (isRateLimited(rateKey)) {
        res.status(429).json({
          error: 'Terlalu banyak percobaan PIN gagal. Tunggu 5 menit sebelum mencoba lagi.',
        });
        return;
      }

      const envPins = getEnvPins();
      if (envPins) {
        const ok =
          targetRole === 'super_admin'
            ? verifyPlainSecret(pin, envPins.superAdminPin)
            : verifyPlainSecret(pin, envPins.adminPin) || verifyPlainSecret(pin, envPins.superAdminPin);

        if (!ok) {
          recordFailure(rateKey);
          res.status(401).json({ error: 'PIN tidak sesuai.' });
          return;
        }

        clearFailures(rateKey);
        res.json(issueSessionToken(targetRole, secret));
        return;
      }

      const stored = await readStoredPins();
      if (!stored) {
        res.status(400).json({
          needsSetup: true,
          error: 'PIN cadangan belum diatur. Silakan lakukan pengaturan PIN awal.',
        });
        return;
      }

      const ok =
        targetRole === 'super_admin'
          ? verifySecretHash(pin, stored.superAdminHash)
          : verifySecretHash(pin, stored.adminHash) || verifySecretHash(pin, stored.superAdminHash);

      if (!ok) {
        recordFailure(rateKey);
        res.status(401).json({ error: 'PIN tidak sesuai.' });
        return;
      }

      clearFailures(rateKey);
      res.json(issueSessionToken(targetRole, secret));
    })
  );

  app.get(
    '/api/warehouse/state',
    asyncHandler(async (req: Request, res: Response) => {
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }

      const state = await readSharedWarehouseState();
      const sinceRaw = typeof req.query.since === 'string' ? Number(req.query.since) : NaN;
      const storageMode = getStorageMode();

      if (Number.isFinite(sinceRaw) && sinceRaw >= 0 && sinceRaw >= state.revision) {
        res.json({
          changed: false,
          revision: state.revision,
          updatedAt: state.updatedAt,
          updatedBy: state.updatedBy,
          storageMode,
        });
        return;
      }

      res.json({
        changed: true,
        revision: state.revision,
        updatedAt: state.updatedAt,
        updatedBy: state.updatedBy,
        warehousesMeta: state.warehousesMeta,
        warehouses: state.warehouses,
        storageMode,
      });
    })
  );

  app.put(
    '/api/warehouse/state',
    asyncHandler(async (req: Request, res: Response) => {
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }

      const parsed = saveWarehouseStateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Format sinkronisasi data gudang tidak valid.',
        });
        return;
      }

      const storageMode = getStorageMode();
      const currentState = await readSharedWarehouseState();
      const { baseRevision, warehousesMeta, warehouses, forceOverwrite } = parsed.data;

      if (!forceOverwrite && currentState.revision > 0 && baseRevision < currentState.revision) {
        res.status(409).json({
          conflict: true,
          error: 'Data gudang telah diperbarui oleh pengguna lain.',
          latest: currentState,
          storageMode,
        });
        return;
      }

      const actorEmail = authState.session?.sub || 'operator';
      const nextState: SharedWarehouseState = {
        revision: currentState.revision + 1,
        updatedAt: Date.now(),
        updatedBy: actorEmail,
        warehousesMeta,
        warehouses,
      };

      if (!forceOverwrite && hasPostgresConfig()) {
        const cas = await writeSharedWarehouseStateCas(currentState.revision, nextState);
        if (cas.conflict) {
          const latestState = await readSharedWarehouseState();
          res.status(409).json({
            conflict: true,
            error: 'Data gudang telah diperbarui oleh pengguna lain.',
            latest: latestState,
            storageMode,
          });
          return;
        }
      } else {
        await writeSharedWarehouseState(nextState);
      }

      res.json({
        ok: true,
        revision: nextState.revision,
        updatedAt: nextState.updatedAt,
        updatedBy: nextState.updatedBy,
        storageMode,
      });
    })
  );

  app.post(
    '/api/cycle-count/csv',
    asyncHandler(async (req: Request, res: Response) => {
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }

      const parsed = csvExportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Payload ekspor CSV Cycle Count tidak valid.' });
        return;
      }

      const { lines, tgl, warehouseName } = parsed.data;
      const title = `STOK AKHIR ${String(warehouseName || 'ONLINE WAREHOUSE').toUpperCase()} ${formatIndoDateUpper(tgl)}`.trim();

      const csvRows: string[] = [
        [title, '', '', '', '', ''].map(csvSafeCell).join(','),
        ['SKU', 'NAMA PRODUK', 'STOK WMS', 'STOK FISIK', 'SELISIH HARI INI', 'SELISIH SEBELUMNYA'].map(csvSafeCell).join(','),
      ];

      for (const ln of lines) {
        const wms = typeof ln.stokWms === 'number' ? ln.stokWms : typeof ln.sysQty === 'number' ? ln.sysQty : 0;
        const phys = typeof ln.stokFisik === 'number' ? ln.stokFisik : typeof ln.physQty === 'number' ? ln.physQty : null;
        const prevDiff =
          typeof ln.selisihSebelumnya === 'number'
            ? ln.selisihSebelumnya
            : typeof ln.prevDiff === 'number'
              ? ln.prevDiff
              : null;
        const hasPhys = phys !== null && Number.isFinite(phys);
        const totalDiff = hasPhys ? phys - wms : null;
        const todayDiff = hasPhys && totalDiff !== null ? (prevDiff !== null ? totalDiff - prevDiff : totalDiff) : null;

        csvRows.push(
          [
            ln.sku || '',
            ln.nama || '',
            wms,
            hasPhys ? phys : '',
            todayDiff !== null ? todayDiff : '',
            prevDiff !== null ? prevDiff : '',
          ]
            .map(csvSafeCell)
            .join(',')
        );
      }

      const body = '\uFEFF' + csvRows.join('\r\n');
      const safeFileDate = String(tgl || 'report').replace(/[^a-zA-Z0-9_-]/g, '');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cycle-count-${safeFileDate}.csv"`);
      res.send(body);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Terjadi kesalahan internal server.';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  return app;
}
