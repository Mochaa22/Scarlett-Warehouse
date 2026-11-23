import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';

type AppRole = 'admin' | 'super_admin';
type AppAuthRole = 'stockkeeper' | AppRole;

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
const failedAttempts = new Map<string, { count: number; resetAt: number }>();

function getSessionSecret(): Buffer {
  const configured = String(process.env.PIN_SESSION_SECRET || '').trim();
  if (configured.length >= 16) {
    return crypto.createHash('sha256').update(configured, 'utf8').digest();
  }
  return ephemSessionSecret;
}

function getEnvPins(): { adminPin: string; superAdminPin: string } | null {
  const adminPin = String(process.env.ADMIN_BACKUP_PIN || '').trim();
  const superAdminPin = String(process.env.SUPER_ADMIN_BACKUP_PIN || '').trim();
  if (adminPin.length >= 4 && superAdminPin.length >= 4 && adminPin !== superAdminPin) {
    return { adminPin, superAdminPin };
  }
  return null;
}

function resolvePinStorePath(): string {
  const baseDir = path.resolve(process.cwd(), '.data');
  const candidate = path.resolve(baseDir, 'pin-config.json');
  if (!candidate.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid PIN storage path');
  }
  return candidate;
}

function resolveTmpPinStorePath(): string {
  const baseDir = path.resolve('/tmp');
  const candidate = path.resolve(baseDir, 'sgp-pin-config.json');
  if (!candidate.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid temporary PIN storage path');
  }
  return candidate;
}

function readStoredPins(): StoredPinRecord | null {
  if (memoryPinStore) return memoryPinStore;
  for (const filePath of [resolvePinStorePath(), resolveTmpPinStorePath()]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredPinRecord>;
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
    } catch {
      // Ignore unreadable or non-persistent path
    }
  }
  return null;
}

function getEnvAuth(): { email: string; password: string } | null {
  const email = String(process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.APP_LOGIN_PASSWORD || '').replace(/[\r\n]+/g, '');
  if (email.includes('@') && password.length >= 6) {
    return { email, password };
  }
  return null;
}

function resolveAuthStorePath(): string {
  const baseDir = path.resolve(process.cwd(), '.data');
  const candidate = path.resolve(baseDir, 'auth-config.json');
  if (!candidate.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid auth storage path');
  }
  return candidate;
}

function resolveTmpAuthStorePath(): string {
  const baseDir = path.resolve('/tmp');
  const candidate = path.resolve(baseDir, 'sgp-auth-config.json');
  if (!candidate.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid temporary auth storage path');
  }
  return candidate;
}

function readStoredAuth(): StoredAuthRecord | null {
  if (memoryAuthStore) return memoryAuthStore;
  for (const filePath of [resolveAuthStorePath(), resolveTmpAuthStorePath()]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredAuthRecord>;
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
    } catch {
      // Ignore unreadable or non-persistent path
    }
  }
  return null;
}

function writeStoredAuth(record: StoredAuthRecord): void {
  memoryAuthStore = record;
  const serialized = JSON.stringify(record, null, 2);
  const primaryPath = resolveAuthStorePath();
  try {
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.writeFileSync(primaryPath, serialized, { mode: 0o600 });
    return;
  } catch {
    // Fallback to /tmp on read-only serverless filesystems
  }
  try {
    const tmpPath = resolveTmpAuthStorePath();
    fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  } catch {
    // Keep in-memory copy if filesystem is locked
  }
}

function writeStoredPins(record: StoredPinRecord): void {
  memoryPinStore = record;
  const serialized = JSON.stringify(record, null, 2);
  const primaryPath = resolvePinStorePath();
  try {
    fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
    fs.writeFileSync(primaryPath, serialized, { mode: 0o600 });
    return;
  } catch {
    // Fallback to /tmp on read-only serverless filesystems
  }
  try {
    const tmpPath = resolveTmpPinStorePath();
    fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  } catch {
    // Keep in-memory copy if filesystem is completely locked
  }
}

function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPinHash(pin: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hexDigest] = parts;
  if (!salt || !hexDigest) return false;
  const expected = Buffer.from(hexDigest, 'hex');
  const actual = crypto.scryptSync(pin, salt, 64);
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
  return extractBearerToken(req);
}

function isAppAuthSatisfied(req: Request): boolean {
  const configured = Boolean(getEnvAuth() || readStoredAuth());
  if (!configured) return true;
  return Boolean(verifyAppAuthToken(extractAppAuthToken(req)));
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
  app.use(express.json({ limit: '2mb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/auth/status', (req: Request, res: Response) => {
    const envAuth = getEnvAuth();
    const storedAuth = readStoredAuth();
    const token = extractBearerToken(req);
    const session = verifyAppAuthToken(token);
    res.json({
      configured: Boolean(envAuth || storedAuth),
      envManaged: Boolean(envAuth),
      authenticated: Boolean(session),
      email: session?.sub ?? null,
      role: session?.role ?? null,
    });
  });

  app.post('/api/auth/setup', (req: Request, res: Response) => {
    const envAuth = getEnvAuth();
    if (envAuth) {
      res.status(409).json({
        error: 'Akun login dikelola melalui environment variable server (APP_LOGIN_EMAIL & APP_LOGIN_PASSWORD).',
        envManaged: true,
      });
      return;
    }

    const existing = readStoredAuth();
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
    writeStoredAuth({
      email: emailLower,
      passwordHash: hashPin(parsed.data.password),
      updatedAt: new Date().toISOString(),
    });

    res.json(issueAppAuthToken(emailLower, 'stockkeeper'));
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
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
    if (envAuth) {
      const emailMatch = verifyPlainSecret(emailLower, envAuth.email);
      const passMatch = verifyPlainSecret(password, envAuth.password);
      if (!emailMatch || !passMatch) {
        recordFailure(rateKey);
        res.status(401).json({ error: 'Email atau password salah.' });
        return;
      }
      clearFailures(rateKey);
      res.json(issueAppAuthToken(envAuth.email, 'stockkeeper'));
      return;
    }

    const storedAuth = readStoredAuth();
    if (!storedAuth) {
      res.status(400).json({
        needsSetup: true,
        error: 'Akun login belum dikonfigurasi. Silakan buat akun login awal terlebih dahulu.',
      });
      return;
    }

    const emailMatch = verifyPlainSecret(emailLower, storedAuth.email);
    const passMatch = verifyPinHash(password, storedAuth.passwordHash);
    if (!emailMatch || !passMatch) {
      recordFailure(rateKey);
      res.status(401).json({ error: 'Email atau password salah.' });
      return;
    }

    clearFailures(rateKey);
    res.json(issueAppAuthToken(storedAuth.email, 'stockkeeper'));
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/api/pin/status', (req: Request, res: Response) => {
    const envPins = getEnvPins();
    const stored = readStoredPins();
    const token = extractBearerToken(req);
    const session = isAppAuthSatisfied(req) ? verifySessionToken(token) : null;
    res.json({
      configured: Boolean(envPins || stored),
      envManaged: Boolean(envPins),
      hasAdminPin: Boolean(envPins || stored?.adminHash),
      hasSuperAdminPin: Boolean(envPins || stored?.superAdminHash),
      sessionValid: Boolean(session),
      sessionRole: session?.role ?? null,
    });
  });

  app.post('/api/pin/setup', (req: Request, res: Response) => {
    if (!isAppAuthSatisfied(req)) {
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

    const existing = readStoredPins();
    if (existing) {
      const token = extractBearerToken(req);
      const session = verifySessionToken(token);
      const hasValidSession = session?.role === 'super_admin';
      const hasValidCurrentPin =
        typeof currentSuperAdminPin === 'string' &&
        currentSuperAdminPin.length > 0 &&
        verifyPinHash(currentSuperAdminPin, existing.superAdminHash);

      if (!hasValidSession && !hasValidCurrentPin) {
        res.status(403).json({
          error: 'Masukkan PIN Super Admin lama atau aktifkan sesi Super Admin terlebih dahulu.',
        });
        return;
      }
    }

    writeStoredPins({
      adminHash: hashPin(adminPin),
      superAdminHash: hashPin(superAdminPin),
      updatedAt: new Date().toISOString(),
    });

    const issued = issueSessionToken('super_admin');
    res.json(issued);
  });

  app.post('/api/pin/verify', (req: Request, res: Response) => {
    if (!isAppAuthSatisfied(req)) {
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

    const stored = readStoredPins();
    if (!stored) {
      res.status(400).json({
        needsSetup: true,
        error: 'PIN cadangan belum diatur. Silakan lakukan pengaturan PIN awal.',
      });
      return;
    }

    const ok =
      targetRole === 'super_admin'
        ? verifyPinHash(pin, stored.superAdminHash)
        : verifyPinHash(pin, stored.adminHash) || verifyPinHash(pin, stored.superAdminHash);

    if (!ok) {
      recordFailure(rateKey);
      res.status(401).json({ error: 'PIN tidak sesuai.' });
      return;
    }

    clearFailures(rateKey);
    res.json(issueSessionToken(targetRole));
  });

  app.post('/api/cycle-count/csv', (req: Request, res: Response) => {
    if (!isAppAuthSatisfied(req)) {
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
      const wms = typeof ln.stokWms === 'number' ? ln.stokWms : (typeof ln.sysQty === 'number' ? ln.sysQty : 0);
      const phys = typeof ln.stokFisik === 'number' ? ln.stokFisik : (typeof ln.physQty === 'number' ? ln.physQty : null);
      const prevDiff = typeof ln.selisihSebelumnya === 'number'
        ? ln.selisihSebelumnya
        : (typeof ln.prevDiff === 'number' ? ln.prevDiff : null);
      const hasPhys = phys !== null && Number.isFinite(phys);
      const totalDiff = hasPhys ? phys - wms : null;
      const todayDiff = hasPhys && totalDiff !== null
        ? (prevDiff !== null ? totalDiff - prevDiff : totalDiff)
        : null;

      csvRows.push([
        ln.sku || '',
        ln.nama || '',
        wms,
        hasPhys ? phys : '',
        todayDiff !== null ? todayDiff : '',
        prevDiff !== null ? prevDiff : '',
      ].map(csvSafeCell).join(','));
    }

    const body = '\uFEFF' + csvRows.join('\r\n');
    const safeFileDate = String(tgl || 'report').replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cycle-count-${safeFileDate}.csv"`);
    res.send(body);
  });

  return app;
}
