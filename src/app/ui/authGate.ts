import {
  isUserEditingFormInView,
  pullSharedWarehouseState,
  pushSharedWarehouseState,
  saveRegistry,
  startSharedSyncLoop,
  stopSharedSyncLoop,
  updateSyncButtonUI,
} from '../core/warehouseRegistry.ts';
import { ACTIVE_TAB_KEY, appState, renderApp, sessionSetRaw } from '../state/store.ts';
import { confirmDialog, showToast } from './feedback.ts';
import {
  defaultTabForRole,
  getAllowedTabsForRole,
  getEffectiveRole,
  normalizeAppRole,
  persistAppAuthToken,
  persistPinSession,
  refreshPinStatus,
  waitForCloudBridge,
} from './rbac.ts';
import { esc } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

function formatFirebaseAuthError(err: unknown): string {
  const code = String((err as { code?: string })?.code || '');
  const message = String((err as { message?: string })?.message || '');
  if (code === 'auth/popup-blocked') {
    return 'Popup login Google diblokir oleh browser. Izinkan popup untuk situs ini lalu coba lagi.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Jendela login Google ditutup sebelum selesai.';
  }
  if (code === 'auth/unauthorized-domain') {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'domain ini';
    return (
      'Domain "' +
      host +
      '" belum didaftarkan di Firebase Console → Authentication → Settings → Authorized domains.'
    );
  }
  if (code === 'auth/network-request-failed') {
    return 'Koneksi internet bermasalah saat menghubungi Google Auth. Periksa jaringan Anda.';
  }
  return message || 'Gagal menghubungkan akun Google. Silakan coba lagi.';
}

// === GERBANG LOGIN EMAIL & PASSWORD + SYNC FIREBASE OPSIONAL ===
export function setAuthUnlockedState(unlocked: boolean, email?: string | null, role?: any, options?: any) {
  var wasUnlocked = appState.appAuthStatusCache.authenticated;
  var prevEmail = appState.appAuthEmail;
  var prevSyncMode = appState.sharedSyncState.storageMode;
  var hasFirebaseUser = Boolean(options && options.hasFirebaseUser);

  appState.appAuthStatusCache.authenticated = Boolean(unlocked);
  if (hasFirebaseUser) {
    appState.sharedSyncState.storageMode = 'firestore';
  } else if (options && options.storageMode) {
    appState.sharedSyncState.storageMode = options.storageMode;
  } else if (prevSyncMode === 'firestore') {
    appState.sharedSyncState.storageMode = 'file';
  }

  var syncBtn = byId('cloud-sync-btn');
  var logoutBtn = byId('app-logout-btn');

  if (unlocked) {
    appState.appAuthEmail = String(email || '').trim().toLowerCase();
    appState.appAuthSessionRole = normalizeAppRole(role || 'stockkeeper');
    if (appState.appAuthEmail && (!appState.W.user || appState.W.user === 'Admin Gudang')) {
      appState.W.user = appState.appAuthEmail;
      saveRegistry();
    }
    document.body.classList.remove('auth-locked');
    if (logoutBtn) logoutBtn.style.display = '';
    if (syncBtn) syncBtn.style.display = '';
    updateSyncButtonUI();
    var allowed = getAllowedTabsForRole(getEffectiveRole());
    if ((options && options.freshLogin) || allowed.indexOf(appState.currentTab) < 0) {
      appState.currentTab = defaultTabForRole(getEffectiveRole());
    }
    try {
      renderApp();
    } catch (renderErr: any) {
      console.error('renderApp error after unlock:', renderErr);
      showToast(
        'Tampilan dimuat dengan pemulihan: ' + ((renderErr && renderErr.message) || 'coba muat ulang'),
        'warn'
      );
    }
    if (!wasUnlocked || prevEmail !== appState.appAuthEmail || (hasFirebaseUser && prevSyncMode !== 'firestore')) {
      if (!(options && options.skipRemoteCheck)) {
        void refreshPinStatus();
      }
      startSharedSyncLoop();
    }
  } else {
    stopSharedSyncLoop(Boolean(options && options.clearSyncState));
    persistAppAuthToken('');
    persistPinSession('', null);
    appState.appAuthEmail = '';
    appState.appAuthSessionRole = null;
    appState.rolePreviewOverride = '';
    sessionSetRaw(ACTIVE_TAB_KEY, '');
    document.body.classList.add('auth-locked');
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (syncBtn) syncBtn.style.display = 'none';
    renderLoginScreen(options && options.errorText ? String(options.errorText) : '');
  }
}

export async function logoutAppSession(): Promise<void> {
  appState.authTransitionSeq += 1;
  appState.pinTransitionSeq += 1;
  try {
    var cloud = await waitForCloudBridge(1500);
    if (cloud && cloud.appAuth && cloud.appAuth.logout) {
      await cloud.appAuth.logout();
    }
    if (cloud && cloud.firebaseAuth && cloud.getUser && cloud.getUser()) {
      await cloud.firebaseAuth.signOut();
    }
  } catch {
    // ignore logout error
  }
  setAuthUnlockedState(false, null, null, { clearSyncState: false });
  showToast('Anda telah keluar dari aplikasi.', 'info');
}

export async function connectGoogleCloudSync(): Promise<boolean> {
  try {
    var cloud = await waitForCloudBridge(2000);
    if (!cloud || !cloud.firebaseAuth) {
      throw new Error('Modul Firebase belum siap. Coba muat ulang halaman.');
    }
    var user = await cloud.firebaseAuth.signInWithGoogle(true);
    try {
      await cloud.firebaseAuth.ensureProfile(user);
    } catch {
      // ignore optional profile sync issue
    }
    appState.sharedSyncState.storageMode = 'firestore';
    updateSyncButtonUI();
    startSharedSyncLoop();
    renderApp();
    showToast('Sinkronisasi Firebase aktif (' + (user.email || user.displayName) + ')', 'ok');
    return true;
  } catch (err) {
    showToast(formatFirebaseAuthError(err), 'err');
    return false;
  }
}

export async function disconnectGoogleCloudSync(): Promise<void> {
  try {
    var cloud = await waitForCloudBridge(2000);
    if (cloud && cloud.firebaseAuth) {
      await cloud.firebaseAuth.signOut();
    }
  } catch {
    // ignore signout error
  }
  appState.sharedSyncState.storageMode = 'file';
  updateSyncButtonUI();
  startSharedSyncLoop();
  renderApp();
  showToast('Sinkronisasi Firebase diputuskan. Aplikasi tetap berjalan dengan login email.', 'info');
}

function bindPasswordToggle(btnId: string, inputId: string) {
  var toggleBtn = byId(btnId);
  var inp = byId(inputId) as HTMLInputElement | null;
  if (!toggleBtn || !inp) return;
  toggleBtn.addEventListener('click', function () {
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    toggleBtn.textContent = show ? 'Sembunyikan' : 'Tampilkan';
  });
}

export function renderLoginScreen(errorText?: string) {
  var body = byId('app-login-body');
  if (!body) return;

  var st = appState.appAuthStatusCache;
  var errBanner = errorText
    ? '<div class="inline-alert err" style="margin-bottom:14px">' + esc(errorText) + '</div>'
    : '';

  if (!st.loaded) {
    body.innerHTML =
      errBanner +
      '<div class="login-form-head"><h1 class="login-form-title">Memeriksa Sesi</h1>' +
      '<p class="login-form-desc">Menghubungkan ke server autentikasi…</p></div>' +
      '<button type="button" class="btn btn-primary login-submit-cta" id="auth-retry-btn">Coba Lagi</button>';
    var retryBtn = byId('auth-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        void syncAppAuthStatus(false);
      });
    }
    return;
  }

  if (!st.configured) {
    body.innerHTML =
      '<div class="login-form-head">' +
      '<h1 class="login-form-title">Buat Akun Login</h1>' +
      '<p class="login-form-desc">Daftarkan email dan kata sandi utama untuk mengakses sistem gudang.</p>' +
      '</div>' +
      errBanner +
      '<form id="form-app-setup" novalidate>' +
      '<div class="field"><label for="auth-email">Email</label>' +
      '<input id="auth-email" type="email" class="input" required autocomplete="username" placeholder="nama@perusahaan.com" /></div>' +
      '<div class="field"><label for="auth-password">Password (min. 6 karakter)</label>' +
      '<div class="login-pw-wrap">' +
      '<input id="auth-password" type="password" class="input" required minlength="6" maxlength="128" autocomplete="new-password" placeholder="Masukkan password…" />' +
      '<button type="button" class="login-pw-toggle" id="toggle-pw-btn">Tampilkan</button>' +
      '</div></div>' +
      '<div class="field"><label for="auth-password-confirm">Ulangi Password</label>' +
      '<input id="auth-password-confirm" type="password" class="input" required minlength="6" maxlength="128" autocomplete="new-password" placeholder="Ulangi password…" /></div>' +
      '<label class="login-remember-row">' +
      '<input type="checkbox" id="auth-remember"' + (appState.appAuthRememberDevice ? ' checked' : '') + ' />' +
      '<span>Ingat sesi login di perangkat ini</span>' +
      '</label>' +
      '<button type="submit" class="btn btn-primary login-submit-cta" id="auth-submit-btn">Simpan Akun &amp; Masuk</button>' +
      '</form>';

    bindPasswordToggle('toggle-pw-btn', 'auth-password');

    var setupForm = byId('form-app-setup') as HTMLFormElement | null;
    if (setupForm) {
      setupForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var email = ((byId('auth-email') as HTMLInputElement | null)?.value || '').trim();
        var password = (byId('auth-password') as HTMLInputElement | null)?.value || '';
        var confirmPw = (byId('auth-password-confirm') as HTMLInputElement | null)?.value || '';
        var rememberDevice = Boolean((byId('auth-remember') as HTMLInputElement | null)?.checked);
        var submitBtn = byId('auth-submit-btn') as HTMLButtonElement | null;

        if (!email || !email.includes('@')) {
          renderLoginScreen('Masukkan alamat email yang valid.');
          return;
        }
        if (password.length < 6) {
          renderLoginScreen('Password minimal 6 karakter.');
          return;
        }
        if (password !== confirmPw) {
          renderLoginScreen('Konfirmasi password tidak cocok.');
          return;
        }

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Menyimpan…';
        }
        try {
          var cloud = await waitForCloudBridge(2000);
          if (!cloud || !cloud.appAuth) throw new Error('Modul server belum siap. Coba muat ulang.');
          var res = await cloud.appAuth.setup({ email, password, rememberDevice });
          appState.authTransitionSeq += 1;
          appState.appAuthStatusCache = {
            loaded: true,
            configured: true,
            envManaged: false,
            authenticated: true,
          };
          persistAppAuthToken(res.token, res.rememberDevice);
          var hasFb = Boolean(cloud.getUser && cloud.getUser());
          setAuthUnlockedState(true, res.email, res.role || 'stockkeeper', {
            hasFirebaseUser: hasFb,
            freshLogin: true,
          });
          showToast('Akun login berhasil dibuat. Selamat datang!', 'ok');
        } catch (err: any) {
          renderLoginScreen((err && err.message) || 'Gagal membuat akun login.');
        }
      });
    }
    return;
  }

  body.innerHTML =
    '<div class="login-form-head">' +
    '<h1 class="login-form-title">Masuk ke Sistem Gudang</h1>' +
    '<p class="login-form-desc">Masukkan email dan password yang terdaftar untuk melanjutkan.</p>' +
    '</div>' +
    errBanner +
    '<form id="form-app-login" novalidate>' +
    '<div class="field"><label for="auth-email">Email</label>' +
    '<input id="auth-email" type="email" class="input" required autocomplete="username" placeholder="nama@perusahaan.com" /></div>' +
    '<div class="field"><label for="auth-password">Password</label>' +
    '<div class="login-pw-wrap">' +
    '<input id="auth-password" type="password" class="input" required maxlength="128" autocomplete="current-password" placeholder="Masukkan password…" />' +
    '<button type="button" class="login-pw-toggle" id="toggle-pw-btn">Tampilkan</button>' +
    '</div></div>' +
    '<label class="login-remember-row">' +
    '<input type="checkbox" id="auth-remember"' + (appState.appAuthRememberDevice ? ' checked' : '') + ' />' +
    '<span>Ingat sesi login di perangkat ini</span>' +
    '</label>' +
    '<button type="submit" class="btn btn-primary login-submit-cta" id="auth-submit-btn">Masuk</button>' +
    '</form>';

  bindPasswordToggle('toggle-pw-btn', 'auth-password');

  var loginForm = byId('form-app-login') as HTMLFormElement | null;
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = ((byId('auth-email') as HTMLInputElement | null)?.value || '').trim();
      var password = (byId('auth-password') as HTMLInputElement | null)?.value || '';
      var rememberDevice = Boolean((byId('auth-remember') as HTMLInputElement | null)?.checked);
      var submitBtn = byId('auth-submit-btn') as HTMLButtonElement | null;

      if (!email || !password) {
        renderLoginScreen('Email dan password wajib diisi.');
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Memeriksa…';
      }
      try {
        var cloud = await waitForCloudBridge(2000);
        if (!cloud || !cloud.appAuth) throw new Error('Modul server belum siap. Coba muat ulang.');
        var res = await cloud.appAuth.login({ email, password, rememberDevice });
        appState.authTransitionSeq += 1;
        appState.appAuthStatusCache.authenticated = true;
        appState.appAuthStatusCache.configured = true;
        persistAppAuthToken(res.token, res.rememberDevice);
        var hasFb = Boolean(cloud.getUser && cloud.getUser());
        setAuthUnlockedState(true, res.email, res.role || 'stockkeeper', {
          hasFirebaseUser: hasFb,
          freshLogin: true,
        });
        showToast('Berhasil masuk sebagai ' + res.email, 'ok');
      } catch (err: any) {
        if (err && err.needsSetup) {
          appState.appAuthStatusCache.configured = false;
          renderLoginScreen('Belum ada akun di server. Silakan buat akun login terlebih dahulu.');
          return;
        }
        renderLoginScreen((err && err.message) || 'Email atau password salah.');
      }
    });
  }
}

export async function syncAppAuthStatus(preserveError?: boolean) {
  var mySeq = ++appState.authTransitionSeq;
  var cloud = await waitForCloudBridge(2000);
  if (mySeq !== appState.authTransitionSeq) return;

  if (!cloud || !cloud.appAuth) {
    appState.appAuthStatusCache = {
      loaded: false,
      configured: true,
      envManaged: false,
      authenticated: false,
    };
    setAuthUnlockedState(false, null, null, {
      errorText: 'Gagal menghubungi modul autentikasi.',
    });
    return;
  }

  try {
    var res = await cloud.appAuth.getStatus(appState.appAuthToken || null);
    if (mySeq !== appState.authTransitionSeq) return;

    appState.appAuthStatusCache = {
      loaded: true,
      configured: Boolean(res.configured),
      envManaged: Boolean(res.envManaged),
      authenticated: Boolean(res.authenticated),
    };
    if (res.token) {
      persistAppAuthToken(res.token, res.rememberDevice);
    }

    var hasFb = Boolean(cloud.getUser && cloud.getUser());
    if (res.authenticated) {
      setAuthUnlockedState(true, res.email || 'operator', res.role || 'stockkeeper', {
        hasFirebaseUser: hasFb,
        storageMode: res.storageMode,
        skipRemoteCheck: false,
      });
    } else {
      setAuthUnlockedState(false, null, null, {
        storageMode: res.storageMode,
        errorText: preserveError ? 'Sesi login berakhir. Silakan masuk kembali.' : '',
      });
    }
  } catch (err: any) {
    if (mySeq !== appState.authTransitionSeq) return;
    appState.appAuthStatusCache = {
      loaded: false,
      configured: true,
      envManaged: false,
      authenticated: false,
    };
    setAuthUnlockedState(false, null, null, {
      errorText: (err && err.message) || 'Gagal memeriksa status login dari server.',
    });
  }
}

export async function initAppAuthGate(_hadValidLocalSession?: boolean) {
  var logoutBtn = byId('app-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      confirmDialog(
        'Keluar Aplikasi',
        '<p style="margin:0">Keluar dari sesi login saat ini?</p>',
        async function () {
          await logoutAppSession();
        },
        false
      );
    });
  }

  document.addEventListener('focusout', function () {
    if (!appState.sharedSyncState.pendingRender) return;
    setTimeout(function () {
      if (appState.sharedSyncState.pendingRender && !isUserEditingFormInView()) {
        appState.sharedSyncState.pendingRender = false;
        renderApp();
      }
    }, 120);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && appState.appAuthStatusCache.authenticated) {
      if (appState.sharedSyncState.pending) void pushSharedWarehouseState();
      else void pullSharedWarehouseState(false);
    }
  });

  window.addEventListener('online', function () {
    if (appState.appAuthStatusCache.authenticated) {
      if (appState.sharedSyncState.pending) void pushSharedWarehouseState();
      else void pullSharedWarehouseState(false);
    }
  });

  window.addEventListener('focus', function () {
    if (appState.appAuthStatusCache.authenticated) {
      if (appState.sharedSyncState.pending) void pushSharedWarehouseState();
    }
  });

  await syncAppAuthStatus(false);
}
