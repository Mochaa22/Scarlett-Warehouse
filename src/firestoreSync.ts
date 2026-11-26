import {
  browserLocalPersistence,
  browserSessionPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type Unsubscribe,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type CollectionReference,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
} from './firebase.ts';

const BOOTSTRAPPED_SUPER_ADMIN_EMAIL = 'ferdiputraa793@gmail.com';
const SHARED_PIN_CONFIG_ID = 'shared_workspace_pins';
const MAX_BATCH_OPS = 400;

export interface WarehouseMetaCloud {
  id: string;
  nama: string;
  legacy?: boolean;
  order?: number;
}

export interface WarehouseDataCloud {
  master: Array<Record<string, unknown>>;
  lokasi: string[];
  opening: Array<Record<string, unknown>>;
  allstock: Array<Record<string, unknown>>;
  masuk: Array<Record<string, unknown>>;
  keluar: Array<Record<string, unknown>>;
  pindah: Array<Record<string, unknown>>;
  defect: Array<Record<string, unknown>>;
  batches: Array<Record<string, unknown>>;
  cycleCounts: Array<Record<string, unknown>>;
  inboundRegister: Array<Record<string, unknown>>;
  cutoff: string;
  min: number;
  mode: 'mut' | 'all';
  cover: number;
  expMonths: number;
}

export interface CloudWarehouseSnapshot {
  warehousesMeta: WarehouseMetaCloud[];
  warehouses: Record<string, WarehouseDataCloud>;
}

export interface RoleAssignmentRecord {
  id: string;
  email: string;
  displayName: string;
  role: 'stockkeeper' | 'admin' | 'super_admin';
  assignedByUid: string;
  warehouseId?: string;
  warehouseName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PinConfigStatus {
  configured: boolean;
  hasAdminPin: boolean;
  hasSuperAdminPin: boolean;
  ownerId?: string;
}

// Cache ownerId dan createdAt asli dokumen Firestore agar update lintas operator mematuhi firestore.rules
const docOwnerCache = new Map<string, string>();
const docCreatedAtCache = new Map<string, unknown>();
const catalogIdCache = new Map<string, string>();
let knownTeamEmails = new Set<string>([BOOTSTRAPPED_SUPER_ADMIN_EMAIL]);
let activeSnapshotUnsubs: Unsubscribe[] = [];

function currentUserOrThrow(): User {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Silakan masuk dengan akun Google terlebih dahulu.');
  }
  return user;
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email || '').trim().toLowerCase();
}

export function isBootstrappedSuperAdminEmail(email: string | null | undefined): boolean {
  return normalizeEmail(email) === BOOTSTRAPPED_SUPER_ADMIN_EMAIL;
}

function clampStr(val: unknown, maxLen: number): string {
  const s = String(val ?? '').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function toFiniteNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeDocId(raw: unknown, prefix = 'id'): string {
  const s = String(raw ?? '').trim();
  if (/^[a-zA-Z0-9_\-]{1,128}$/.test(s)) {
    return s;
  }
  const cleaned = s.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length >= 1 && cleaned.length <= 128) {
    return cleaned;
  }
  return `${prefix}_${fnv1aHex(s || String(Date.now()))}`;
}

function fnv1aHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(36) + '_' + (h2 >>> 0).toString(36);
}

function deterministicCatalogId(kind: 'master' | 'lokasi' | 'opening' | 'allstock', key: string): string {
  const cached = catalogIdCache.get(`${kind}:${key}`);
  if (cached) return cached;
  const generated = `cat_${kind}_${fnv1aHex(key)}`.slice(0, 128);
  catalogIdCache.set(`${kind}:${key}`, generated);
  return generated;
}

function catalogIdentityKey(kind: 'master' | 'lokasi' | 'opening' | 'allstock', item: unknown): string {
  if (kind === 'lokasi') {
    return String(item ?? '').trim().toUpperCase();
  }
  const rec = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  const sku = String(rec.sku || '').trim().toUpperCase();
  const bc = String(rec.barcode || '').trim().toUpperCase();
  const lok = String(rec.lok || '').trim().toUpperCase();
  if (kind === 'master') return `${sku}|${bc}`;
  return `${lok}|${sku}|${bc}`;
}

function buildMemberEmailsList(extraEmails?: unknown): string[] {
  const set = new Set<string>();
  set.add(BOOTSTRAPPED_SUPER_ADMIN_EMAIL);
  const curEmail = normalizeEmail(auth.currentUser?.email);
  if (curEmail) set.add(curEmail);
  knownTeamEmails.forEach((em) => {
    const n = normalizeEmail(em);
    if (n && n.length >= 3 && n.length <= 254) set.add(n);
  });
  if (Array.isArray(extraEmails)) {
    extraEmails.forEach((em) => {
      const n = normalizeEmail(typeof em === 'string' ? em : '');
      if (n && n.length >= 3 && n.length <= 254) set.add(n);
    });
  }
  return Array.from(set).slice(0, 50);
}

function timestampToIsoString(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

function rememberDocMeta(path: string, data: DocumentData): void {
  if (typeof data.ownerId === 'string' && data.ownerId) {
    docOwnerCache.set(path, data.ownerId);
  }
  if (data.createdAt !== undefined) {
    docCreatedAtCache.set(path, data.createdAt);
  }
  if (Array.isArray(data.memberEmails)) {
    data.memberEmails.forEach((em: unknown) => {
      const n = normalizeEmail(typeof em === 'string' ? em : '');
      if (n) knownTeamEmails.add(n);
    });
  }
}

async function queryTenantDocs(
  colRef: CollectionReference<DocumentData>,
  pathLabel: string
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const user = currentUserOrThrow();
  const emailLower = normalizeEmail(user.email);
  try {
    if (isBootstrappedSuperAdminEmail(emailLower)) {
      const snap = await getDocs(colRef);
      snap.docs.forEach((d) => rememberDocMeta(d.ref.path, d.data()));
      return snap.docs;
    }

    const byOwnerP = getDocs(query(colRef, where('ownerId', '==', user.uid)));
    const byMemberP = emailLower
      ? getDocs(query(colRef, where('memberEmails', 'array-contains', emailLower)))
      : Promise.resolve(null);

    const [byOwner, byMember] = await Promise.all([byOwnerP, byMemberP]);
    const map = new Map<string, QueryDocumentSnapshot<DocumentData>>();
    byOwner.docs.forEach((d) => {
      rememberDocMeta(d.ref.path, d.data());
      map.set(d.id, d);
    });
    if (byMember) {
      byMember.docs.forEach((d) => {
        rememberDocMeta(d.ref.path, d.data());
        map.set(d.id, d);
      });
    }
    return Array.from(map.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, pathLabel);
  }
}

// === AUTHENTICATION ===
export async function signInWithGoogle(rememberDevice: boolean): Promise<User> {
  await setPersistence(
    auth,
    rememberDevice ? browserLocalPersistence : browserSessionPersistence
  );
  const result = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(result.user);
  await syncTeamEmailsCache();
  return result.user;
}

export async function signOutFromFirebase(): Promise<void> {
  stopFirestoreRealtime();
  await signOut(auth);
}

export function subscribeFirebaseAuthState(
  cb: (user: User | null) => void
): Unsubscribe {
  return onAuthStateChanged(auth, cb);
}

export async function ensureUserProfile(userArg?: User | null): Promise<void> {
  const user = userArg || auth.currentUser;
  if (!user) return;
  const userRef = doc(db, 'users', user.uid);
  const privRef = doc(db, 'users', user.uid, 'private', 'info');
  const displayName = clampStr(user.displayName || user.email?.split('@')[0] || 'Operator Gudang', 120) || 'Operator Gudang';
  const email = clampStr(normalizeEmail(user.email), 254);

  try {
    const existing = await getDoc(userRef);
    if (!existing.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        displayName,
        role: 'stockkeeper',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const data = existing.data();
      if (data.displayName !== displayName) {
        await setDoc(
          userRef,
          {
            uid: user.uid,
            displayName,
            role: data.role || 'stockkeeper',
            createdAt: data.createdAt || serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: false }
        );
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
  }

  try {
    const existingPriv = await getDoc(privRef);
    const prevEmail = existingPriv.exists() ? existingPriv.data().email : null;
    if (!existingPriv.exists() || prevEmail !== email) {
      await setDoc(privRef, {
        uid: user.uid,
        email,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/private/info`);
  }
}

// === ROLE ASSIGNMENTS / TEAM ACCESS ===
export async function syncTeamEmailsCache(): Promise<RoleAssignmentRecord[]> {
  const user = auth.currentUser;
  if (!user) return [];
  const emailLower = normalizeEmail(user.email);
  knownTeamEmails.add(BOOTSTRAPPED_SUPER_ADMIN_EMAIL);
  if (emailLower) knownTeamEmails.add(emailLower);

  const colRef = collection(db, 'roleAssignments');
  const out: RoleAssignmentRecord[] = [];
  try {
    let docs: QueryDocumentSnapshot<DocumentData>[] = [];
    if (isBootstrappedSuperAdminEmail(emailLower)) {
      const snap = await getDocs(colRef);
      docs = snap.docs;
    } else if (emailLower) {
      try {
        const snap = await getDocs(colRef);
        docs = snap.docs;
      } catch {
        const selfSnap = await getDoc(doc(db, 'roleAssignments', emailLower));
        if (selfSnap.exists()) {
          const data = selfSnap.data();
          const em = normalizeEmail(data.email || selfSnap.id);
          if (em) knownTeamEmails.add(em);
          out.push({
            id: selfSnap.id,
            email: em,
            displayName: String(data.displayName || ''),
            role: (data.role as RoleAssignmentRecord['role']) || 'stockkeeper',
            assignedByUid: String(data.assignedByUid || ''),
            warehouseId: data.warehouseId ? String(data.warehouseId) : undefined,
            warehouseName: data.warehouseName ? String(data.warehouseName) : undefined,
            createdAt: timestampToIsoString(data.createdAt),
            updatedAt: timestampToIsoString(data.updatedAt),
          });
        }
        return out;
      }
    }

    docs.forEach((d) => {
      rememberDocMeta(d.ref.path, d.data());
      const data = d.data();
      const em = normalizeEmail(data.email || d.id);
      if (em) knownTeamEmails.add(em);
      out.push({
        id: d.id,
        email: em,
        displayName: String(data.displayName || ''),
        role: (data.role as RoleAssignmentRecord['role']) || 'stockkeeper',
        assignedByUid: String(data.assignedByUid || ''),
        warehouseId: data.warehouseId ? String(data.warehouseId) : undefined,
        warehouseName: data.warehouseName ? String(data.warehouseName) : undefined,
        createdAt: timestampToIsoString(data.createdAt),
        updatedAt: timestampToIsoString(data.updatedAt),
      });
    });
    return out;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'roleAssignments');
  }
}

export async function listRoleAssignments(): Promise<RoleAssignmentRecord[]> {
  return syncTeamEmailsCache();
}

export async function saveRoleAssignment(payload: {
  email: string;
  displayName?: string;
  role?: 'stockkeeper' | 'admin' | 'super_admin';
  warehouseId?: string;
  warehouseName?: string;
}): Promise<RoleAssignmentRecord[]> {
  const user = currentUserOrThrow();
  const emailLower = clampStr(normalizeEmail(payload.email), 254);
  if (!emailLower || !emailLower.includes('@')) {
    throw new Error('Format email Google operator tidak valid.');
  }
  const ref = doc(db, 'roleAssignments', emailLower);
  const displayName = clampStr(payload.displayName || emailLower.split('@')[0], 120);
  const role: RoleAssignmentRecord['role'] =
    payload.role === 'admin' || payload.role === 'super_admin' ? payload.role : 'stockkeeper';

  try {
    const existing = await getDoc(ref);
    const baseData: Record<string, unknown> = {
      id: emailLower,
      email: emailLower,
      displayName,
      role,
      assignedByUid: user.uid,
      createdAt: existing.exists() ? existing.data().createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (role === 'stockkeeper' && payload.warehouseId && payload.warehouseName) {
      baseData.warehouseId = sanitizeDocId(payload.warehouseId);
      baseData.warehouseName = clampStr(payload.warehouseName, 120);
    }
    await setDoc(ref, baseData);
    knownTeamEmails.add(emailLower);
    await propagateMemberEmailsToWarehouses();
    return await syncTeamEmailsCache();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `roleAssignments/${emailLower}`);
  }
}

export async function deleteRoleAssignment(email: string): Promise<RoleAssignmentRecord[]> {
  currentUserOrThrow();
  const emailLower = normalizeEmail(email);
  if (!emailLower) throw new Error('Email operator tidak valid.');
  const ref = doc(db, 'roleAssignments', emailLower);
  try {
    const batch = writeBatch(db);
    batch.delete(ref);
    await batch.commit();
    knownTeamEmails.delete(emailLower);
    knownTeamEmails.add(BOOTSTRAPPED_SUPER_ADMIN_EMAIL);
    return await syncTeamEmailsCache();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `roleAssignments/${emailLower}`);
  }
}

async function propagateMemberEmailsToWarehouses(): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  const members = buildMemberEmailsList();
  try {
    const whDocs = await queryTenantDocs(collection(db, 'warehouses'), 'warehouses');
    if (whDocs.length === 0) return;
    const batch = writeBatch(db);
    let ops = 0;
    whDocs.forEach((d) => {
      const data = d.data();
      const canEditRoot =
        data.ownerId === user.uid || isBootstrappedSuperAdminEmail(user.email);
      if (!canEditRoot) return;
      batch.set(
        d.ref,
        {
          id: data.id || d.id,
          ownerId: data.ownerId || user.uid,
          kode: data.kode || 'GP1',
          nama: data.nama || 'Scarlett GP1',
          legacy: Boolean(data.legacy),
          order: toFiniteNumber(data.order, 0),
          cutoff: data.cutoff || '',
          minStock: Math.max(0, toFiniteNumber(data.minStock, 10)),
          mode: data.mode === 'all' ? 'all' : 'mutasi',
          coverDays: Math.max(1, toFiniteNumber(data.coverDays, 7)),
          expMonths: Math.max(1, toFiniteNumber(data.expMonths, 7)),
          memberEmails: members,
          createdAt: data.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: false }
      );
      ops++;
    });
    if (ops > 0) await batch.commit();
  } catch {
    // Abaikan jika operator non-owner tidak memiliki izin update root gudang
  }
}

// === PBKDF2 WEB CRYPTO UNTUK PIN ADMIN & SUPER ADMIN ===
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function derivePinHash(pin: string, saltBytes?: Uint8Array): Promise<string> {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return `pbkdf2_sha256$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPinHash(pin: string, storedHash: string): Promise<boolean> {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2_sha256') return false;
  const saltBytes = hexToBytes(parts[1]);
  const derived = await derivePinHash(pin, saltBytes);
  return timingSafeEqualStr(derived, storedHash);
}

function makeClientPinSessionToken(role: 'admin' | 'super_admin', email: string): {
  token: string;
  role: 'admin' | 'super_admin';
  expiresAt: number;
} {
  const now = Date.now();
  const expiresAt = now + 8 * 60 * 60 * 1000;
  const payload = {
    sub: normalizeEmail(email),
    role,
    iat: now,
    exp: expiresAt,
    src: 'firestore',
  };
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return { token: `${b64}.firestore`, role, expiresAt };
}

async function findActivePinConfigDoc(): Promise<{
  id: string;
  path: string;
  data: DocumentData;
} | null> {
  const docs = await queryTenantDocs(collection(db, 'pinConfigs'), 'pinConfigs');
  if (!docs.length) return null;
  const preferred = docs.find((d) => d.id === SHARED_PIN_CONFIG_ID) || docs[0];
  return {
    id: preferred.id,
    path: preferred.ref.path,
    data: preferred.data(),
  };
}

export async function getFirestorePinStatus(): Promise<PinConfigStatus> {
  currentUserOrThrow();
  const docFound = await findActivePinConfigDoc();
  if (!docFound) {
    return {
      configured: false,
      hasAdminPin: false,
      hasSuperAdminPin: false,
    };
  }
  return {
    configured: Boolean(docFound.data.adminHash && docFound.data.superAdminHash),
    hasAdminPin: Boolean(docFound.data.adminHash),
    hasSuperAdminPin: Boolean(docFound.data.superAdminHash),
    ownerId: String(docFound.data.ownerId || ''),
  };
}

export async function setupFirestorePins(payload: {
  superAdminPin: string;
  adminPin: string;
  currentSuperAdminPin?: string;
  hasActiveSuperSession?: boolean;
}): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
  const user = currentUserOrThrow();
  const superPin = String(payload.superAdminPin || '').trim();
  const adminPin = String(payload.adminPin || '').trim();
  if (superPin.length < 4 || adminPin.length < 4) {
    throw new Error('PIN minimal 4 karakter.');
  }
  if (superPin === adminPin) {
    throw new Error('PIN Super Admin dan PIN Admin tidak boleh sama.');
  }

  const existing = await findActivePinConfigDoc();
  if (existing) {
    const hasSession = Boolean(payload.hasActiveSuperSession);
    const verifiedCurrent =
      payload.currentSuperAdminPin &&
      (await verifyPinHash(payload.currentSuperAdminPin, String(existing.data.superAdminHash || '')));
    if (!hasSession && !verifiedCurrent) {
      throw new Error('Masukkan PIN Super Admin lama atau aktifkan sesi Super Admin terlebih dahulu.');
    }
  }

  const [adminHash, superAdminHash] = await Promise.all([
    derivePinHash(adminPin),
    derivePinHash(superPin),
  ]);
  const targetId = existing ? existing.id : SHARED_PIN_CONFIG_ID;
  const ref = doc(db, 'pinConfigs', targetId);
  const memberEmails = buildMemberEmailsList(existing?.data.memberEmails);

  try {
    await setDoc(ref, {
      id: targetId,
      ownerId: existing ? existing.data.ownerId : user.uid,
      adminHash,
      superAdminHash,
      updatedBy: clampStr(normalizeEmail(user.email) || user.uid, 254),
      memberEmails,
      createdAt: existing ? existing.data.createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `pinConfigs/${targetId}`);
  }

  return makeClientPinSessionToken('super_admin', user.email || '');
}

export async function verifyFirestorePin(
  targetRole: 'admin' | 'super_admin',
  pin: string
): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
  const user = currentUserOrThrow();
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) throw new Error('Masukkan PIN terlebih dahulu.');

  const existing = await findActivePinConfigDoc();
  if (!existing) {
    const err = new Error('PIN cadangan belum diatur. Silakan lakukan pengaturan PIN awal.') as Error & {
      needsSetup?: boolean;
    };
    err.needsSetup = true;
    throw err;
  }

  const adminHash = String(existing.data.adminHash || '');
  const superAdminHash = String(existing.data.superAdminHash || '');

  const ok =
    targetRole === 'super_admin'
      ? await verifyPinHash(cleanPin, superAdminHash)
      : (await verifyPinHash(cleanPin, adminHash)) ||
        (await verifyPinHash(cleanPin, superAdminHash));

  if (!ok) {
    throw new Error('PIN tidak sesuai.');
  }

  return makeClientPinSessionToken(targetRole, user.email || '');
}

// === PULL SNAPSHOT FROM FIRESTORE ===
function emptyWarehouseData(): WarehouseDataCloud {
  const d = new Date();
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  return {
    master: [],
    lokasi: [],
    opening: [],
    allstock: [],
    masuk: [],
    keluar: [],
    pindah: [],
    defect: [],
    batches: [],
    cycleCounts: [],
    inboundRegister: [],
    cutoff,
    min: 10,
    mode: 'mut',
    cover: 7,
    expMonths: 7,
  };
}

export async function pullAllWarehousesFromFirestore(): Promise<CloudWarehouseSnapshot> {
  currentUserOrThrow();
  await syncTeamEmailsCache();

  const whDocs = await queryTenantDocs(collection(db, 'warehouses'), 'warehouses');
  if (whDocs.length === 0) {
    return { warehousesMeta: [], warehouses: {} };
  }

  const sortedMetaDocs = whDocs.slice().sort((a, b) => {
    const ao = toFiniteNumber(a.data().order, 0);
    const bo = toFiniteNumber(b.data().order, 0);
    if (ao !== bo) return ao - bo;
    return String(a.id).localeCompare(String(b.id));
  });

  const warehousesMeta: WarehouseMetaCloud[] = [];
  const warehouses: Record<string, WarehouseDataCloud> = {};

  await Promise.all(
    sortedMetaDocs.map(async (whDoc) => {
      const wData = whDoc.data();
      const wid = whDoc.id;
      warehousesMeta.push({
        id: wid,
        nama: String(wData.nama || wid),
        legacy: Boolean(wData.legacy),
        order: toFiniteNumber(wData.order, 0),
      });

      const wd = emptyWarehouseData();
      wd.cutoff = String(wData.cutoff || wd.cutoff);
      wd.min = Math.max(0, toFiniteNumber(wData.minStock, 10));
      wd.mode = wData.mode === 'all' ? 'all' : 'mut';
      wd.cover = Math.max(1, toFiniteNumber(wData.coverDays, 7));
      wd.expMonths = Math.max(1, toFiniteNumber(wData.expMonths, 7));

      const [
        catalogDocs,
        txDocs,
        batchDocs,
        defectDocs,
        ccDocs,
        inbDocs,
      ] = await Promise.all([
        queryTenantDocs(collection(db, 'warehouses', wid, 'catalog'), `warehouses/${wid}/catalog`),
        queryTenantDocs(collection(db, 'warehouses', wid, 'transactions'), `warehouses/${wid}/transactions`),
        queryTenantDocs(collection(db, 'warehouses', wid, 'batches'), `warehouses/${wid}/batches`),
        queryTenantDocs(collection(db, 'warehouses', wid, 'defects'), `warehouses/${wid}/defects`),
        queryTenantDocs(collection(db, 'warehouses', wid, 'cycleCounts'), `warehouses/${wid}/cycleCounts`),
        queryTenantDocs(collection(db, 'warehouses', wid, 'inboundRegister'), `warehouses/${wid}/inboundRegister`),
      ]);

      catalogDocs.forEach((docSnap) => {
        const c = docSnap.data();
        const kind = String(c.kind || '');
        if (kind === 'master') {
          const item: Record<string, unknown> = {
            barcode: String(c.barcode || ''),
            sku: String(c.sku || ''),
            nama: String(c.nama || ''),
          };
          if (c.kategori) item.kategori = String(c.kategori);
          catalogIdCache.set(`master:${catalogIdentityKey('master', item)}`, docSnap.id);
          wd.master.push(item);
        } else if (kind === 'lokasi') {
          const lokStr = String(c.lok || '').trim();
          if (lokStr) {
            catalogIdCache.set(`lokasi:${lokStr.toUpperCase()}`, docSnap.id);
            wd.lokasi.push(lokStr);
          }
        } else if (kind === 'opening' || kind === 'allstock') {
          const item = {
            lok: String(c.lok || ''),
            barcode: String(c.barcode || ''),
            sku: String(c.sku || ''),
            nama: String(c.nama || ''),
            qty: toFiniteNumber(c.qty, 0),
          };
          catalogIdCache.set(`${kind}:${catalogIdentityKey(kind, item)}`, docSnap.id);
          wd[kind].push(item);
        }
      });

      txDocs.forEach((docSnap) => {
        const t = docSnap.data();
        const txType = String(t.txType || '');
        const base: Record<string, unknown> = {
          id: docSnap.id,
          tgl: String(t.tgl || ''),
          barcode: String(t.barcode || ''),
          sku: String(t.sku || ''),
          nama: String(t.nama || ''),
          lok: String(t.lok || ''),
          dari: String(t.dari || ''),
          ke: String(t.ke || ''),
          qty: toFiniteNumber(t.qty, 0),
          inboundQty: t.inboundQty === null || t.inboundQty === undefined ? null : toFiniteNumber(t.inboundQty, 0),
          sistem: toFiniteNumber(t.sistem, 0),
          fisik: toFiniteNumber(t.fisik, 0),
          selisih: toFiniteNumber(t.selisih, 0),
          exp: String(t.exp || ''),
          batch: String(t.batch || ''),
          ket: String(t.ket || ''),
          by: String(t.by || ''),
          n: toFiniteNumber(t.n, 1),
          ancanthoDone: Boolean(t.ancanthoDone),
          ancanthoBy: String(t.ancanthoBy || ''),
          ancanthoKet: String(t.ancanthoKet || ''),
          ancanthoAt: String(t.ancanthoAt || ''),
        };
        if (t.supplier) base.supplier = String(t.supplier);
        if (t.driver) base.driver = String(t.driver);
        if (t.noPlat) base.noPlat = String(t.noPlat);
        if (t.noDoc) base.noDoc = String(t.noDoc);
        if (t.pairId) base.pairId = String(t.pairId);
        if (t.partnerWhId) base.partnerWhId = String(t.partnerWhId);
        if (t.defectRefId) base.defectRefId = String(t.defectRefId);

        if (txType === 'masuk') wd.masuk.push(base);
        else if (txType === 'keluar') wd.keluar.push(base);
        else if (txType === 'pindah') wd.pindah.push(base);
      });

      batchDocs.forEach((docSnap) => {
        const b = docSnap.data();
        wd.batches.push({
          id: docSnap.id,
          masukId: String(b.masukId || ''),
          tglMasuk: String(b.tglMasuk || ''),
          lok: String(b.lok || ''),
          barcode: String(b.barcode || ''),
          sku: String(b.sku || ''),
          nama: String(b.nama || ''),
          batch: String(b.batch || ''),
          exp: String(b.exp || ''),
          qty: Math.max(0, toFiniteNumber(b.qty, 0)),
          status: String(b.status || 'AKTIF'),
          ket: String(b.ket || ''),
          by: String(b.by || ''),
        });
      });

      defectDocs.forEach((docSnap) => {
        const df = docSnap.data();
        const rec: Record<string, unknown> = {
          id: docSnap.id,
          tgl: String(df.tgl || ''),
          barcode: String(df.barcode || ''),
          sku: String(df.sku || ''),
          nama: String(df.nama || ''),
          lok: String(df.lok || ''),
          kategori: String(df.kategori || ''),
          qty: Math.max(0, toFiniteNumber(df.qty, 0)),
          ket: String(df.ket || ''),
          by: String(df.by || ''),
          status: String(df.status || 'KARANTINA'),
          tindakLanjut: String(df.tindakLanjut || ''),
          resolvedAt: String(df.resolvedAt || ''),
        };
        if (df.sumber) rec.sumber = String(df.sumber);
        if (df.batch) rec.batch = String(df.batch);
        if (df.exp) rec.exp = String(df.exp);
        if (typeof df.potongStok === 'boolean') rec.potongStok = df.potongStok;
        if (df.n !== undefined && df.n !== null) rec.n = toFiniteNumber(df.n, 1);
        if (df.outId) rec.outId = String(df.outId);
        wd.defect.push(rec);
      });

      const cycleSessions = await Promise.all(
        ccDocs.map(async (sessDoc) => {
          const s = sessDoc.data();
          const lineDocs = await queryTenantDocs(
            collection(db, 'warehouses', wid, 'cycleCounts', sessDoc.id, 'lines'),
            `warehouses/${wid}/cycleCounts/${sessDoc.id}/lines`
          );
          const items = lineDocs.map((ld) => {
            const l = ld.data();
            return {
              id: ld.id,
              sku: String(l.sku || ''),
              barcode: String(l.barcode || ''),
              nama: String(l.nama || ''),
              lok: String(l.lok || ''),
              kategori: String(l.kategori || ''),
              assignedTo: String(l.assignedTo || ''),
              stokWms: toFiniteNumber(l.sysQty, 0),
              selisihSebelumnya:
                l.prevDiff === null || l.prevDiff === undefined ? null : toFiniteNumber(l.prevDiff, 0),
              stokFisik:
                l.physQty === null || l.physQty === undefined ? null : toFiniteNumber(l.physQty, 0),
              countedBy: String(l.countedBy || ''),
              countedAt: String(l.countedAt || ''),
              catatan: String(l.notes || ''),
              status: String(l.status || 'MENUNGGU'),
            };
          });
          return {
            id: sessDoc.id,
            tgl: String(s.tgl || ''),
            judul: String(s.judul || 'Cycle Count Harian'),
            status: String(s.status || 'AKTIF'),
            blindCount: Boolean(s.blindCount),
            createdBy: String(s.createdBy || ''),
            createdAt: String(s.createdAtStr || ''),
            closedAt: String(s.closedAt || ''),
            picAdmin: String(s.picAdmin || ''),
            picField: String(s.picField || ''),
            notes: String(s.notes || ''),
            items,
          };
        })
      );
      wd.cycleCounts = cycleSessions;

      inbDocs.forEach((docSnap) => {
        const ib = docSnap.data();
        wd.inboundRegister.push({
          id: docSnap.id,
          tgl: String(ib.tgl || ''),
          supplier: String(ib.supplier || ''),
          driver: String(ib.driver || ''),
          noPlat: String(ib.noPlat || ''),
          noDoc: String(ib.noDoc || ''),
          barcode: String(ib.barcode || ''),
          sku: String(ib.sku || ''),
          nama: String(ib.nama || ''),
          exp: String(ib.exp || ''),
          qty: Math.max(0, toFiniteNumber(ib.qty, 0)),
        });
      });

      warehouses[wid] = wd;
    })
  );

  return { warehousesMeta, warehouses };
}

// === PUSH DIFF TO FIRESTORE (CHUNKED WRITEBATCHES) ===
type BatchOp =
  | { kind: 'set'; path: string; data: DocumentData }
  | { kind: 'delete'; path: string };

async function commitOpsInChunks(ops: BatchOp[]): Promise<void> {
  if (ops.length === 0) return;
  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const chunk = ops.slice(i, i + MAX_BATCH_OPS);
    const batch = writeBatch(db);
    chunk.forEach((op) => {
      const ref = doc(db, op.path);
      if (op.kind === 'set') {
        batch.set(ref, op.data, { merge: false });
      } else {
        batch.delete(ref);
      }
    });
    const firstPath = chunk[0]?.path || 'warehouses';
    const opType = chunk[0]?.kind === 'delete' ? OperationType.DELETE : OperationType.WRITE;
    try {
      await batch.commit();
      chunk.forEach((op) => {
        if (op.kind === 'delete') {
          docOwnerCache.delete(op.path);
          docCreatedAtCache.delete(op.path);
        } else {
          if (typeof op.data.ownerId === 'string') {
            docOwnerCache.set(op.path, op.data.ownerId);
          }
          if (!docCreatedAtCache.has(op.path)) {
            docCreatedAtCache.set(op.path, op.data.createdAt);
          }
        }
      });
    } catch (err) {
      handleFirestoreError(err, opType, firstPath);
    }
  }
}

function ownerAndTimestampsForPath(path: string, isUpdate: boolean, uid: string) {
  const existingOwner = isUpdate ? docOwnerCache.get(path) : undefined;
  const existingCreatedAt = isUpdate ? docCreatedAtCache.get(path) : undefined;
  return {
    ownerId: existingOwner || uid,
    createdAt: existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function serializeWarehouseRoot(
  meta: WarehouseMetaCloud,
  wh: WarehouseDataCloud,
  orderIdx: number,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const wid = sanitizeDocId(meta.id, 'wh');
  const path = `warehouses/${wid}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  return {
    id: wid,
    ownerId: stamps.ownerId,
    kode: clampStr(meta.id.toUpperCase(), 32) || 'GP1',
    nama: clampStr(meta.nama, 120) || 'Scarlett GP1',
    legacy: Boolean(meta.legacy),
    order: Math.max(0, orderIdx),
    cutoff: clampStr(wh.cutoff, 32),
    minStock: Math.max(0, toFiniteNumber(wh.min, 10)),
    mode: wh.mode === 'all' ? 'all' : 'mutasi',
    coverDays: Math.max(1, toFiniteNumber(wh.cover, 7)),
    expMonths: Math.max(1, toFiniteNumber(wh.expMonths, 7)),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
}

function serializeCatalogRecord(
  wid: string,
  itemId: string,
  kind: 'master' | 'lokasi' | 'opening' | 'allstock',
  raw: unknown,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/catalog/${itemId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  if (kind === 'lokasi') {
    return {
      id: itemId,
      warehouseId: wid,
      ownerId: stamps.ownerId,
      kind: 'lokasi',
      barcode: '',
      sku: '',
      nama: '',
      kategori: '',
      lok: clampStr(raw, 128),
      qty: 0,
      memberEmails,
      createdAt: stamps.createdAt,
      updatedAt: stamps.updatedAt,
    };
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: itemId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    kind,
    barcode: clampStr(r.barcode, 128),
    sku: clampStr(r.sku, 128),
    nama: clampStr(r.nama, 256),
    kategori: clampStr(r.kategori, 128),
    lok: clampStr(r.lok, 128),
    qty: toFiniteNumber(r.qty, 0),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
}

function serializeTransactionRecord(
  wid: string,
  txId: string,
  txType: 'masuk' | 'keluar' | 'pindah',
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/transactions/${txId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  const docObj: DocumentData = {
    id: txId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    txType,
    tgl: clampStr(r.tgl, 32),
    barcode: clampStr(r.barcode, 128),
    sku: clampStr(r.sku, 128),
    nama: clampStr(r.nama, 256),
    lok: clampStr(r.lok, 128),
    dari: clampStr(r.dari, 128),
    ke: clampStr(r.ke, 128),
    qty: toFiniteNumber(r.qty, 0),
    inboundQty: r.inboundQty === null || r.inboundQty === undefined || r.inboundQty === '' ? null : toFiniteNumber(r.inboundQty, 0),
    sistem: toFiniteNumber(r.sistem, 0),
    fisik: toFiniteNumber(r.fisik, 0),
    selisih: toFiniteNumber(r.selisih, 0),
    exp: clampStr(r.exp, 32),
    batch: clampStr(r.batch, 128),
    ket: clampStr(r.ket, 500),
    by: clampStr(r.by, 120),
    n: toFiniteNumber(r.n, 1),
    ancanthoDone: Boolean(r.ancanthoDone),
    ancanthoBy: clampStr(r.ancanthoBy, 120),
    ancanthoKet: clampStr(r.ancanthoKet, 500),
    ancanthoAt: clampStr(r.ancanthoAt, 32),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
  if (r.supplier) docObj.supplier = clampStr(r.supplier, 128);
  if (r.driver) docObj.driver = clampStr(r.driver, 128);
  if (r.noPlat) docObj.noPlat = clampStr(r.noPlat, 128);
  if (r.noDoc) docObj.noDoc = clampStr(r.noDoc, 128);
  if (r.pairId) docObj.pairId = clampStr(r.pairId, 128);
  if (r.partnerWhId) docObj.partnerWhId = clampStr(r.partnerWhId, 128);
  if (r.defectRefId) docObj.defectRefId = clampStr(r.defectRefId, 128);
  return docObj;
}

function serializeBatchRecord(
  wid: string,
  batchId: string,
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/batches/${batchId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  const rawStatus = String(r.status || 'AKTIF').toUpperCase();
  const status =
    rawStatus === 'KARANTINA' || rawStatus === 'SELESAI' || rawStatus === 'HABIS'
      ? rawStatus
      : 'AKTIF';
  return {
    id: batchId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    masukId: clampStr(r.masukId, 128),
    tglMasuk: clampStr(r.tglMasuk, 32),
    lok: clampStr(r.lok, 128),
    barcode: clampStr(r.barcode, 128),
    sku: clampStr(r.sku, 128),
    nama: clampStr(r.nama, 256),
    batch: clampStr(r.batch, 128),
    exp: clampStr(r.exp, 32),
    qty: Math.max(0, toFiniteNumber(r.qty, 0)),
    status,
    ket: clampStr(r.ket, 500),
    by: clampStr(r.by, 120),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
}

function serializeDefectRecord(
  wid: string,
  defectId: string,
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/defects/${defectId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  const rawStatus = String(r.status || 'KARANTINA').toUpperCase();
  const allowedStatus = ['KARANTINA', 'RETUR', 'RETUR SUPPLIER', 'MUSNAH', 'REPACK'];
  const status = allowedStatus.includes(rawStatus) ? rawStatus : 'KARANTINA';
  const docObj: DocumentData = {
    id: defectId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    tgl: clampStr(r.tgl, 32),
    barcode: clampStr(r.barcode, 128),
    sku: clampStr(r.sku, 128),
    nama: clampStr(r.nama, 256),
    lok: clampStr(r.lok, 128),
    kategori: clampStr(r.kategori, 128),
    qty: Math.max(0, toFiniteNumber(r.qty, 0)),
    ket: clampStr(r.ket, 500),
    by: clampStr(r.by, 120),
    status,
    tindakLanjut: clampStr(r.tindakLanjut, 256),
    resolvedAt: clampStr(r.resolvedAt, 32),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
  if (r.sumber) docObj.sumber = clampStr(r.sumber, 64);
  if (r.batch) docObj.batch = clampStr(r.batch, 128);
  if (r.exp) docObj.exp = clampStr(r.exp, 32);
  if (typeof r.potongStok === 'boolean') docObj.potongStok = r.potongStok;
  if (r.n !== undefined && r.n !== null) docObj.n = toFiniteNumber(r.n, 1);
  if (r.outId) docObj.outId = clampStr(r.outId, 128);
  return docObj;
}

function serializeCycleSessionRecord(
  wid: string,
  sessionId: string,
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/cycleCounts/${sessionId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  const rawStatus = String(r.status || 'AKTIF').toUpperCase();
  const status = rawStatus === 'OPEN' || rawStatus === 'SELESAI' ? rawStatus : 'AKTIF';
  const docObj: DocumentData = {
    id: sessionId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    tgl: clampStr(r.tgl, 32),
    picAdmin: clampStr(r.picAdmin, 120),
    picField: clampStr(r.picField, 120),
    status,
    notes: clampStr(r.notes, 500),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
  if (r.judul) docObj.judul = clampStr(r.judul, 160);
  if (typeof r.blindCount === 'boolean') docObj.blindCount = r.blindCount;
  if (r.closedAt) docObj.closedAt = clampStr(r.closedAt, 32);
  if (r.createdBy) docObj.createdBy = clampStr(r.createdBy, 120);
  if (r.createdAt) docObj.createdAtStr = clampStr(r.createdAt, 64);
  return docObj;
}

function serializeCycleLineRecord(
  wid: string,
  sessionId: string,
  lineId: string,
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/cycleCounts/${sessionId}/lines/${lineId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  const rawStatus = String(r.status || 'MENUNGGU').toUpperCase();
  const allowedStatus = ['PENDING', 'COUNTED', 'VERIFIED', 'MENUNGGU', 'TERHITUNG', 'TERVERIFIKASI'];
  const status = allowedStatus.includes(rawStatus) ? rawStatus : 'MENUNGGU';
  const physRaw = r.stokFisik !== undefined ? r.stokFisik : r.physQty;
  const prevRaw = r.selisihSebelumnya !== undefined ? r.selisihSebelumnya : r.prevDiff;

  const docObj: DocumentData = {
    id: lineId,
    warehouseId: wid,
    sessionId,
    ownerId: stamps.ownerId,
    sku: clampStr(r.sku, 128),
    barcode: clampStr(r.barcode, 128),
    nama: clampStr(r.nama, 256),
    lok: clampStr(r.lok, 128),
    sysQty: toFiniteNumber(r.stokWms !== undefined ? r.stokWms : r.sysQty, 0),
    prevDiff: prevRaw === null || prevRaw === undefined || prevRaw === '' ? null : toFiniteNumber(prevRaw, 0),
    physQty: physRaw === null || physRaw === undefined || physRaw === '' ? null : toFiniteNumber(physRaw, 0),
    countedBy: clampStr(r.countedBy, 120),
    countedAt: clampStr(r.countedAt, 32),
    notes: clampStr(r.catatan !== undefined ? r.catatan : r.notes, 500),
    status,
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
  if (r.kategori) docObj.kategori = clampStr(r.kategori, 128);
  if (r.assignedTo) docObj.assignedTo = clampStr(r.assignedTo, 120);
  return docObj;
}

function serializeInboundRecord(
  wid: string,
  entryId: string,
  r: Record<string, unknown>,
  uid: string,
  memberEmails: string[],
  isUpdate: boolean
): DocumentData {
  const path = `warehouses/${wid}/inboundRegister/${entryId}`;
  const stamps = ownerAndTimestampsForPath(path, isUpdate, uid);
  return {
    id: entryId,
    warehouseId: wid,
    ownerId: stamps.ownerId,
    tgl: clampStr(r.tgl, 32),
    supplier: clampStr(r.supplier, 128),
    driver: clampStr(r.driver, 128),
    noPlat: clampStr(r.noPlat, 128),
    noDoc: clampStr(r.noDoc, 128),
    barcode: clampStr(r.barcode, 128),
    sku: clampStr(r.sku, 128),
    nama: clampStr(r.nama, 256),
    exp: clampStr(r.exp, 32),
    qty: Math.max(0, toFiniteNumber(r.qty, 0)),
    memberEmails,
    createdAt: stamps.createdAt,
    updatedAt: stamps.updatedAt,
  };
}

function mapCatalogArray(
  kind: 'master' | 'lokasi' | 'opening' | 'allstock',
  arr: unknown[]
): Map<string, unknown> {
  const m = new Map<string, unknown>();
  (Array.isArray(arr) ? arr : []).forEach((item) => {
    const key = catalogIdentityKey(kind, item);
    if (!key) return;
    const docId = deterministicCatalogId(kind, key);
    m.set(docId, item);
  });
  return m;
}

function mapByIdArray(
  arr: unknown[],
  prefix: string
): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  (Array.isArray(arr) ? arr : []).forEach((raw, idx) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const docId = sanitizeDocId(r.id || `${prefix}_${idx}`, prefix);
    m.set(docId, r);
  });
  return m;
}

function warehouseScalarFingerprint(meta: WarehouseMetaCloud, wh: WarehouseDataCloud, orderIdx: number): string {
  return JSON.stringify({
    nama: meta.nama,
    legacy: Boolean(meta.legacy),
    order: orderIdx,
    cutoff: wh.cutoff,
    min: toFiniteNumber(wh.min, 10),
    mode: wh.mode === 'all' ? 'all' : 'mut',
    cover: toFiniteNumber(wh.cover, 7),
    expMonths: toFiniteNumber(wh.expMonths, 7),
  });
}

function cycleSessionHeaderFingerprint(s: Record<string, unknown>): string {
  return JSON.stringify({
    tgl: s.tgl || '',
    judul: s.judul || '',
    status: s.status || 'AKTIF',
    blindCount: Boolean(s.blindCount),
    createdBy: s.createdBy || '',
    createdAt: s.createdAt || '',
    closedAt: s.closedAt || '',
    picAdmin: s.picAdmin || '',
    picField: s.picField || '',
    notes: s.notes || '',
  });
}

export async function pushWarehouseSnapshotDiffToFirestore(
  prevSnap: CloudWarehouseSnapshot | null,
  nextSnap: CloudWarehouseSnapshot
): Promise<void> {
  const user = currentUserOrThrow();
  await ensureUserProfile(user);
  const memberEmails = buildMemberEmailsList();

  const phase1RootSet: BatchOp[] = [];
  const phase2SubOps: BatchOp[] = [];
  const phase3LineOps: BatchOp[] = [];
  const phase4DeleteChildOps: BatchOp[] = [];
  const phase5DeleteParentOps: BatchOp[] = [];

  const prevMetaMap = new Map<string, { meta: WarehouseMetaCloud; orderIdx: number }>();
  (prevSnap?.warehousesMeta || []).forEach((m, idx) => {
    prevMetaMap.set(sanitizeDocId(m.id, 'wh'), { meta: m, orderIdx: idx });
  });

  const nextMetaMap = new Map<string, { meta: WarehouseMetaCloud; orderIdx: number }>();
  nextSnap.warehousesMeta.forEach((m, idx) => {
    nextMetaMap.set(sanitizeDocId(m.id, 'wh'), { meta: m, orderIdx: idx });
  });

  // 1. Gudang yang dihapus (hapus subcollection dulu sebelum root warehouse)
  for (const [wid] of prevMetaMap.entries()) {
    if (nextMetaMap.has(wid)) continue;
    const prevWh = prevSnap?.warehouses?.[wid];
    if (prevWh) {
      (['master', 'lokasi', 'opening', 'allstock'] as const).forEach((kind) => {
        mapCatalogArray(kind, prevWh[kind]).forEach((_val, docId) => {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/catalog/${docId}` });
        });
      });
      (['masuk', 'keluar', 'pindah'] as const).forEach((txType) => {
        mapByIdArray(prevWh[txType], txType).forEach((_val, docId) => {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/transactions/${docId}` });
        });
      });
      mapByIdArray(prevWh.batches, 'batch').forEach((_val, docId) => {
        phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/batches/${docId}` });
      });
      mapByIdArray(prevWh.defect, 'def').forEach((_val, docId) => {
        phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/defects/${docId}` });
      });
      mapByIdArray(prevWh.inboundRegister, 'inb').forEach((_val, docId) => {
        phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/inboundRegister/${docId}` });
      });
      mapByIdArray(prevWh.cycleCounts, 'cc').forEach((sess, sessId) => {
        mapByIdArray((sess.items as unknown[]) || [], 'ccl').forEach((_ln, lineId) => {
          phase4DeleteChildOps.push({
            kind: 'delete',
            path: `warehouses/${wid}/cycleCounts/${sessId}/lines/${lineId}`,
          });
        });
        phase5DeleteParentOps.push({
          kind: 'delete',
          path: `warehouses/${wid}/cycleCounts/${sessId}`,
        });
      });
    }
    phase5DeleteParentOps.push({ kind: 'delete', path: `warehouses/${wid}` });
  }

  // 2. Gudang yang ada atau baru
  nextSnap.warehousesMeta.forEach((meta, orderIdx) => {
    const wid = sanitizeDocId(meta.id, 'wh');
    const nextWh = nextSnap.warehouses[meta.id] || nextSnap.warehouses[wid] || emptyWarehouseData();
    const prevEntry = prevMetaMap.get(wid);
    const prevWh = prevEntry ? prevSnap?.warehouses?.[prevEntry.meta.id] || prevSnap?.warehouses?.[wid] : undefined;

    const rootExistsInCloud = Boolean(prevEntry && docOwnerCache.has(`warehouses/${wid}`));
    const rootChanged =
      !rootExistsInCloud ||
      warehouseScalarFingerprint(prevEntry!.meta, prevWh || emptyWarehouseData(), prevEntry!.orderIdx) !==
        warehouseScalarFingerprint(meta, nextWh, orderIdx);

    if (rootChanged) {
      phase1RootSet.push({
        kind: 'set',
        path: `warehouses/${wid}`,
        data: serializeWarehouseRoot(meta, nextWh, orderIdx, user.uid, memberEmails, rootExistsInCloud),
      });
    }

    // Catalog kinds
    (['master', 'lokasi', 'opening', 'allstock'] as const).forEach((kind) => {
      const prevMap = mapCatalogArray(kind, prevWh?.[kind] || []);
      const nextMap = mapCatalogArray(kind, nextWh[kind] || []);

      prevMap.forEach((_v, itemId) => {
        if (!nextMap.has(itemId)) {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/catalog/${itemId}` });
        }
      });

      nextMap.forEach((nextVal, itemId) => {
        const prevVal = prevMap.get(itemId);
        const isUpdate = prevVal !== undefined && docOwnerCache.has(`warehouses/${wid}/catalog/${itemId}`);
        if (!isUpdate || JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          phase2SubOps.push({
            kind: 'set',
            path: `warehouses/${wid}/catalog/${itemId}`,
            data: serializeCatalogRecord(wid, itemId, kind, nextVal, user.uid, memberEmails, isUpdate),
          });
        }
      });
    });

    // Transactions: masuk, keluar, pindah
    (['masuk', 'keluar', 'pindah'] as const).forEach((txType) => {
      const prevMap = mapByIdArray(prevWh?.[txType] || [], txType);
      const nextMap = mapByIdArray(nextWh[txType] || [], txType);

      prevMap.forEach((_v, txId) => {
        if (!nextMap.has(txId)) {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/transactions/${txId}` });
        }
      });

      nextMap.forEach((nextVal, txId) => {
        const prevVal = prevMap.get(txId);
        const isUpdate = prevVal !== undefined && docOwnerCache.has(`warehouses/${wid}/transactions/${txId}`);
        if (!isUpdate || JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          phase2SubOps.push({
            kind: 'set',
            path: `warehouses/${wid}/transactions/${txId}`,
            data: serializeTransactionRecord(wid, txId, txType, nextVal, user.uid, memberEmails, isUpdate),
          });
        }
      });
    });

    // Batches
    {
      const prevMap = mapByIdArray(prevWh?.batches || [], 'batch');
      const nextMap = mapByIdArray(nextWh.batches || [], 'batch');
      prevMap.forEach((_v, id) => {
        if (!nextMap.has(id)) {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/batches/${id}` });
        }
      });
      nextMap.forEach((nextVal, id) => {
        const prevVal = prevMap.get(id);
        const isUpdate = prevVal !== undefined && docOwnerCache.has(`warehouses/${wid}/batches/${id}`);
        if (!isUpdate || JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          phase2SubOps.push({
            kind: 'set',
            path: `warehouses/${wid}/batches/${id}`,
            data: serializeBatchRecord(wid, id, nextVal, user.uid, memberEmails, isUpdate),
          });
        }
      });
    }

    // Defects
    {
      const prevMap = mapByIdArray(prevWh?.defect || [], 'def');
      const nextMap = mapByIdArray(nextWh.defect || [], 'def');
      prevMap.forEach((_v, id) => {
        if (!nextMap.has(id)) {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/defects/${id}` });
        }
      });
      nextMap.forEach((nextVal, id) => {
        const prevVal = prevMap.get(id);
        const isUpdate = prevVal !== undefined && docOwnerCache.has(`warehouses/${wid}/defects/${id}`);
        if (!isUpdate || JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          phase2SubOps.push({
            kind: 'set',
            path: `warehouses/${wid}/defects/${id}`,
            data: serializeDefectRecord(wid, id, nextVal, user.uid, memberEmails, isUpdate),
          });
        }
      });
    }

    // Inbound Register
    {
      const prevMap = mapByIdArray(prevWh?.inboundRegister || [], 'inb');
      const nextMap = mapByIdArray(nextWh.inboundRegister || [], 'inb');
      prevMap.forEach((_v, id) => {
        if (!nextMap.has(id)) {
          phase4DeleteChildOps.push({ kind: 'delete', path: `warehouses/${wid}/inboundRegister/${id}` });
        }
      });
      nextMap.forEach((nextVal, id) => {
        const prevVal = prevMap.get(id);
        const isUpdate = prevVal !== undefined && docOwnerCache.has(`warehouses/${wid}/inboundRegister/${id}`);
        if (!isUpdate || JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
          phase2SubOps.push({
            kind: 'set',
            path: `warehouses/${wid}/inboundRegister/${id}`,
            data: serializeInboundRecord(wid, id, nextVal, user.uid, memberEmails, isUpdate),
          });
        }
      });
    }

    // Cycle Counts & Lines
    {
      const prevCcMap = mapByIdArray(prevWh?.cycleCounts || [], 'cc');
      const nextCcMap = mapByIdArray(nextWh.cycleCounts || [], 'cc');

      prevCcMap.forEach((prevSess, sessId) => {
        if (!nextCcMap.has(sessId)) {
          mapByIdArray((prevSess.items as unknown[]) || [], 'ccl').forEach((_ln, lineId) => {
            phase4DeleteChildOps.push({
              kind: 'delete',
              path: `warehouses/${wid}/cycleCounts/${sessId}/lines/${lineId}`,
            });
          });
          phase5DeleteParentOps.push({
            kind: 'delete',
            path: `warehouses/${wid}/cycleCounts/${sessId}`,
          });
        }
      });

      nextCcMap.forEach((nextSess, sessId) => {
        const prevSess = prevCcMap.get(sessId);
        const sessPath = `warehouses/${wid}/cycleCounts/${sessId}`;
        const sessIsUpdate = prevSess !== undefined && docOwnerCache.has(sessPath);
        if (
          !sessIsUpdate ||
          cycleSessionHeaderFingerprint(prevSess!) !== cycleSessionHeaderFingerprint(nextSess)
        ) {
          phase2SubOps.push({
            kind: 'set',
            path: sessPath,
            data: serializeCycleSessionRecord(wid, sessId, nextSess, user.uid, memberEmails, sessIsUpdate),
          });
        }

        const prevLineMap = mapByIdArray((prevSess?.items as unknown[]) || [], 'ccl');
        const nextLineMap = mapByIdArray((nextSess.items as unknown[]) || [], 'ccl');

        prevLineMap.forEach((_ln, lineId) => {
          if (!nextLineMap.has(lineId)) {
            phase4DeleteChildOps.push({
              kind: 'delete',
              path: `warehouses/${wid}/cycleCounts/${sessId}/lines/${lineId}`,
            });
          }
        });

        nextLineMap.forEach((nextLn, lineId) => {
          const prevLn = prevLineMap.get(lineId);
          const linePath = `warehouses/${wid}/cycleCounts/${sessId}/lines/${lineId}`;
          const lineIsUpdate = prevLn !== undefined && docOwnerCache.has(linePath);
          if (!lineIsUpdate || JSON.stringify(prevLn) !== JSON.stringify(nextLn)) {
            phase3LineOps.push({
              kind: 'set',
              path: linePath,
              data: serializeCycleLineRecord(wid, sessId, lineId, nextLn, user.uid, memberEmails, lineIsUpdate),
            });
          }
        });
      });
    }
  });

  // Eksekusi berurutan agar parent doc (`warehouses/{wid}` & `cycleCounts/{sessionId}`) eksis sebelum child doc
  // dan child doc terhapus sebelum parent doc (memenuhi exists() pada firestore.rules)
  await commitOpsInChunks(phase1RootSet);
  await commitOpsInChunks(phase2SubOps);
  await commitOpsInChunks(phase3LineOps);
  await commitOpsInChunks(phase4DeleteChildOps);
  await commitOpsInChunks(phase5DeleteParentOps);
}

// === REALTIME LISTENER ===
export function stopFirestoreRealtime(): void {
  activeSnapshotUnsubs.forEach((unsub) => {
    try {
      unsub();
    } catch {
      // ignore
    }
  });
  activeSnapshotUnsubs = [];
}

export function subscribeFirestoreRealtime(
  warehouseIds: string[],
  onRemoteUpdate: () => void
): void {
  stopFirestoreRealtime();
  const user = auth.currentUser;
  if (!user) return;
  const emailLower = normalizeEmail(user.email);
  const bootstrapped = isBootstrappedSuperAdminEmail(emailLower);

  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let initialFiredCount = 0;

  const attachCol = (colRef: CollectionReference<DocumentData>, pathLabel: string) => {
    const queries = bootstrapped
      ? [colRef]
      : [
          query(colRef, where('ownerId', '==', user.uid)),
          ...(emailLower ? [query(colRef, where('memberEmails', 'array-contains', emailLower))] : []),
        ];

    queries.forEach((qRef) => {
      initialFiredCount++;
      let isFirstSnap = true;
      const unsub = onSnapshot(
        qRef,
        (snapshot) => {
          if (isFirstSnap) {
            isFirstSnap = false;
            return;
          }
          if (snapshot.metadata.hasPendingWrites) return;
          if (notifyTimer) clearTimeout(notifyTimer);
          notifyTimer = setTimeout(() => {
            notifyTimer = null;
            onRemoteUpdate();
          }, 250);
        },
        (err) => {
          handleFirestoreError(err, OperationType.GET, pathLabel);
        }
      );
      activeSnapshotUnsubs.push(unsub);
    });
  };

  attachCol(collection(db, 'warehouses'), 'warehouses');
  warehouseIds.forEach((wid) => {
    const cleanId = sanitizeDocId(wid, 'wh');
    attachCol(collection(db, 'warehouses', cleanId, 'catalog'), `warehouses/${cleanId}/catalog`);
    attachCol(collection(db, 'warehouses', cleanId, 'transactions'), `warehouses/${cleanId}/transactions`);
    attachCol(collection(db, 'warehouses', cleanId, 'batches'), `warehouses/${cleanId}/batches`);
    attachCol(collection(db, 'warehouses', cleanId, 'defects'), `warehouses/${cleanId}/defects`);
    attachCol(collection(db, 'warehouses', cleanId, 'cycleCounts'), `warehouses/${cleanId}/cycleCounts`);
    attachCol(collection(db, 'warehouses', cleanId, 'inboundRegister'), `warehouses/${cleanId}/inboundRegister`);
  });

  if (initialFiredCount === 0) return;
}
