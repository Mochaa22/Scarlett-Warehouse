import './firebase';

export type StorageMode = 'redis' | 'file' | 'ephemeral';

export interface OperatorUserInfo {
  email: string;
  name: string;
  source: 'env' | 'stored';
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
  latest?: {
    revision: number;
    updatedAt: number;
    updatedBy: string;
    warehousesMeta: WarehouseMetaRecord[];
    warehouses: Record<string, Record<string, unknown>>;
  };
}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.toLowerCase().includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const errObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const err = new Error(String(errObj.error || `Request failed (${res.status})`)) as Error & {
      needsSetup?: boolean;
      status?: number;
      conflict?: boolean;
      latest?: unknown;
    };
    err.needsSetup = Boolean(errObj.needsSetup);
    err.status = res.status;
    err.conflict = Boolean(errObj.conflict);
    err.latest = errObj.latest;
    throw err;
  }
  if (!isJson) {
    throw new Error(`Endpoint ${url} tidak mengembalikan JSON (HTTP ${res.status}). Pastikan fungsi /api berjalan di server.`);
  }
  return data as T;
}

export function initCloudBridge(): void {
  if (typeof window === 'undefined') return;

  const cloudApi = {
    appAuth: {
      async getStatus(token: string | null): Promise<{
        configured: boolean;
        envManaged: boolean;
        authenticated: boolean;
        email: string | null;
        role: 'stockkeeper' | 'admin' | 'super_admin' | null;
        storageMode: StorageMode;
        hasSessionSecret: boolean;
      }> {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        return apiJson('/api/auth/status', { method: 'GET', headers, cache: 'no-store' });
      },

      async setup(
        email: string,
        password: string
      ): Promise<{ token: string; email: string; role: 'stockkeeper' | 'admin' | 'super_admin'; expiresAt: number }> {
        return apiJson('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      },

      async login(
        email: string,
        password: string
      ): Promise<{ token: string; email: string; role: 'stockkeeper' | 'admin' | 'super_admin'; expiresAt: number }> {
        return apiJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      },

      async logout(token: string | null): Promise<void> {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        await fetch('/api/auth/logout', { method: 'POST', headers }).catch(() => {});
      },

      async listUsers(
        pinToken: string | null,
        appToken?: string | null
      ): Promise<{
        storageMode: StorageMode;
        primaryEmail: string | null;
        primarySource: 'env' | 'stored' | null;
        envUsers: OperatorUserInfo[];
        users: OperatorUserInfo[];
      }> {
        const headers: Record<string, string> = {};
        if (pinToken) headers['X-Pin-Token'] = pinToken;
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/auth/users', { method: 'GET', headers, cache: 'no-store' });
      },

      async saveUser(
        payload: { email: string; name?: string; password: string },
        pinToken: string | null,
        appToken?: string | null
      ): Promise<{ ok: boolean; storageMode: StorageMode; users: OperatorUserInfo[] }> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (pinToken) headers['X-Pin-Token'] = pinToken;
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/auth/users', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      },

      async deleteUser(
        email: string,
        pinToken: string | null,
        appToken?: string | null
      ): Promise<{ ok: boolean; storageMode: StorageMode; users: OperatorUserInfo[] }> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (pinToken) headers['X-Pin-Token'] = pinToken;
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/auth/users', {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ email }),
        });
      },
    },

    pinAuth: {
      async getStatus(
        pinToken: string | null,
        appToken?: string | null
      ): Promise<{
        configured: boolean;
        envManaged: boolean;
        hasAdminPin: boolean;
        hasSuperAdminPin: boolean;
        sessionValid: boolean;
        sessionRole: 'admin' | 'super_admin' | null;
      }> {
        const headers: Record<string, string> = {};
        if (pinToken) headers.Authorization = `Bearer ${pinToken}`;
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/pin/status', { method: 'GET', headers, cache: 'no-store' });
      },

      async setupPins(
        payload: { superAdminPin: string; adminPin: string; currentSuperAdminPin?: string },
        pinToken: string | null,
        appToken?: string | null
      ): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (pinToken) headers.Authorization = `Bearer ${pinToken}`;
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/pin/setup', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      },

      async verifyPin(
        targetRole: 'admin' | 'super_admin',
        pin: string,
        appToken?: string | null
      ): Promise<{ token: string; role: 'admin' | 'super_admin'; expiresAt: number }> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (appToken) headers['X-App-Auth'] = appToken;
        return apiJson('/api/pin/verify', {
          method: 'POST',
          headers,
          body: JSON.stringify({ targetRole, pin }),
        });
      },
    },

    warehouse: {
      async getState(
        since: number | null,
        appToken?: string | null
      ): Promise<SharedWarehouseStateResponse> {
        const headers: Record<string, string> = {};
        if (appToken) headers['X-App-Auth'] = appToken;
        const qs = typeof since === 'number' && Number.isFinite(since) && since >= 0 ? `?since=${since}` : '';
        return apiJson(`/api/warehouse/state${qs}`, {
          method: 'GET',
          headers,
          cache: 'no-store',
        });
      },

      async saveState(
        payload: {
          baseRevision: number;
          warehousesMeta: WarehouseMetaRecord[];
          warehouses: Record<string, Record<string, unknown>>;
          forceOverwrite?: boolean;
        },
        appToken?: string | null
      ): Promise<SaveWarehouseStateResult> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (appToken) headers['X-App-Auth'] = appToken;
        const res = await fetch('/api/warehouse/state', {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload),
        });
        const contentType = res.headers.get('content-type') || '';
        const isJson = contentType.toLowerCase().includes('application/json');
        if (!isJson) {
          throw new Error(`Endpoint /api/warehouse/state tidak mengembalikan JSON (HTTP ${res.status}).`);
        }
        const data = (await res.json()) as Record<string, unknown>;
        if (res.status === 409 && data.conflict) {
          return {
            ok: false,
            conflict: true,
            revision: 0,
            updatedAt: 0,
            updatedBy: '',
            storageMode: (data.storageMode as StorageMode) || 'file',
            latest: data.latest as SaveWarehouseStateResult['latest'],
          };
        }
        if (!res.ok) {
          const err = new Error(String(data.error || `Gagal menyimpan sinkronisasi (${res.status})`)) as Error & {
            status?: number;
          };
          err.status = res.status;
          throw err;
        }
        return data as unknown as SaveWarehouseStateResult;
      },
    },

    api: {
      async downloadCycleCountCsv(
        lines: Array<Record<string, unknown>>,
        tgl: string,
        warehouseName?: string,
        appToken?: string | null
      ): Promise<string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (appToken) headers['X-App-Auth'] = appToken;
        const res = await fetch('/api/cycle-count/csv', {
          method: 'POST',
          headers,
          body: JSON.stringify({ lines, tgl, warehouseName }),
        });
        if (!res.ok) {
          throw new Error(`Gagal membuat CSV (${res.status})`);
        }
        return res.text();
      },
    },
  };

  (window as unknown as Record<string, unknown>).__sgpCloud = cloudApi;
}
