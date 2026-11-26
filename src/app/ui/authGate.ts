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
  return message || 'Gagal masuk dengan Google. Silakan coba lagi.';
}

// === GERBANG LOGIN FIREBASE (GOOGLE AUTH) ===
export function setAuthUnlockedState(unlocked: boolean, email?: string | null, role?: any, options?: any) {
  var wasUnlocked = appState.appAuthStatusCache.authenticated;
  var prevEmail = appState.appAuthEmail;
  appState.appAuthStatusCache.authenticated = Boolean(unlocked);
  appState.sharedSyncState.storageMode = 'firestore';
  var syncBtn = byId('cloud-sync-btn');
  if (unlocked) {
    appState.appAuthEmail = String(email || '').trim();
    appState.appAuthSessionRole = normalizeAppRole(role || 'stockkeeper');
    if (appState.appAuthEmail && (!appState.W.user || appState.W.user === 'Admin Gudang')) {
      appState.W.user = appState.appAuthEmail;
      saveRegistry();
    }
    document.body.classList.remove('auth-locked');
    var logoutBtn = byId('app-logout-btn');
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
    if (!wasUnlocked || prevEmail !== appState.appAuthEmail) {
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
    var logoutBtnHide = byId('app-logout-btn');
    if (logoutBtnHide) logoutBtnHide.style.display = 'none';
    if (syncBtn) syncBtn.style.display = 'none';
  }
}

export function renderLoginScreen(errorText?: string) {
  var body = byId('app-login-body');
  if (!body) return;
  if (!appState.appAuthStatusCache.loaded) {
    body.innerHTML = '<p class="muted" style="font-size:13px;margin:0">Memeriksa sesi Firebase…</p>';
    return;
  }

  var errHtml = errorText
    ? '<div class="inline-alert err" style="margin-bottom:14px">' + esc(errorText) + '</div>'
    : '';

  var rememberCheckboxHtml =
    '<label class="login-remember-row" for="login-remember-device">' +
    '<input id="login-remember-device" type="checkbox"' +
    (appState.appAuthRememberDevice ? ' checked' : '') +
    ' />' +
    '<span>Ingat perangkat ini (otomatis masuk tanpa login ulang)</span>' +
    '</label>';

  var googleIconSvg =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0">' +
    '<path fill="#EA4335" d="M12 5c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0 7.39 0 3.44 2.65 1.52 6.53l3.66 2.84C6.07 6.72 8.79 5 12 5z"/>' +
    '<path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58l3.72 2.89c2.17-2 3.7-4.96 3.7-8.71z"/>' +
    '<path fill="#FBBC05" d="M5.18 14.63A7.22 7.22 0 0 1 4.8 12c0-.91.16-1.8.38-2.63L1.52 6.53A11.97 11.97 0 0 0 0 12c0 1.93.46 3.75 1.52 5.47l3.66-2.84z"/>' +
    '<path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.72-2.89c-1.07.72-2.45 1.15-4.21 1.15-3.21 0-5.93-2.17-6.91-5.1L1.52 17.47C3.44 21.35 7.39 24 12 24z"/>' +
    '</svg>';

  body.innerHTML =
    '<div class="login-form-head">' +
    '<h2 class="login-form-title">Masuk ke Sarlett Inventory</h2>' +
    '<p class="login-form-desc">Gunakan akun Google untuk memulai sesi Stockkeeper dan menyinkronkan data gudang ke Firebase Cloud.</p>' +
    '</div>' +
    errHtml +
    rememberCheckboxHtml +
    '<button type="button" class="btn btn-primary login-submit-cta" id="btn-google-login" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%">' +
    googleIconSvg +
    '<span>Masuk dengan Google</span>' +
    '</button>';

  var loginBtn = byId('btn-google-login') as HTMLButtonElement | null;
  if (loginBtn) {
    loginBtn.addEventListener('click', async function () {
      var rememberEl = byId('login-remember-device') as HTMLInputElement | null;
      var rememberVal = rememberEl ? Boolean(rememberEl.checked) : true;
      persistAppAuthToken('', rememberVal);
      loginBtn.disabled = true;
      var span = loginBtn.querySelector('span');
      if (span) span.textContent = 'Menghubungkan ke Google…';
      try {
        var cloud = await waitForCloudBridge(2000);
        if (!cloud || !cloud.firebaseAuth) {
          throw new Error('Modul autentikasi Firebase belum siap. Muat ulang halaman.');
        }
        var user = await cloud.firebaseAuth.signInWithGoogle(rememberVal);
        appState.authTransitionSeq += 1;
        appState.appAuthStatusCache = {
          loaded: true,
          configured: true,
          envManaged: false,
          authenticated: true,
        };
        setAuthUnlockedState(true, user.email || user.displayName || 'operator', 'stockkeeper', {
          freshLogin: true,
        });
        showToast('Berhasil masuk sebagai Stockkeeper (' + (user.email || user.displayName) + ')', 'ok');
      } catch (err) {
        renderLoginScreen(formatFirebaseAuthError(err));
      }
    });
  }
}

export async function syncAppAuthStatus(preserveError?: boolean) {
  var mySeq = ++appState.authTransitionSeq;
  var cloud = await waitForCloudBridge(2000);
  if (mySeq !== appState.authTransitionSeq) return;

  if (!cloud || !cloud.getUser) {
    appState.appAuthStatusCache.loaded = true;
    if (!preserveError) renderLoginScreen('Modul Firebase belum siap. Coba muat ulang halaman.');
    return;
  }

  var curUser = cloud.getUser();
  appState.appAuthStatusCache = {
    loaded: true,
    configured: true,
    envManaged: false,
    authenticated: Boolean(curUser),
  };

  if (curUser) {
    setAuthUnlockedState(true, curUser.email || curUser.displayName, 'stockkeeper', {
      skipRemoteCheck: false,
    });
  } else {
    setAuthUnlockedState(false, '', null, { clearSyncState: false });
    if (!preserveError) renderLoginScreen('');
  }
}

export async function initAppAuthGate(_hadValidLocalSession?: boolean) {
  var logoutBtn = byId('app-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      confirmDialog(
        'Keluar Aplikasi',
        '<p style="margin:0">Keluar dari sesi Google saat ini dan kembali ke halaman masuk?</p>',
        async function () {
          appState.authTransitionSeq += 1;
          appState.pinTransitionSeq += 1;
          setAuthUnlockedState(false, '', null, { clearSyncState: true });
          try {
            var cloud = await waitForCloudBridge(2000);
            if (cloud && cloud.firebaseAuth) {
              await cloud.firebaseAuth.signOut();
            }
          } catch {
            // ignore signout error
          }
          renderLoginScreen('');
          showToast('Anda telah keluar dari aplikasi', 'info');
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

  var cloud = await waitForCloudBridge(2000);
  if (!cloud || !cloud.firebaseAuth) {
    appState.appAuthStatusCache.loaded = true;
    renderLoginScreen('Gagal memuat Firebase SDK.');
    return;
  }

  await new Promise<void>(function (resolve) {
    var resolved = false;
    cloud.firebaseAuth.onAuthStateChanged(async function (user: any) {
      appState.authTransitionSeq += 1;
      appState.appAuthStatusCache = {
        loaded: true,
        configured: true,
        envManaged: false,
        authenticated: Boolean(user),
      };

      if (user) {
        try {
          await cloud.firebaseAuth.ensureProfile(user);
        } catch (profileErr) {
          console.error('ensureProfile error:', profileErr);
        }
        setAuthUnlockedState(true, user.email || user.displayName || 'operator', 'stockkeeper');
      } else {
        setAuthUnlockedState(false, '', null, { clearSyncState: false });
        renderLoginScreen('');
      }

      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
  });
}
