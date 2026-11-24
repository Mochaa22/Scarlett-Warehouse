import { isUserEditingFormInView, pullSharedWarehouseState, pushSharedWarehouseState, saveRegistry, startSharedSyncLoop, stopSharedSyncLoop, updateSyncButtonUI } from '../core/warehouseRegistry.ts';
import { ACTIVE_TAB_KEY, appState, decodeTokenPayload, renderApp, sessionSetRaw } from '../state/store.ts';
import { confirmDialog, showToast } from './feedback.ts';
import { defaultTabForRole, getAllowedTabsForRole, getEffectiveRole, normalizeAppRole, persistAppAuthToken, persistPinSession, refreshPinStatus } from './rbac.ts';
import { esc } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

// === GERBANG LOGIN EMAIL & PASSWORD BIASA ===
export function setAuthUnlockedState(unlocked: boolean, email?: string | null, role?: any, options?: any) {
  var wasUnlocked = appState.appAuthStatusCache.authenticated;
  var prevEmail = appState.appAuthEmail;
  appState.appAuthStatusCache.authenticated = Boolean(unlocked);
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
    } catch (renderErr) {
      console.error('renderApp error after unlock:', renderErr);
      showToast('Tampilan dimuat dengan pemulihan: ' + ((renderErr && renderErr.message) || 'coba muat ulang'), 'warn');
    }
    if (!wasUnlocked || prevEmail !== appState.appAuthEmail) {
      if (!(options && options.skipRemoteCheck)) {
        refreshPinStatus();
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

export function renderLoginScreen(errorText) {
  var body = byId('app-login-body');
  if (!body) return;
  if (!appState.appAuthStatusCache.loaded) {
    body.innerHTML = '<p class="muted" style="font-size:13px;margin:0">Memeriksa status login…</p>';
    return;
  }

  var errHtml = errorText
    ? '<div class="inline-alert err" style="margin-bottom:14px">' + esc(errorText) + '</div>'
    : '';

  var rememberCheckboxHtml = '<label class="login-remember-row" for="login-remember-device">' +
    '<input id="login-remember-device" type="checkbox"' + (appState.appAuthRememberDevice ? ' checked' : '') + ' />' +
    '<span>Ingat perangkat ini (otomatis masuk tanpa login ulang)</span>' +
    '</label>';

  if (!appState.appAuthStatusCache.configured && !appState.appAuthStatusCache.envManaged) {
    body.innerHTML =
      '<div class="login-form-head">' +
      '<h2 class="login-form-title">Pengaturan Akun Awal</h2>' +
      '<p class="login-form-desc">Buat akun email dan password pertama untuk masuk sebagai Stockkeeper.</p>' +
      '</div>' +
      errHtml +
      '<form id="form-app-setup-login">' +
      '<div class="field"><label for="login-setup-email">Email</label><input id="login-setup-email" type="email" class="input" required autocomplete="username" placeholder="nama@email.com" /></div>' +
      '<div class="field"><label for="login-setup-pw">Password (min. 6 karakter)</label><div class="login-pw-wrap"><input id="login-setup-pw" type="password" class="input" required minlength="6" maxlength="128" autocomplete="new-password" placeholder="Masukkan password" /><button type="button" class="login-pw-toggle" data-toggle-pw="login-setup-pw">Lihat</button></div></div>' +
      '<div class="field"><label for="login-setup-pw2">Konfirmasi Password</label><input id="login-setup-pw2" type="password" class="input" required minlength="6" maxlength="128" autocomplete="new-password" placeholder="Ulangi password" /></div>' +
      rememberCheckboxHtml +
      '<button type="submit" class="btn btn-primary login-submit-cta" id="login-submit-btn">Simpan Akun &amp; Masuk</button>' +
      '</form>';
  } else {
    body.innerHTML =
      '<div class="login-form-head">' +
      '</div>' +
      errHtml +
      '<form id="form-app-login">' +
      '<div class="field"><label for="login-email">Email</label><input id="login-email" type="email" class="input" required autocomplete="username" placeholder="nama@perusahaan.com" /></div>' +
      '<div class="field"><label for="login-password">Password</label><div class="login-pw-wrap"><input id="login-password" type="password" class="input" required maxlength="128" autocomplete="current-password" placeholder="Masukkan password" /><button type="button" class="login-pw-toggle" data-toggle-pw="login-password">Lihat</button></div></div>' +
      rememberCheckboxHtml +
      '<button type="submit" class="btn btn-primary login-submit-cta" id="login-submit-btn">Masuk</button>' +
      '</form>';
  }

  body.querySelectorAll('[data-toggle-pw]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = btn.getAttribute('data-toggle-pw');
      var inp = byId(targetId);
      if (!inp) return;
      var showing = inp.type === 'text';
      inp.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Lihat' : 'Tutup';
    });
  });

  async function readJsonSafe(res) {
    var ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
    if (!ct.includes('application/json')) {
      throw new Error('Server autentikasi tidak merespons dengan JSON (HTTP ' + res.status + '). Muat ulang halaman atau cek fungsi /api di hosting.');
    }
    return res.json();
  }

  var setupForm = byId('form-app-setup-login');
  if (setupForm) {
    setupForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var emailVal = byId('login-setup-email').value.trim();
      var pw1 = byId('login-setup-pw').value;
      var pw2 = byId('login-setup-pw2').value;
      var rememberEl = byId('login-remember-device');
      var rememberVal = rememberEl ? Boolean(rememberEl.checked) : true;
      if (pw1 !== pw2) {
        renderLoginScreen('Konfirmasi password tidak cocok.');
        return;
      }
      var btn = byId('login-submit-btn');
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/auth/setup', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailVal, password: pw1, rememberDevice: rememberVal })
        });
        var data = await readJsonSafe(res);
        if (res.status === 409) {
          appState.appAuthStatusCache.configured = true;
          appState.appAuthStatusCache.envManaged = Boolean(data && data.envManaged);
          var loginRes = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailVal, password: pw1, rememberDevice: rememberVal })
          });
          var loginData = await readJsonSafe(loginRes);
          if (!loginRes.ok) {
            throw new Error((loginData && loginData.error) || 'Akun login sudah aktif di server. Silakan masuk dengan email & password yang benar.');
          }
          appState.authTransitionSeq += 1;
          persistAppAuthToken(loginData.token, loginData.rememberDevice !== undefined ? Boolean(loginData.rememberDevice) : rememberVal);
          setAuthUnlockedState(true, loginData.email, loginData.role, { freshLogin: true });
          showToast('Berhasil masuk sebagai Stockkeeper (' + loginData.email + ')', 'ok');
          return;
        }
        if (!res.ok) throw new Error(data.error || 'Gagal menyimpan akun login.');
        appState.authTransitionSeq += 1;
        persistAppAuthToken(data.token, data.rememberDevice !== undefined ? Boolean(data.rememberDevice) : rememberVal);
        appState.appAuthStatusCache.configured = true;
        setAuthUnlockedState(true, data.email, data.role, { freshLogin: true });
        showToast('Akun login berhasil dibuat (Role: Stockkeeper)', 'ok');
      } catch (err) {
        renderLoginScreen((err && err.message) || 'Gagal menyimpan akun login.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  var loginForm = byId('form-app-login');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var emailVal = byId('login-email').value.trim();
      var pwVal = byId('login-password').value;
      var rememberEl = byId('login-remember-device');
      var rememberVal = rememberEl ? Boolean(rememberEl.checked) : true;
      var btn = byId('login-submit-btn');
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailVal, password: pwVal, rememberDevice: rememberVal })
        });
        var data = await readJsonSafe(res);
        if (!res.ok) {
          if (data && data.needsSetup) {
            appState.appAuthStatusCache.configured = false;
          }
          throw new Error((data && data.error) || 'Email atau password salah.');
        }
        appState.authTransitionSeq += 1;
        persistAppAuthToken(data.token, data.rememberDevice !== undefined ? Boolean(data.rememberDevice) : rememberVal);
        setAuthUnlockedState(true, data.email, data.role, { freshLogin: true });
        showToast('Berhasil masuk sebagai Stockkeeper (' + data.email + ')', 'ok');
      } catch (err) {
        renderLoginScreen((err && err.message) || 'Gagal masuk.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }
}

export async function fetchAuthStatusOnce() {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
  try {
    var headers = appState.appAuthToken
      ? { Authorization: 'Bearer ' + appState.appAuthToken, 'X-App-Auth': appState.appAuthToken }
      : {};
    var res = await fetch('/api/auth/status', {
      method: 'GET',
      credentials: 'same-origin',
      headers: headers,
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);
    var ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
    if (!res.ok || !ct.includes('application/json')) {
      throw new Error('Server autentikasi tidak merespons dengan benar (HTTP ' + res.status + '). Coba muat ulang halaman.');
    }
    return await res.json();
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }
}

export async function syncAppAuthStatus(preserveError) {
  var mySeq = ++appState.authTransitionSeq;
  var wasAuthenticated = Boolean(appState.appAuthStatusCache.authenticated);
  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var st = await fetchAuthStatusOnce();
      if (mySeq !== appState.authTransitionSeq) return;
      if (st && st.storageMode) appState.sharedSyncState.storageMode = st.storageMode;
      if (st && typeof st.hasSessionSecret === 'boolean') appState.sharedSyncState.hasSessionSecret = st.hasSessionSecret;

      // Jika sebelumnya sesi sedang aktif dan tiba-tiba ditolak, verifikasi ulang 1 kali sebelum mengunci
      if (!st.authenticated && wasAuthenticated && appState.appAuthToken) {
        await new Promise(function (resolve) { setTimeout(resolve, 350); });
        if (mySeq !== appState.authTransitionSeq) return;
        st = await fetchAuthStatusOnce();
        if (mySeq !== appState.authTransitionSeq) return;
      }

      var prevConfigured = appState.appAuthStatusCache.configured;
      appState.appAuthStatusCache = {
        loaded: true,
        configured: Boolean(st.configured),
        envManaged: Boolean(st.envManaged),
        authenticated: Boolean(st.authenticated)
      };
      if (st.authenticated && st.email) {
        if (st.token) {
          persistAppAuthToken(st.token, st.rememberDevice !== false);
        }
        setAuthUnlockedState(true, st.email, st.role);
        if (appState.pinSessionToken && !appState.pinStatusCache.loaded) {
          void refreshPinStatus();
        }
      } else {
        setAuthUnlockedState(false, '', null, { clearSyncState: !appState.sharedSyncState.pending });
        if (wasAuthenticated) {
          renderLoginScreen('Sesi berakhir atau tidak terverifikasi di server — silakan masuk kembali.');
          showToast('Sesi login berakhir di server — silakan masuk ulang.', 'warn');
        } else if (!preserveError || prevConfigured !== appState.appAuthStatusCache.configured) {
          renderLoginScreen('');
        }
      }
      return;
    } catch (err) {
      if (mySeq !== appState.authTransitionSeq) return;
      lastErr = err;
      if (attempt === 0) {
        await new Promise(function (resolve) { setTimeout(resolve, 450); });
        if (mySeq !== appState.authTransitionSeq) return;
      }
    }
  }

  if (mySeq !== appState.authTransitionSeq) return;

  // Jika jaringan sedang offline / lambat saat refresh, tetap izinkan sesi lokal yang belum kedaluwarsa agar input data tetap berjalan
  var cachedPayload = decodeTokenPayload(appState.appAuthToken);
  if (cachedPayload && cachedPayload.sub) {
    appState.appAuthStatusCache.loaded = true;
    appState.appAuthStatusCache.configured = true;
    setAuthUnlockedState(true, cachedPayload.sub, cachedPayload.role || 'stockkeeper', { skipRemoteCheck: true });
    if (!preserveError) {
      showToast('Koneksi tidak stabil — masuk dengan sesi tersimpan. Data tetap bisa disimpan di perangkat.', 'warn');
    }
    return;
  }

  appState.appAuthStatusCache.loaded = true;
  if (!preserveError) {
    renderLoginScreen((lastErr && lastErr.message) || 'Server autentikasi tidak merespons. Coba muat ulang halaman.');
  }
}

export async function initAppAuthGate(hadValidLocalSession) {
  var logoutBtn = byId('app-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      confirmDialog(
        'Keluar Aplikasi',
        '<p style="margin:0">Keluar dari sesi login saat ini dan kembali ke halaman masuk?</p>',
        function () {
          appState.authTransitionSeq += 1;
          appState.pinTransitionSeq += 1;
          var tok = appState.appAuthToken;
          setAuthUnlockedState(false, '', null, { clearSyncState: true });
          fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: tok ? { Authorization: 'Bearer ' + tok, 'X-App-Auth': tok } : {}
          }).catch(function () {});
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
    if (!appState.appAuthStatusCache.authenticated) {
      void syncAppAuthStatus(true);
    } else {
      void syncAppAuthStatus(true);
      if (appState.sharedSyncState.pending) void pushSharedWarehouseState();
      else void pullSharedWarehouseState(false);
    }
  });

  window.addEventListener('focus', function () {
    if (!appState.appAuthStatusCache.authenticated) {
      void syncAppAuthStatus(true);
    } else if (appState.sharedSyncState.pending) {
      void pushSharedWarehouseState();
    } else {
      void pullSharedWarehouseState(false);
    }
  });

  await syncAppAuthStatus(Boolean(hadValidLocalSession));
}
