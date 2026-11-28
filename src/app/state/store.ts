import type {
  AppRole,
  AuthStatusCache,
  PinStatusCache,
  ReportFilterState,
  SearchFilterState,
  SharedSyncState,
  SyncMeta,
  WarehouseRegistry,
} from '../types.ts';

export const REG_KEY = 'sgp1_W';
export const THEME_KEY = 'sgp1_theme';
export const FIELDS = [
  'master',
  'lokasi',
  'opening',
  'allstock',
  'masuk',
  'keluar',
  'pindah',
  'defect',
  'batches',
  'cycleCounts',
  'inboundRegister',
  'cutoff',
  'min',
  'mode',
  'cover',
  'expMonths',
] as const;

export const SYNC_META_KEY = 'sgp1_sync_meta';
export const SYNC_BASE_KEY = 'sgp1_sync_base';
export const AUTH_TOKEN_KEY = 'sgp1_auth_token';
export const AUTH_SESSION_TOKEN_KEY = 'sgp1_auth_session_token';
export const AUTH_REMEMBER_KEY = 'sgp1_auth_remember';
export const PIN_TOKEN_KEY = 'sgp1_pin_token';
export const PIN_ROLE_KEY = 'sgp1_pin_role';
export const ACTIVE_TAB_KEY = 'sgp1_active_tab';
export const SOUND_KEY = 'sgp1_sound';

export const ROLE_LABELS: Record<AppRole, string> = {
  stockkeeper: 'Stockkeeper',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

export const SECONDARY_TABS = new Set([
  'defect',
  'expire',
  'cyclecount',
  'transfer',
  'opname',
  'semua',
  'analitik',
  'cek',
  'gudang',
  'master',
  'pengaturan',
]);

export const ICONS: Record<string, string> = {
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  masuk: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  inbound: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  keluar: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 20h14"/>',
  whatsapp:
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  defect:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  expire: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  transfer:
    '<path d="m17 3 4 4-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/>',
  pindah:
    '<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  opname: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6"/><path d="m9 13 2 2 4-4"/>',
  cyclecount:
    '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/>',
  stok:
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  semua:
    '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  analitik: '<path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-6"/>',
  cek: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  gudang:
    '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/>',
  master:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  pengaturan:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  autoTheme:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 8l5-3"/><path d="M12 13l5-3"/><path d="M12 18l5-3"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  table:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="10" x2="9" y2="20"/>',
};

let toastListener: ((msg: string, type?: string) => void) | null = null;
export function registerToastHandler(fn: (msg: string, type?: string) => void): void {
  toastListener = fn;
}

export function safeGet<T = any>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeGetRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, val: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch {
    appState.storageQuotaError = true;
    const banner = document.getElementById('storage-banner');
    if (banner) banner.classList.add('visible');
    if (toastListener) toastListener('Penyimpanan browser penuh! Segera backup data JSON.', 'err');
    return false;
  }
}

export function safeSetRaw(key: string, val: string): void {
  try {
    localStorage.setItem(key, String(val));
  } catch {
    // ignore storage quota errors on raw flags
  }
}

export function safeDel(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function sessionGetRaw(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSetRaw(key: string, val: string | null | undefined): void {
  try {
    if (val === null || val === undefined || val === '') sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, String(val));
  } catch {
    // ignore
  }
}

function loadInitialSyncMeta(): SyncMeta {
  const m = safeGet<Partial<SyncMeta> | null>(SYNC_META_KEY, null);
  return {
    revision: m && typeof m.revision === 'number' ? m.revision : 0,
    updatedAt: m && typeof m.updatedAt === 'number' ? m.updatedAt : 0,
    updatedBy: m && typeof m.updatedBy === 'string' ? m.updatedBy : '',
    pending: Boolean(m && m.pending),
  };
}

function readInitialAuth() {
  safeDel(AUTH_TOKEN_KEY);
  sessionSetRaw(AUTH_SESSION_TOKEN_KEY, '');
  sessionSetRaw(PIN_TOKEN_KEY, '');
  sessionSetRaw(PIN_ROLE_KEY, '');
  return {
    rememberDevice: safeGetRaw(AUTH_REMEMBER_KEY) !== '0',
    token: '',
    email: '',
    pinToken: '',
    pinRole: null as 'admin' | 'super_admin' | null,
  };
}

const initMeta = loadInitialSyncMeta();
const initAuth = readInitialAuth();
const savedTabOnBoot = sessionGetRaw(ACTIVE_TAB_KEY);

export interface AppStateContainer {
  initialHtmlSnapshot: string;
  storageQuotaError: boolean;
  W: WarehouseRegistry;
  sharedSyncState: SharedSyncState;
  currentTab: string;
  searchState: SearchFilterState;
  stokFilter: string;
  stokCategoryFilter: string;
  defectFilter: string;
  expFilter: string;
  otherMenusOpen: boolean;
  inboundFilter: string;
  inboundPeriod: string;
  inboundFrom: string;
  inboundTo: string;
  inboundSearch: string;
  masukPeriod: string;
  masukFrom: string;
  masukTo: string;
  masukStatus: string;
  keluarPeriod: string;
  keluarFrom: string;
  keluarTo: string;
  reportFilter: ReportFilterState;
  masterSearch: string;
  rapidScanKeluar: boolean;
  lastRapidKeluarId: string;
  settingsTab: string;
  appAuthRememberDevice: boolean;
  appAuthToken: string;
  appAuthEmail: string;
  appAuthSessionRole: AppRole | null;
  appAuthStatusCache: AuthStatusCache;
  pinSessionToken: string;
  pinSessionRole: 'admin' | 'super_admin' | null;
  rolePreviewOverride: AppRole | '';
  pinStatusCache: PinStatusCache;
  authTransitionSeq: number;
  pinTransitionSeq: number;
  confirmCb: (() => void) | null;
  textModalActionCb: (() => void) | null;
  bulkTxSubmitCb: (() => void) | null;
  soundEnabled: boolean;
  scanPref: { lockLoc: boolean; lastLoc: string; autoSave: boolean };
  audioCtx: AudioContext | null;
  activeScanStream: MediaStream | null;
  activeScanRaf: number;
  activeTorchOn: boolean;
  masukRole: string;
  masukEditId: string;
  masukStockkeeperName: string;
  masukAdminName: string;
  keluarRole: string;
  keluarAdminFilter: string;
  keluarEditId: string;
  keluarStockkeeperName: string;
  keluarAdminName: string;
  opnameSelectedLoc: string;
  cycleRole: string;
  cycleAdminTab: string;
  cycleSelectedSessionId: string;
  cyclePetugasFilter: string;
  cycleAdminSearch: string;
  cyclePickerSearch: string;
  cyclePickerCat: string;
  cyclePickerFilter: string;
  cycleAssignPetugas: string;
  cycleSelectedSkus: Set<string>;
  cycleScanAutoInc: boolean;
}

export const appState: AppStateContainer = {
  initialHtmlSnapshot: '',
  storageQuotaError: false,
  W: { list: [], cur: 'gp1', user: 'Admin Gudang' },
  sharedSyncState: {
    revision: initMeta.revision,
    updatedAt: initMeta.updatedAt,
    updatedBy: initMeta.updatedBy,
    pending: initMeta.pending,
    dirty: Boolean(initMeta.pending),
    inFlight: false,
    pushing: false,
    pulling: false,
    storageMode: 'file',
    hasSessionSecret: true,
    lastError: '',
    timer: null,
    pushTimer: null,
    retryTimer: null,
    pollTimer: null,
    retryCount: 0,
    retryDelayMs: 2500,
    offlineNotified: false,
    snapshot: safeGet(SYNC_BASE_KEY, null),
    lastSyncedSnapshot: safeGet(SYNC_BASE_KEY, null),
    pendingRender: false,
    lastEditNoticeAt: 0,
    initialCloudLoaded: false,
  },
  currentTab: savedTabOnBoot || 'masuk',
  searchState: { masuk: '', keluar: '', stok: '', semua: '', pindah: '', defect: '', expire: '' },
  stokFilter: 'all',
  stokCategoryFilter: '',
  defectFilter: 'KARANTINA',
  expFilter: 'alert',
  otherMenusOpen: false,
  inboundFilter: 'pending',
  inboundPeriod: 'all',
  inboundFrom: '',
  inboundTo: '',
  inboundSearch: '',
  masukPeriod: 'all',
  masukFrom: '',
  masukTo: '',
  masukStatus: 'all',
  keluarPeriod: 'all',
  keluarFrom: '',
  keluarTo: '',
  reportFilter: { category: 'all', period: 'all', from: '', to: '', status: 'all', q: '' },
  masterSearch: '',
  rapidScanKeluar: false,
  lastRapidKeluarId: '',
  settingsTab: 'role',
  appAuthRememberDevice: initAuth.rememberDevice,
  appAuthToken: initAuth.token,
  appAuthEmail: initAuth.email,
  appAuthSessionRole: null,
  appAuthStatusCache: { loaded: false, configured: true, envManaged: false, authenticated: false },
  pinSessionToken: initAuth.pinToken,
  pinSessionRole: initAuth.pinRole,
  rolePreviewOverride: '',
  pinStatusCache: { loaded: false, configured: false, envManaged: false, hasAdminPin: false, hasSuperAdminPin: false },
  authTransitionSeq: 0,
  pinTransitionSeq: 0,
  confirmCb: null,
  textModalActionCb: null,
  bulkTxSubmitCb: null,
  soundEnabled: safeGet<boolean>(SOUND_KEY, true) !== false,
  scanPref: { lockLoc: false, lastLoc: '', autoSave: false },
  audioCtx: null,
  activeScanStream: null,
  activeScanRaf: 0,
  activeTorchOn: false,
  masukRole: 'stockkeeper',
  masukEditId: '',
  masukStockkeeperName: '',
  masukAdminName: '',
  keluarRole: 'stockkeeper',
  keluarAdminFilter: 'pending',
  keluarEditId: '',
  keluarStockkeeperName: '',
  keluarAdminName: '',
  opnameSelectedLoc: '',
  cycleRole: 'admin',
  cycleAdminTab: 'pantau',
  cycleSelectedSessionId: '',
  cyclePetugasFilter: 'all',
  cycleAdminSearch: '',
  cyclePickerSearch: '',
  cyclePickerCat: '',
  cyclePickerFilter: 'all',
  cycleAssignPetugas: 'Semua Petugas',
  cycleSelectedSkus: new Set<string>(),
  cycleScanAutoInc: false,
};

let appRenderer: (() => void) | null = null;
export function registerAppRenderer(fn: () => void): void {
  appRenderer = fn;
}

export function renderApp(): void {
  if (appRenderer) appRenderer();
}
