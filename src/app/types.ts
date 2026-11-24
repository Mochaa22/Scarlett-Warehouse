export type AppRole = 'stockkeeper' | 'admin' | 'super_admin';

export interface WarehouseMeta {
  id: string;
  nama: string;
  legacy?: boolean;
}

export interface WarehouseRegistry {
  list: WarehouseMeta[];
  cur: string;
  user: string;
}

export interface WarehouseData {
  master: any[];
  lokasi: any[];
  opening: any[];
  allstock: any[];
  masuk: any[];
  keluar: any[];
  pindah: any[];
  defect: any[];
  batches: any[];
  cycleCounts: any[];
  inboundRegister: any[];
  cutoff: string;
  min: number;
  mode: string;
  cover: number;
  expMonths: number;
  [key: string]: any;
}

export interface SyncMeta {
  revision: number;
  updatedAt: number;
  updatedBy: string;
  pending: boolean;
}

export interface SharedSyncState {
  revision: number;
  updatedAt: number;
  updatedBy: string;
  pending: boolean;
  dirty: boolean;
  inFlight: boolean;
  pushing: boolean;
  pulling: boolean;
  storageMode: string;
  hasSessionSecret: boolean;
  lastError: string;
  timer: ReturnType<typeof setTimeout> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  retryCount: number;
  retryDelayMs: number;
  offlineNotified: boolean;
  snapshot: any;
  lastSyncedSnapshot: any;
  pendingRender: boolean;
  lastEditNoticeAt: number;
}

export interface AuthStatusCache {
  loaded: boolean;
  configured: boolean;
  envManaged: boolean;
  authenticated: boolean;
}

export interface PinStatusCache {
  loaded: boolean;
  configured: boolean;
  envManaged: boolean;
  hasAdminPin: boolean;
  hasSuperAdminPin: boolean;
}

export interface SearchFilterState {
  masuk: string;
  keluar: string;
  stok: string;
  semua: string;
  pindah: string;
  defect: string;
  expire: string;
  [key: string]: string;
}

export interface NavItem {
  id: string;
  label: string;
}

export interface NavGroup {
  title: string;
  collapsible: boolean;
  items: NavItem[];
}

declare global {
  const XLSX: any;
  const BarcodeDetector: any;
  interface Window {
    XLSX?: any;
    BarcodeDetector?: any;
    webkitAudioContext?: typeof AudioContext;
    __sgpCloud?: any;
    __lastImportSummary?: any;
    __defectPrefill?: any;
    __keluarPrefill?: any;
    __transferPrefill?: any;
  }
}
