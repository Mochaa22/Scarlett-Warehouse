import './firebase';

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
    };
    err.needsSetup = Boolean(errObj.needsSetup);
    err.status = res.status;
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
      }> {
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        return apiJson('/api/auth/status', { method: 'GET', headers });
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
        return apiJson('/api/pin/status', { method: 'GET', headers });
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
