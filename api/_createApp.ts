import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

type AppRole = 'admin' | 'super_admin';
type AppAuthRole = 'stockkeeper' | AppRole;
export type StorageMode = 'redis' | 'file' | 'ephemeral';

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
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

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
    if (!envKey.endsWith('_REST_API_URL') || !envVal) continue;
    const prefix = envKey.slice(0, -'_REST_API_URL'.length);
    if (prefix === 'KV' || prefix === 'UPSTASH_REDIS') continue;
    const tokenVal = String(process.env[`${prefix}_REST_API_TOKEN`] || '').trim();
    if (tokenVal) {
      candidates.push({ url: String(envVal).trim(), token: tokenVal });
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
  if (getKvConfig()) return 'redis';
  if (process.env.VERCEL) return 'ephemeral';
  return 'file';
}

function hasStrongSessionSecret(): boolean {
  return String(process.env.PIN_SESSION_SECRET || '').trim().length >= 16;
}

function getSessionSecret(): Buffer {
  const configured = String(process.env.PIN_SESSION_SECRET || '').trim();
  if (configured.length >= 16) {
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
  }
  return ephemSessionSecret;
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
    });
    return res.ok;
  } catch {
    return false;
  }
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
  memoryPinStore = record;
  if (getKvConfig()) {
    await kvSetJson('sgp:pin:config', record);
  }
  writeJsonToPaths('pin-config.json', 'sgp-pin-config.json', record);
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

async function writeStoredAuth(record: StoredAuthRecord): Promise<void> {
  memoryAuthStore = record;
  if (getKvConfig()) {
    await kvSetJson('sgp:auth:primary', record);
  }
  writeJsonToPaths('auth-config.json', 'sgp-auth-config.json', record);
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
  memoryOperatorUsers = users;
  if (getKvConfig()) {
    await kvSetJson('sgp:auth:users', users);
  }
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
  memoryWarehouseState = state;
  if (getKvConfig()) {
    await kvSetJson('sgp:warehouse:state', state);
  }
  writeJsonToPaths('warehouse-state.json', 'sgp-warehouse-state.json', state);
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

function issueSessionToken(role: AppRole): { token: string; role: AppRole; expiresAt: number } {
  const now = Date.now();
  const payload: PinSessionPayload = {
    role,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, role, expiresAt: payload.exp };
}

function verifySessionToken(rawToken: string | null | undefined): PinSessionPayload | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
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

function issueAppAuthToken(
  email: string,
  role: AppAuthRole
): { token: string; email: string; role: AppAuthRole; expiresAt: number } {
  const now = Date.now();
  const payload: AppAuthSessionPayload = {
    sub: email.trim().toLowerCase(),
    role,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(`app:${body}`).digest('base64url');
  return { token: `${body}.${sig}`, email: payload.sub, role, expiresAt: payload.exp };
}

function verifyAppAuthToken(rawToken: string | null | undefined): AppAuthSessionPayload | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(`app:${body}`).digest('base64url');
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

function setAuthCookie(res: Response, req: Request, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const https = isHttpsRequest(req);
  const parts = [
    `${APP_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res: Response, req: Request): void {
  const https = isHttpsRequest(req);
  const parts = [
    `${APP_AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    https ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (https) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function extractBearerToken(req: Request): string | null {
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  return null;
}

function extractAppAuthToken(req: Request): string | null {
  const custom = req.headers['x-app-auth'];
  if (typeof custom === 'string' && custom.trim()) {
    return custom.trim();
  }
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  const cookies = parseCookies(req);
  return cookies[APP_AUTH_COOKIE_NAME] || null;
}

function extractPinToken(req: Request): string | null {
  const custom = req.headers['x-pin-token'];
  if (typeof custom === 'string' && custom.trim()) {
    return custom.trim();
  }
  return extractBearerToken(req);
}

async function isAnyAuthConfigured(): Promise<boolean> {
  if (getEnvAuth() || getEnvUsers().length > 0) return true;
  if (await readStoredAuth()) return true;
  const users = await readOperatorUsers();
  return users.length > 0;
}

async function getAppAuthSessionIfAllowed(req: Request): Promise<{ satisfied: boolean; session: AppAuthSessionPayload | null }> {
  const configured = await isAnyAuthConfigured();
  const session = verifyAppAuthToken(extractAppAuthToken(req));
  if (!configured) {
    return { satisfied: true, session };
  }
  return { satisfied: Boolean(session), session };
}

function getClientKey(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
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
});

const appLoginSchema = z.object({
  email: z.string().trim().email('Format email tidak valid').max(254),
  password: z.string().min(1, 'Password wajib diisi').max(128),
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
      const envAuth = getEnvAuth();
      const envUsers = getEnvUsers();
      const storedAuth = await readStoredAuth();
      const operatorUsers = await readOperatorUsers();
      const token = extractAppAuthToken(req);
      const session = verifyAppAuthToken(token);
      res.json({
        configured: Boolean(envAuth || envUsers.length > 0 || storedAuth || operatorUsers.length > 0),
        envManaged: Boolean(envAuth),
        authenticated: Boolean(session),
        email: session?.sub ?? null,
        role: session?.role ?? null,
        storageMode: getStorageMode(),
        hasSessionSecret: hasStrongSessionSecret(),
      });
    })
  );

  app.post(
    '/api/auth/setup',
    asyncHandler(async (req: Request, res: Response) => {
      const envAuth = getEnvAuth();
      if (envAuth) {
        res.status(409).json({
          error: 'Akun login dikelola melalui environment variable server (APP_LOGIN_EMAIL & APP_LOGIN_PASSWORD).',
          envManaged: true,
        });
        return;
      }

      const existing = await readStoredAuth();
      if (existing) {
        res.status(409).json({ error: 'Akun login awal sudah dibuat. Silakan langsung masuk.' });
        return;
      }

      const parsed = appAuthCredsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Email atau password tidak valid.' });
        return;
      }

      const emailLower = parsed.data.email.trim().toLowerCase();
      await writeStoredAuth({
        email: emailLower,
        passwordHash: hashSecret(parsed.data.password),
        updatedAt: new Date().toISOString(),
      });

      const issued = issueAppAuthToken(emailLower, 'stockkeeper');
      setAuthCookie(res, req, issued.token);
      res.json(issued);
    })
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req: Request, res: Response) => {
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

      if (envAuth && verifyPlainSecret(emailLower, envAuth.email) && verifyPlainSecret(password, envAuth.password)) {
        matchedEmail = envAuth.email;
      }

      if (!matchedEmail) {
        for (const u of envUsers) {
          if (verifyPlainSecret(emailLower, u.email) && verifyPlainSecret(password, u.password)) {
            matchedEmail = u.email;
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
      }

      if (!matchedEmail) {
        for (const u of operatorUsers) {
          if (verifyPlainSecret(emailLower, u.email) && verifySecretHash(password, u.passwordHash)) {
            matchedEmail = u.email;
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
      const issued = issueAppAuthToken(matchedEmail, 'stockkeeper');
      setAuthCookie(res, req, issued.token);
      res.json(issued);
    })
  );

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    clearAuthCookie(res, req);
    res.json({ ok: true });
  });

  app.get(
    '/api/auth/users',
    asyncHandler(async (req: Request, res: Response) => {
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req));
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
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req));
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
      const authState = await getAppAuthSessionIfAllowed(req);
      if (!authState.satisfied) {
        res.status(401).json({ error: 'Silakan masuk dengan email dan password terlebih dahulu.' });
        return;
      }
      const pinSession = verifySessionToken(extractPinToken(req));
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
      const stored = await readStoredPins();
      const token = extractPinToken(req);
      const authState = await getAppAuthSessionIfAllowed(req);
      const session = authState.satisfied ? verifySessionToken(token) : null;
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
      const authState = await getAppAuthSessionIfAllowed(req);
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
        const session = verifySessionToken(token);
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

      await writeStoredPins({
        adminHash: hashSecret(adminPin),
        superAdminHash: hashSecret(superAdminPin),
        updatedAt: new Date().toISOString(),
      });

      const issued = issueSessionToken('super_admin');
      res.json(issued);
    })
  );

  app.post(
    '/api/pin/verify',
    asyncHandler(async (req: Request, res: Response) => {
      const authState = await getAppAuthSessionIfAllowed(req);
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
        res.json(issueSessionToken(targetRole));
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
      res.json(issueSessionToken(targetRole));
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

      await writeSharedWarehouseState(nextState);

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
