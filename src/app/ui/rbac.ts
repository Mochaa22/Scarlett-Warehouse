import { AUTH_REMEMBER_KEY, AUTH_SESSION_TOKEN_KEY, AUTH_TOKEN_KEY, PIN_ROLE_KEY, PIN_TOKEN_KEY, ROLE_LABELS, appState, renderApp, safeDel, safeSetRaw, sessionSetRaw } from '../state/store.ts';
import { syncAppAuthStatus } from './authGate.ts';
import { showToast } from './feedback.ts';
import { esc } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

export function waitForCloudBridge(maxWaitMs = 2000): Promise<any> {
  if (window.__sgpCloud) return Promise.resolve(window.__sgpCloud);
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve) => {
    const check = () => {
      if (window.__sgpCloud || Date.now() >= deadline) {
        resolve(window.__sgpCloud || null);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

export function persistAppAuthToken(tok?: string | null, rememberOpt?: boolean) {
  appState.appAuthToken = String(tok || '').trim();
  if (typeof rememberOpt === 'boolean') {
    appState.appAuthRememberDevice = rememberOpt;
    safeSetRaw(AUTH_REMEMBER_KEY, rememberOpt ? '1' : '0');
  }
  safeDel(AUTH_TOKEN_KEY);
  sessionSetRaw(AUTH_SESSION_TOKEN_KEY, '');
}

export function persistPinSession(tok?: string | null, role?: string | null) {
  appState.pinSessionToken = String(tok || '').trim();
  appState.pinSessionRole = (role === 'admin' || role === 'super_admin') ? role : null;
  sessionSetRaw(PIN_TOKEN_KEY, '');
  sessionSetRaw(PIN_ROLE_KEY, '');
}

export function normalizeAppRole(r) {
  var s = String(r || '').trim().toLowerCase();
  if (s === 'super_admin' || s === 'owner') return 'super_admin';
  if (s === 'admin') return 'admin';
  return 'stockkeeper';
}

export function roleRank(r) {
  var n = normalizeAppRole(r);
  if (n === 'super_admin') return 3;
  if (n === 'admin') return 2;
  return 1;
}

export function getVerifiedMaxRole() {
  var rP = appState.pinSessionRole ? roleRank(appState.pinSessionRole) : 1;
  var rA = appState.appAuthSessionRole ? roleRank(appState.appAuthSessionRole) : 1;
  var maxR = Math.max(rP, rA);
  if (maxR >= 3) return 'super_admin';
  if (maxR === 2) return 'admin';
  return 'stockkeeper';
}

export function getEffectiveRole() {
  var maxRole = getVerifiedMaxRole();
  if (appState.rolePreviewOverride && roleRank(appState.rolePreviewOverride) <= roleRank(maxRole)) {
    return normalizeAppRole(appState.rolePreviewOverride);
  }
  return maxRole;
}

export function getSelectableWarehouses(_role?: any) {
  return appState.W.list;
}

export function defaultTabForRole(role) {
  return normalizeAppRole(role) === 'stockkeeper' ? 'masuk' : 'dashboard';
}

export function getAllowedTabsForRole(role) {
  var r = normalizeAppRole(role);
  if (r === 'stockkeeper') return ['masuk', 'keluar', 'pindah', 'transfer', 'stok'];
  if (r === 'admin') return ['dashboard', 'masuk', 'inbound', 'keluar', 'pindah', 'transfer', 'stok'];
  return ['dashboard', 'masuk', 'inbound', 'keluar', 'pindah', 'stok', 'pengaturan', 'defect', 'expire', 'cyclecount', 'transfer', 'opname', 'semua', 'analitik', 'cek', 'gudang', 'master'];
}

export function enforceRoleRouteGuard() {
  var role = getEffectiveRole();
  var allowed = getAllowedTabsForRole(role);
  if (allowed.indexOf(appState.currentTab) < 0) {
    appState.currentTab = defaultTabForRole(role);
  }
  if (role === 'stockkeeper') {
    appState.keluarRole = 'stockkeeper';
  }
  return role;
}

export function getNavGroupsForRole(role) {
  var r = normalizeAppRole(role);
  if (r === 'stockkeeper') {
    return [
      {
        title: 'Input Lapangan',
        collapsible: false,
        items: [
          { id: 'masuk', label: 'Barang Masuk' },
          { id: 'keluar', label: 'Barang Keluar' },
          { id: 'pindah', label: 'Perpindahan Barang' },
          { id: 'transfer', label: 'Pindah Gudang' },
          { id: 'stok', label: 'Stok Aktif' }
        ]
      }
    ];
  }
  if (r === 'admin') {
    return [
      {
        title: 'Operasional Gudang',
        collapsible: false,
        items: [
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'masuk', label: 'Barang Masuk' },
          { id: 'inbound', label: 'Surat Jalan' },
          { id: 'keluar', label: 'Barang Keluar' },
          { id: 'pindah', label: 'Perpindahan Barang' },
          { id: 'transfer', label: 'Pindah Gudang' },
          { id: 'stok', label: 'Stok Aktif' }
        ]
      }
    ];
  }
  return [
    {
      title: 'Operasional Gudang',
      collapsible: false,
      items: [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'masuk', label: 'Barang Masuk' },
        { id: 'inbound', label: 'Surat Jalan' },
        { id: 'keluar', label: 'Barang Keluar' },
        { id: 'pindah', label: 'Perpindahan Barang' },
        { id: 'stok', label: 'Stok Aktif' }
      ]
    },
    {
      title: 'Administrasi Sistem',
      collapsible: false,
      items: [
        { id: 'pengaturan', label: 'Pengaturan & Master' }
      ]
    }
  ];
}

export const NAV_GROUPS = getNavGroupsForRole('super_admin');

// === MODAL PILIH ROLE & VERIFIKASI PIN ===
export function closeRoleModal() {
  var modal = byId('role-modal');
  if (modal) modal.classList.remove('open');
}

export async function refreshPinStatus() {
  var cloud = await waitForCloudBridge(2000);
  if (!cloud || !cloud.pinAuth) return appState.pinStatusCache;
  var myPinSeq = ++appState.pinTransitionSeq;
  try {
    var res = await cloud.pinAuth.getStatus(appState.pinSessionToken || null, appState.appAuthToken || null);
    if (myPinSeq !== appState.pinTransitionSeq) return appState.pinStatusCache;
    appState.pinStatusCache = {
      loaded: true,
      configured: !!res.configured,
      envManaged: !!res.envManaged,
      hasAdminPin: !!res.hasAdminPin,
      hasSuperAdminPin: !!res.hasSuperAdminPin
    };
    if (appState.pinSessionToken && !res.sessionValid) {
      persistPinSession('', null);
      appState.rolePreviewOverride = '';
      try { renderApp(); } catch (re) { console.error(re); }
    } else if (res.sessionValid && res.sessionRole && appState.pinSessionRole !== res.sessionRole) {
      persistPinSession(appState.pinSessionToken, res.sessionRole);
      try { renderApp(); } catch (re) { console.error(re); }
    }
  } catch {
    if (myPinSeq === appState.pinTransitionSeq) {
      appState.pinStatusCache.loaded = false;
    }
  }
  return appState.pinStatusCache;
}

export async function openRoleModal(preselectTarget?: string) {
  var modal = byId('role-modal');
  var body = byId('role-modal-body');
  if (!modal || !body) return;
  modal.classList.add('open');

  await refreshPinStatus();

  var effectiveRole = getEffectiveRole();
  var maxVerifiedRole = getVerifiedMaxRole();
  var pendingTarget = preselectTarget || '';

  function renderModalBody() {
    var html = '<p class="muted" style="margin-top:0;font-size:13px">' +
      (appState.appAuthEmail
        ? 'Akun: <strong>' + esc(appState.appAuthEmail) + '</strong> · '
        : '') +
      'Role aktif: <strong>' + esc(ROLE_LABELS[effectiveRole]) + '</strong>. Untuk masuk ke mode Admin atau Super Admin, masukkan PIN terlebih dahulu.</p>';

    var cards = [
      {
        id: 'stockkeeper',
        title: 'Stockkeeper',
        desc: 'Role default setelah masuk: Barang Masuk, Barang Keluar, Perpindahan Barang, Pindah Gudang, dan Stok Aktif.'
      },
      {
        id: 'admin',
        title: 'Admin',
        desc: 'Operasional harian: Dashboard, Surat Jalan, Barang Masuk, Barang Keluar, Perpindahan, Pindah Gudang, dan Stok Aktif.'
      },
      {
        id: 'super_admin',
        title: 'Super Admin',
        desc: 'Akses penuh + Pengaturan & Master: kelola PIN akses, master SKU, gudang, dan alat lanjutan.'
      }
    ];

    html += '<div class="role-card-grid">';
    cards.forEach(function (c) {
      var isCur = effectiveRole === c.id;
      var unlocked = roleRank(c.id) <= roleRank(maxVerifiedRole);
      html += '<button type="button" class="role-card' + (isCur ? ' active' : '') + '" data-pick-role="' + c.id + '">' +
        '<div class="role-card-title"><span>' + esc(c.title) + '</span>' +
        '<span class="muted" style="font-size:12px">' + (isCur ? 'Aktif saat ini' : (unlocked ? 'Langsung aktif' : 'Perlu PIN')) + '</span></div>' +
        '<div class="role-card-desc">' + esc(c.desc) + '</div>' +
        '</button>';
    });
    html += '</div>';

    if (appState.pinSessionToken && appState.pinSessionRole) {
      html += '<div style="margin-bottom:12px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="btn btn-sm btn-danger" id="modal-pin-lock-btn">Kunci Sesi PIN (Kembali ke Stockkeeper)</button>' +
        '</div>';
    }

    if (pendingTarget && (pendingTarget === 'admin' || pendingTarget === 'super_admin')) {
      if (!appState.pinStatusCache.loaded) {
        html += '<div class="inline-alert warn">Status PIN belum bisa diperiksa. Tutup menu ini lalu buka lagi untuk mencoba ulang.</div>';
      } else if (!appState.pinStatusCache.configured && !appState.pinStatusCache.envManaged) {
        html += '<div class="card" style="margin:0;padding:14px">' +
          '<h4 style="margin:0 0 6px;font-size:14px">Pengaturan Awal PIN Admin &amp; Super Admin</h4>' +
          '<p class="muted" style="margin:0 0 12px;font-size:12.5px">PIN belum dikonfigurasi. Buat PIN Super Admin dan PIN Admin terlebih dahulu agar akses kedua role tersebut terkunci dengan aman.</p>' +
          '<form id="form-first-pin">' +
          '<div class="field" style="margin-bottom:10px"><label for="setup-super-pin">PIN Super Admin (min. 4 karakter)</label><input id="setup-super-pin" autocomplete="new-password" maxlength="24" type="password" inputmode="numeric" class="input" required minlength="4" placeholder="Mis. 2580" /></div>' +
          '<div class="field" style="margin-bottom:12px"><label for="setup-admin-pin">PIN Admin (harus berbeda)</label><input id="setup-admin-pin" autocomplete="new-password" maxlength="24" type="password" inputmode="numeric" class="input" required minlength="4" placeholder="Mis. 1357" /></div>' +
          '<button type="submit" class="btn btn-primary" style="width:100%">Simpan PIN &amp; Masuk Super Admin</button>' +
          '</form></div>';
      } else {
        html += '<div class="card" style="margin:0;padding:14px">' +
          '<form id="form-verify-pin">' +
          '<div class="field" style="margin-bottom:10px"><label for="verify-pin-inp">Masukkan PIN ' + esc(ROLE_LABELS[pendingTarget]) + '</label>' +
          '<input id="verify-pin-inp" type="password" inputmode="numeric" class="input" required placeholder="Masukkan PIN…" autocomplete="off" /></div>' +
          '<div style="display:flex;gap:8px">' +
          '<button type="submit" class="btn btn-primary" style="flex:1">Buka ' + esc(ROLE_LABELS[pendingTarget]) + '</button>' +
          '<button type="button" class="btn" id="cancel-pin-btn">Batal</button>' +
          '</div></form></div>';
      }
    }

    body.innerHTML = html;

    body.querySelectorAll('[data-pick-role]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-pick-role');
        if (roleRank(target) <= roleRank(maxVerifiedRole)) {
          appState.rolePreviewOverride = (target === maxVerifiedRole ? '' : target) as any;
          appState.currentTab = defaultTabForRole(target);
          closeRoleModal();
          showToast('Beralih ke mode ' + ROLE_LABELS[target], 'ok');
          try { renderApp(); } catch (re) { console.error(re); showToast('Gagal merender tampilan role: ' + ((re && re.message) || 'coba muat ulang'), 'err'); }
        } else {
          pendingTarget = target;
          renderModalBody();
          setTimeout(function () {
            var inp = byId('verify-pin-inp') || byId('setup-super-pin');
            if (inp) inp.focus();
          }, 30);
        }
      });
    });

    var lockPinBtn = byId('modal-pin-lock-btn');
    if (lockPinBtn) {
      lockPinBtn.addEventListener('click', function () {
        appState.pinTransitionSeq += 1;
        persistPinSession('', null);
        appState.rolePreviewOverride = '';
        appState.currentTab = defaultTabForRole(getEffectiveRole());
        closeRoleModal();
        showToast('Akses PIN dikunci. Kembali ke mode Stockkeeper.', 'ok');
        try { renderApp(); } catch (re) { console.error(re); }
      });
    }

    var cancelPinBtn = byId('cancel-pin-btn');
    if (cancelPinBtn) {
      cancelPinBtn.addEventListener('click', function () {
        pendingTarget = '';
        renderModalBody();
      });
    }

    var firstPinForm = byId('form-first-pin');
    if (firstPinForm) {
      firstPinForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var superPin = (byId('setup-super-pin') as HTMLInputElement).value.trim();
        var adminInput = byId('setup-admin-pin') as HTMLInputElement;
        var adminPin = adminInput.value.trim();
        if (superPin === adminPin) {
          showToast('Kedua PIN terisi sama. Isi kolom Admin dengan PIN lain, lalu simpan kembali.', 'err');
          adminInput.focus();
          adminInput.select();
          return;
        }
        try {
          var cloud = await waitForCloudBridge(2000);
          if (!cloud || !cloud.pinAuth) throw new Error('Koneksi modul autentikasi belum siap. Coba lagi.');
          var res = await cloud.pinAuth.setupPins(
            { superAdminPin: superPin, adminPin: adminPin },
            null,
            appState.appAuthToken || null
          );
          appState.pinTransitionSeq += 1;
          persistPinSession(res.token, res.role);
          appState.rolePreviewOverride = '';
          appState.pinStatusCache.loaded = true;
          appState.pinStatusCache.configured = true;
          appState.pinStatusCache.hasAdminPin = true;
          appState.pinStatusCache.hasSuperAdminPin = true;
          appState.currentTab = defaultTabForRole(res.role);
          closeRoleModal();
          showToast('PIN berhasil disimpan. Mode Super Admin aktif.', 'ok');
          try { renderApp(); } catch (re) { console.error(re); showToast('Gagal merender tampilan Super Admin: ' + ((re && re.message) || 'coba lagi'), 'err'); }
        } catch (err) {
          if (err && err.status === 401) {
            showToast('Sesi login tidak terverifikasi di server. Mencoba menyegarkan sesi…', 'warn');
            void syncAppAuthStatus(true);
          } else {
            showToast((err && err.message) || 'Gagal menyimpan PIN', 'err');
          }
        }
      });
    }

    var verifyForm = byId('form-verify-pin');
    if (verifyForm) {
      verifyForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pinVal = byId('verify-pin-inp').value.trim();
        try {
          var cloud = await waitForCloudBridge(2000);
          if (!cloud || !cloud.pinAuth) throw new Error('Koneksi modul autentikasi belum siap. Coba lagi.');
          var res = await cloud.pinAuth.verifyPin(pendingTarget, pinVal, appState.appAuthToken || null);
          appState.pinTransitionSeq += 1;
          persistPinSession(res.token, res.role);
          appState.rolePreviewOverride = '';
          appState.pinStatusCache.loaded = true;
          appState.currentTab = defaultTabForRole(res.role);
          closeRoleModal();
          showToast('Role ' + ROLE_LABELS[res.role] + ' dibuka', 'ok');
          try { renderApp(); } catch (re) { console.error(re); showToast('Gagal merender tampilan ' + ROLE_LABELS[res.role] + ': ' + ((re && re.message) || 'coba lagi'), 'err'); }
        } catch (err) {
          if (err && err.needsSetup) {
            appState.pinStatusCache.configured = false;
            renderModalBody();
          } else if (err && err.status === 401 && String((err && err.message) || '').toLowerCase().includes('email')) {
            showToast('Sesi login tidak terverifikasi di server. Silakan masuk ulang.', 'warn');
            void syncAppAuthStatus(true);
          } else {
            showToast((err && err.message) || 'PIN salah', 'err');
          }
        }
      });
    }
  }

  renderModalBody();
}
