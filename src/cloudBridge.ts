import { auth } from './firebase.ts';
import {
  deleteRoleAssignment,
  ensureUserProfile,
  getFirestorePinStatus,
  isBootstrappedSuperAdminEmail,
  listRoleAssignments,
  pullAllWarehousesFromFirestore,
  pushWarehouseSnapshotDiffToFirestore,
  saveRoleAssignment,
  setupFirestorePins,
  signInWithGoogle,
  signOutFromFirebase,
  stopFirestoreRealtime,
  subscribeFirebaseAuthState,
  subscribeFirestoreRealtime,
  verifyFirestorePin,
  type CloudWarehouseSnapshot,
} from './firestoreSync.ts';

export type StorageMode = 'firestore' | 'redis' | 'file' | 'ephemeral';

export interface OperatorUserInfo {
  email: string;
  name: string;
  role?: 'stockkeeper' | 'admin' | 'super_admin';
  source: 'firestore' | 'env' | 'stored';
  createdAt?: string;
  updatedAt?: string;
}

export interface WarehouseMetaRecord {
  id: string;
  nama: string;
  legacy?: boolean;
}

export interface SharedWarehouseStateResponse {
  changed: boolean;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  warehousesMeta?: WarehouseMetaRecord[];
  warehouses?: Record<string, Record<string, unknown>>;
  storageMode: StorageMode;
}

export interface SaveWarehouseStateResult {
  ok: boolean;
  conflict?: boolean;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  storageMode: StorageMode;
}

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
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function generateCycleCountCsvLocally(
  lines: Array<Record<string, unknown>>,
  tgl: string,
  warehouseName?: string
): string {
  const dateLabel = formatIndoDateUpper(tgl);
  const whLabel = String(warehouseName || 'ONLINE WAREHOUSE').toUpperCase();
  const rows: string[] = [
    csvSafeCell(`${whLabel} CYCLE COUNT ${dateLabel}`),
    [
      'SKU',
      'NAMA PRODUK',
      'STOK WMS',
      'STOK FISIK',
      'SELISIH SEBELUMNYA',
      'SELISIH HARI INI',
      'TOTAL SELISIH',
    ]
      .map(csvSafeCell)
      .join(','),
  ];

  lines.forEach((ln) => {
    const wms = Number(ln.stokWms ?? ln.sysQty ?? 0);
    const hasPhys =
      ln.stokFisik !== null &&
      ln.stokFisik !== undefined &&
      ln.stokFisik !== '' &&
      Number.isFinite(Number(ln.stokFisik));
    const hasPhysAlt =
      ln.physQty !== null &&
      ln.physQty !== undefined &&
      ln.physQty !== '' &&
      Number.isFinite(Number(ln.physQty));
    const phys = hasPhys ? Number(ln.stokFisik) : hasPhysAlt ? Number(ln.physQty) : '';
    const hasPrev =
      ln.selisihSebelumnya !== null &&
      ln.selisihSebelumnya !== undefined &&
      ln.selisihSebelumnya !== '' &&
      Number.isFinite(Number(ln.selisihSebelumnya));
    const hasPrevAlt =
      ln.prevDiff !== null &&
      ln.prevDiff !== undefined &&
      ln.prevDiff !== '' &&
      Number.isFinite(Number(ln.prevDiff));
    const prevDiff = hasPrev
      ? Number(ln.selisihSebelumnya)
      : hasPrevAlt
      ? Number(ln.prevDiff)
      : '';
    const totalDiff = typeof phys === 'number' ? phys - wms : '';
    const todayDiff =
      typeof totalDiff === 'number'
        ? typeof prevDiff === 'number'
          ? totalDiff - prevDiff
          : totalDiff
        : '';

    rows.push(
      [
        String(ln.sku || ''),
        String(ln.nama || ''),
        wms,
        phys,
        prevDiff,
        todayDiff,
        totalDiff,
      ]
        .map(csvSafeCell)
        .join(',')
    );
  });

  return rows.join('\r\n');
}

function getPinSessionRoleFromToken(pinToken: string | null | undefined): 'admin' | 'super_admin' | null {
  if (!pinToken || typeof pinToken !== 'string') return null;
  const parts = pinToken.split('.');
  if (parts.length !== 2 || !parts[0]) return null;
  try {
    let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const obj = JSON.parse(atob(b64)) as { role?: string; exp?: number };
    if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
    if (obj.role === 'admin' || obj.role === 'super_admin') return obj.role;
    return null;
  } catch {
    return null;
  }
}

export function initCloudBridge(): void {
  if (typeof window === 'undefined') return;

  let lastFirestoreSnap: CloudWarehouseSnapshot | null = null;
  let localSyncSeq = 0;

  const cloudApi = {
    getUser() {
      const u = auth.currentUser;
      if (!u) return null;
      return {
        uid: u.uid,
        email: u.email || '',
        displayName: u.displayName || u.email || 'Operator Gudang',
        emailVerified: Boolean(u.emailVerified),
        isBootstrappedSuperAdmin: isBootstrappedSuperAdminEmail(u.email),
      };
    },

    firebaseAuth: {
      signInWithGoogle,
      signOut: signOutFromFirebase,
      onAuthStateChanged: subscribeFirebaseAuthState,
      ensureProfile: ensureUserProfile,
    },

    appAuth: {
      async listUsers(): Promise<{
        storageMode: StorageMode;
        primaryEmail: string | null;
        primarySource: 'firestore' | null;
        envUsers: OperatorUserInfo[];
        users: OperatorUserInfo[];
      }> {
        const records = await listRoleAssignments();
        const curUser = auth.currentUser;
        return {
          storageMode: 'firestore',
          primaryEmail: curUser?.email || null,
          primarySource: curUser?.email ? 'firestore' : null,
          envUsers: [],
          users: records.map((r) => ({
            email: r.email,
            name: r.displayName || r.email.split('@')[0],
            role: r.role,
            source: 'firestore',
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })),
        };
      },

      async saveUser(payload: {
        email: string;
        name?: string;
        role?: 'stockkeeper' | 'admin' | 'super_admin';
        warehouseId?: string;
        warehouseName?: string;
      }): Promise<{ ok: boolean; storageMode: StorageMode; users: OperatorUserInfo[] }> {
        const records = await saveRoleAssignment({
          email: payload.email,
          displayName: payload.name,
          role: payload.role || 'stockkeeper',
          warehouseId: payload.warehouseId,
          warehouseName: payload.warehouseName,
        });
        return {
          ok: true,
          storageMode: 'firestore',
          users: records.map((r) => ({
            email: r.email,
            name: r.displayName || r.email.split('@')[0],
            role: r.role,
            source: 'firestore',
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })),
        };
      },

      async deleteUser(
        email: string
      ): Promise<{ ok: boolean; storageMode: StorageMode; users: OperatorUserInfo[] }> {
        const records = await deleteRoleAssignment(email);
        return {
          ok: true,
          storageMode: 'firestore',
          users: records.map((r) => ({
            email: r.email,
            name: r.displayName || r.email.split('@')[0],
            role: r.role,
            source: 'firestore',
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })),
        };
      },
    },

    pinAuth: {
      async getStatus(pinToken: string | null): Promise<{
        configured: boolean;
        envManaged: boolean;
        hasAdminPin: boolean;
        hasSuperAdminPin: boolean;
        sessionValid: boolean;
        sessionRole: 'admin' | 'super_admin' | null;
      }> {
        const st = await getFirestorePinStatus();
        const sessionRole = getPinSessionRoleFromToken(pinToken);
        return {
          configured: st.configured,
          envManaged: false,
          hasAdminPin: st.hasAdminPin,
          hasSuperAdminPin: st.hasSuperAdminPin,
          sessionValid: Boolean(sessionRole),
          sessionRole,
        };
      },

      async setupPins(
        payload: { superAdminPin: string; adminPin: string; currentSuperAdminPin?: string },
        pinToken: string | null
      ): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
        const sessionRole = getPinSessionRoleFromToken(pinToken);
        return setupFirestorePins({
          superAdminPin: payload.superAdminPin,
          adminPin: payload.adminPin,
          currentSuperAdminPin: payload.currentSuperAdminPin,
          hasActiveSuperSession: sessionRole === 'super_admin',
        });
      },

      async verifyPin(
        targetRole: 'admin' | 'super_admin',
        pin: string
      ): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
        return verifyFirestorePin(targetRole, pin);
      },
    },

    warehouse: {
      async getState(): Promise<SharedWarehouseStateResponse> {
        const snap = await pullAllWarehousesFromFirestore();
        lastFirestoreSnap = JSON.parse(JSON.stringify(snap)) as CloudWarehouseSnapshot;
        localSyncSeq += 1;
        return {
          changed: true,
          revision: localSyncSeq,
          updatedAt: Date.now(),
          updatedBy: auth.currentUser?.email || '',
          warehousesMeta: snap.warehousesMeta,
          warehouses: snap.warehouses as unknown as Record<string, Record<string, unknown>>,
          storageMode: 'firestore',
        };
      },

      async saveState(payload: {
        baseRevision?: number;
        warehousesMeta: WarehouseMetaRecord[];
        warehouses: Record<string, Record<string, unknown>>;
      }): Promise<SaveWarehouseStateResult> {
        const nextSnap: CloudWarehouseSnapshot = {
          warehousesMeta: payload.warehousesMeta.map((m, idx) => ({
            id: m.id,
            nama: m.nama,
            legacy: Boolean(m.legacy),
            order: idx,
          })),
          warehouses: payload.warehouses as unknown as CloudWarehouseSnapshot['warehouses'],
        };
        await pushWarehouseSnapshotDiffToFirestore(lastFirestoreSnap, nextSnap);
        lastFirestoreSnap = JSON.parse(JSON.stringify(nextSnap)) as CloudWarehouseSnapshot;
        localSyncSeq += 1;
        return {
          ok: true,
          revision: localSyncSeq,
          updatedAt: Date.now(),
          updatedBy: auth.currentUser?.email || '',
          storageMode: 'firestore',
        };
      },

      subscribeRealtime(warehouseIds: string[], onRemoteUpdate: () => void): void {
        subscribeFirestoreRealtime(warehouseIds, onRemoteUpdate);
      },

      stopRealtime(): void {
        stopFirestoreRealtime();
      },
    },

    api: {
      async downloadCycleCountCsv(
        lines: Array<Record<string, unknown>>,
        tgl: string,
        warehouseName?: string
      ): Promise<string> {
        return generateCycleCountCsvLocally(lines, tgl, warehouseName);
      },
    },
  };

  (window as unknown as Record<string, unknown>).__sgpCloud = cloudApi;
}
