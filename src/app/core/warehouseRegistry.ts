import { FIELDS, REG_KEY, SYNC_BASE_KEY, SYNC_META_KEY, appState, renderApp, safeDel, safeGet, safeGetRaw, safeSet } from '../state/store.ts';
import { syncAppAuthStatus } from '../ui/authGate.ts';
import { showToast } from '../ui/feedback.ts';
import { waitForCloudBridge } from '../ui/rbac.ts';
import { defaultCutoffISO, normBarcode, normLoc, normSku } from '../utils/format.ts';

export function loadRegistry() {
  var reg = safeGet(REG_KEY, null);
  if (!reg) {
    // Cek format lama 'W' bila sudah ada
    reg = safeGet('W', null);
  }
  if (!reg || !Array.isArray(reg.list) || reg.list.length === 0) {
    reg = {
      cur: 'gp1',
      list: [{ id: 'gp1', nama: 'Scarlett GP1', legacy: true }],
      user: safeGetRaw('gp1_user') || 'Admin Gudang'
    };
    safeSet(REG_KEY, reg);
  } else {
    if (!reg.list.some(function (x) { return x.id === reg.cur; })) {
      reg.cur = reg.list[0].id;
    }
    if (typeof reg.user !== 'string' || !reg.user.trim()) reg.user = 'Admin Gudang';
  }
  return reg;
}

export function saveRegistry(syncShared?: boolean) {
  safeSet(REG_KEY, appState.W);
  if (syncShared) {
    scheduleSharedSyncPush();
  }
}

export function getWhMeta(wid) {
  for (var i = 0; i < appState.W.list.length; i++) {
    if (appState.W.list[i].id === wid) return appState.W.list[i];
  }
  return appState.W.list[0];
}

export function whPrefix(wid) {
  var meta = getWhMeta(wid);
  if (meta && (meta.legacy || wid === 'gp1')) return '';
  return 'wh_' + wid + '_';
}

export function defaultWhData() {
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
    cutoff: defaultCutoffISO(),
    min: 10,
    mode: 'mut',
    cover: 7,
    expMonths: 7
  };
}

export function readWarehouseData(wid) {
  var p = whPrefix(wid);
  var def = defaultWhData();
  var master = safeGet(p + 'master', null);
  var lokasi = safeGet(p + 'lokasi', null);
  var opening = safeGet(p + 'opening', null);
  var allstock = safeGet(p + 'allstock', null);
  var masuk = safeGet(p + 'masuk', null);
  var keluar = safeGet(p + 'keluar', null);
  var pindah = safeGet(p + 'pindah', null);
  var defect = safeGet(p + 'defect', null);
  var batches = safeGet(p + 'batches', null);
  var cycleCounts = safeGet(p + 'cycleCounts', null);
  var inboundRegister = safeGet(p + 'inboundRegister', null);
  var cutoff = safeGet(p + 'cutoff', null);
  var min = safeGet(p + 'min', null);
  var mode = safeGet(p + 'mode', null);
  var cover = safeGet(p + 'cover', null);
  var expMonths = safeGet(p + 'expMonths', null);

  return {
    master: Array.isArray(master) ? master : def.master,
    lokasi: Array.isArray(lokasi) ? lokasi : def.lokasi,
    opening: Array.isArray(opening) ? opening : def.opening,
    allstock: Array.isArray(allstock) ? allstock : def.allstock,
    masuk: Array.isArray(masuk) ? masuk : def.masuk,
    keluar: Array.isArray(keluar) ? keluar : def.keluar,
    pindah: Array.isArray(pindah) ? pindah : def.pindah,
    defect: Array.isArray(defect) ? defect : def.defect,
    batches: Array.isArray(batches) ? batches : def.batches,
    cycleCounts: Array.isArray(cycleCounts) ? cycleCounts : def.cycleCounts,
    inboundRegister: Array.isArray(inboundRegister) ? inboundRegister : def.inboundRegister,
    cutoff: typeof cutoff === 'string' && cutoff ? cutoff : def.cutoff,
    min: Number.isFinite(Number(min)) && min !== null ? Number(min) : def.min,
    mode: mode === 'all' ? 'all' : 'mut',
    cover: Number.isFinite(Number(cover)) && Number(cover) > 0 ? Number(cover) : def.cover,
    expMonths: Number.isFinite(Number(expMonths)) && Number(expMonths) > 0 ? Number(expMonths) : def.expMonths
  };
}


export function loadSyncMeta() {
  var m = safeGet(SYNC_META_KEY, null);
  if (!m || typeof m !== 'object') return { revision: 0, pending: false };
  return {
    revision: Number.isFinite(Number(m.revision)) && Number(m.revision) >= 0 ? Math.floor(Number(m.revision)) : 0,
    pending: Boolean(m.pending)
  };
}


export function updateSyncButtonUI() {
  var btn = document.getElementById('cloud-sync-btn');
  if (!btn) return;
  var span = btn.querySelector('span');
  if (span) {
    span.textContent = appState.sharedSyncState.pending ? 'Menunggu' : 'Sinkron';
  }
  btn.title = appState.sharedSyncState.pending
    ? 'Ada perubahan tersimpan di perangkat menunggu koneksi stabil untuk disinkronkan. Klik untuk coba sinkron sekarang.'
    : 'Sinkronkan data terbaru lintas perangkat & pengguna';
}

export function saveSyncPersistence(saveBase?: boolean) {
  safeSet(SYNC_META_KEY, {
    revision: appState.sharedSyncState.revision,
    pending: Boolean(appState.sharedSyncState.pending),
    updatedAt: Date.now()
  });
  if (saveBase && appState.sharedSyncState.snapshot) {
    safeSet(SYNC_BASE_KEY, appState.sharedSyncState.snapshot);
  }
  updateSyncButtonUI();
}

export function cloneJsonSafe(val) {
  try {
    return JSON.parse(JSON.stringify(val));
  } catch (e) {
    return val;
  }
}

export function buildSharedSnapshotFromLocal() {
  var metaList = appState.W.list.map(function (w) {
    return { id: w.id, nama: w.nama, legacy: Boolean(w.legacy) };
  });
  var whMap = {};
  metaList.forEach(function (w) {
    whMap[w.id] = readWarehouseData(w.id);
  });
  return { warehousesMeta: metaList, warehouses: whMap };
}

export function isSharedSnapshotEmpty(snap) {
  if (!snap || !Array.isArray(snap.warehousesMeta)) return true;
  if (snap.warehousesMeta.length > 1) return false;
  var firstId = snap.warehousesMeta[0] && snap.warehousesMeta[0].id;
  var wd = (firstId && snap.warehouses && snap.warehouses[firstId]) || null;
  if (!wd) return true;
  var arrayKeys = ['master', 'lokasi', 'opening', 'allstock', 'masuk', 'keluar', 'pindah', 'defect', 'batches', 'cycleCounts', 'inboundRegister'];
  return arrayKeys.every(function (k) {
    return !Array.isArray(wd[k]) || wd[k].length === 0;
  });
}

export function isUserEditingFormInView() {
  var ae = document.activeElement;
  if (!ae) return false;
  var tag = String(ae.tagName || '').toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  var inView = Boolean(ae.closest && ae.closest('#view-root'));
  var inModal = Boolean(ae.closest && ae.closest('.modal-backdrop.open'));
  return inView || inModal;
}

export function triggerRenderOrDefer() {
  if (isUserEditingFormInView()) {
    appState.sharedSyncState.pendingRender = true;
    return;
  }
  appState.sharedSyncState.pendingRender = false;
  renderApp();
}

export function applySharedStateLocally(remote) {
  if (!remote || !Array.isArray(remote.warehousesMeta) || remote.warehousesMeta.length === 0) return;
  var prevCur = appState.W.cur;
  var prevIds = appState.W.list.map(function (w) { return w.id; });
  appState.W.list = remote.warehousesMeta.map(function (w) {
    return { id: w.id, nama: w.nama, legacy: Boolean(w.legacy) };
  });
  if (!appState.W.list.some(function (w) { return w.id === prevCur; })) {
    appState.W.cur = appState.W.list[0].id;
  }
  safeSet(REG_KEY, appState.W);

  var nextIds = new Set(appState.W.list.map(function (w) { return w.id; }));
  prevIds.forEach(function (oldId) {
    if (!nextIds.has(oldId)) {
      deleteWarehouseStorage(oldId, true);
    }
  });

  appState.W.list.forEach(function (w) {
    var incoming = remote.warehouses && remote.warehouses[w.id];
    var mergedWh = Object.assign(defaultWhData(), incoming || {});
    writeWarehouseData(w.id, mergedWh, true);
  });

  appState.sharedSyncState.revision = Number(remote.revision || 0);
  appState.sharedSyncState.snapshot = cloneJsonSafe(buildSharedSnapshotFromLocal());
  saveSyncPersistence(true);
}

export function mergeArrayByKey3Way(baseArr, localArr, remoteArr, keyFn) {
  var baseMap = new Map();
  var localMap = new Map();
  var remoteMap = new Map();
  var order = [];
  var seenOrder = new Set();

  function pushOrder(k) {
    if (!seenOrder.has(k)) {
      seenOrder.add(k);
      order.push(k);
    }
  }

  (Array.isArray(baseArr) ? baseArr : []).forEach(function (item) {
    var k = keyFn(item);
    if (!k) return;
    baseMap.set(k, item);
  });
  (Array.isArray(remoteArr) ? remoteArr : []).forEach(function (item) {
    var k = keyFn(item);
    if (!k) return;
    remoteMap.set(k, item);
    pushOrder(k);
  });
  (Array.isArray(localArr) ? localArr : []).forEach(function (item) {
    var k = keyFn(item);
    if (!k) return;
    localMap.set(k, item);
    pushOrder(k);
  });

  var out = [];
  order.forEach(function (k) {
    var inBase = baseMap.has(k);
    var inLocal = localMap.has(k);
    var inRemote = remoteMap.has(k);
    var bItem = baseMap.get(k);
    var lItem = localMap.get(k);
    var rItem = remoteMap.get(k);

    if (inLocal && inRemote) {
      var lStr = JSON.stringify(lItem);
      var rStr = JSON.stringify(rItem);
      if (lStr === rStr) {
        out.push(rItem);
      } else if (inBase) {
        var bStr = JSON.stringify(bItem);
        if (lStr === bStr) out.push(rItem);
        else out.push(lItem);
      } else {
        out.push(lItem);
      }
    } else if (inLocal && !inRemote) {
      if (!inBase) {
        out.push(lItem);
      } else if (JSON.stringify(lItem) !== JSON.stringify(bItem)) {
        out.push(lItem);
      }
    } else if (!inLocal && inRemote) {
      if (!inBase) {
        out.push(rItem);
      } else if (JSON.stringify(rItem) !== JSON.stringify(bItem)) {
        out.push(rItem);
      }
    }
  });
  return out;
}

export function mergeWarehouseData3Way(baseWh, localWh, remoteWh) {
  var b = Object.assign(defaultWhData(), baseWh || {});
  var l = Object.assign(defaultWhData(), localWh || {});
  var r = Object.assign(defaultWhData(), remoteWh || {});
  var out = defaultWhData();

  ['masuk', 'keluar', 'pindah', 'defect', 'batches', 'cycleCounts', 'inboundRegister'].forEach(function (field) {
    out[field] = mergeArrayByKey3Way(b[field], l[field], r[field], function (it) {
      return it && it.id ? String(it.id) : JSON.stringify(it);
    });
  });

  out.master = mergeArrayByKey3Way(b.master, l.master, r.master, function (m) {
    return normSku(m && m.sku) + '|' + normBarcode(m && m.barcode);
  });

  out.lokasi = mergeArrayByKey3Way(b.lokasi, l.lokasi, r.lokasi, function (loc) {
    return normLoc(loc);
  });

  ['opening', 'allstock'].forEach(function (field) {
    out[field] = mergeArrayByKey3Way(b[field], l[field], r[field], function (it) {
      return normLoc(it && it.lok) + '|' + normSku(it && it.sku) + '|' + normBarcode(it && it.barcode);
    });
  });

  ['cutoff', 'min', 'mode', 'cover', 'expMonths'].forEach(function (scalarField) {
    out[scalarField] = l[scalarField] !== b[scalarField] ? l[scalarField] : r[scalarField];
  });

  return out;
}

export function mergeSnapshots3Way(baseSnap, localSnap, remoteSnap) {
  var baseMeta = (baseSnap && baseSnap.warehousesMeta) || [];
  var localMeta = (localSnap && localSnap.warehousesMeta) || [];
  var remoteMeta = (remoteSnap && remoteSnap.warehousesMeta) || [];
  var mergedMeta = mergeArrayByKey3Way(baseMeta, localMeta, remoteMeta, function (w) {
    return w && w.id ? String(w.id) : '';
  });
  if (!mergedMeta.length) mergedMeta = remoteMeta.length ? remoteMeta : localMeta;

  var mergedWarehouses = {};
  mergedMeta.forEach(function (meta) {
    var wid = meta.id;
    mergedWarehouses[wid] = mergeWarehouseData3Way(
      baseSnap && baseSnap.warehouses && baseSnap.warehouses[wid],
      localSnap && localSnap.warehouses && localSnap.warehouses[wid],
      remoteSnap && remoteSnap.warehouses && remoteSnap.warehouses[wid]
    );
  });

  return { warehousesMeta: mergedMeta, warehouses: mergedWarehouses };
}

export function scheduleSharedSyncRetry() {
  if (!appState.appAuthStatusCache.authenticated || !appState.sharedSyncState.pending) return;
  if (appState.sharedSyncState.retryTimer) clearTimeout(appState.sharedSyncState.retryTimer);
  var delay = appState.sharedSyncState.retryDelayMs;
  appState.sharedSyncState.retryDelayMs = Math.min(15000, Math.round(appState.sharedSyncState.retryDelayMs * 1.8));
  appState.sharedSyncState.retryTimer = setTimeout(function () {
    appState.sharedSyncState.retryTimer = null;
    if (appState.sharedSyncState.pending && appState.appAuthStatusCache.authenticated) {
      void pushSharedWarehouseState();
    }
  }, delay);
}

function refreshRealtimeSubscription() {
  var cloud = window.__sgpCloud;
  if (!cloud || !cloud.warehouse || !cloud.warehouse.subscribeRealtime) return;
  if (!appState.appAuthStatusCache.authenticated) return;
  var ids = (appState.W && Array.isArray(appState.W.list) ? appState.W.list : []).map(function (w) {
    return w.id;
  });
  cloud.warehouse.subscribeRealtime(ids, function () {
    if (!appState.appAuthStatusCache.authenticated) return;
    if (!appState.sharedSyncState.pending && !appState.sharedSyncState.inFlight) {
      void pullSharedWarehouseState('realtime');
    }
  });
}

export async function pushSharedWarehouseState(forceInitialPush?: boolean) {
  var cloud = await waitForCloudBridge(2000);
  if (!appState.appAuthStatusCache.authenticated || !cloud || !cloud.warehouse) return;
  if (!appState.sharedSyncState.initialCloudLoaded && !forceInitialPush) {
    var candidateSnap = buildSharedSnapshotFromLocal();
    if (isSharedSnapshotEmpty(candidateSnap)) {
      return;
    }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    appState.sharedSyncState.pending = true;
    appState.sharedSyncState.dirty = true;
    saveSyncPersistence(false);
    if (!appState.sharedSyncState.offlineNotified) {
      appState.sharedSyncState.offlineNotified = true;
      showToast('Koneksi terputus — perubahan tetap tersimpan di perangkat dan akan disinkronkan otomatis saat online.', 'warn');
    }
    return;
  }
  if (appState.sharedSyncState.inFlight) {
    appState.sharedSyncState.dirty = true;
    appState.sharedSyncState.pending = true;
    saveSyncPersistence(false);
    return;
  }
  appState.sharedSyncState.inFlight = true;
  appState.sharedSyncState.dirty = false;
  var hadPendingBefore = appState.sharedSyncState.pending;
  try {
    var localSnap = buildSharedSnapshotFromLocal();
    var baseRev = appState.sharedSyncState.revision;
    var res = await window.__sgpCloud.warehouse.saveState(
      {
        baseRevision: baseRev,
        warehousesMeta: localSnap.warehousesMeta,
        warehouses: localSnap.warehouses
      },
      appState.appAuthToken || null
    );

    var targetLabel = appState.sharedSyncState.storageMode === 'firestore'
      ? 'Firebase'
      : (appState.sharedSyncState.storageMode === 'postgres' ? 'Neon PostgreSQL' : 'server');

    if (res && res.ok) {
      appState.sharedSyncState.revision = Number(res.revision || 0);
      appState.sharedSyncState.snapshot = cloneJsonSafe(localSnap);
      appState.sharedSyncState.lastSyncedSnapshot = appState.sharedSyncState.snapshot;
      appState.sharedSyncState.pending = false;
      appState.sharedSyncState.retryDelayMs = 2000;
      appState.sharedSyncState.lastError = '';
      if (res.storageMode) appState.sharedSyncState.storageMode = res.storageMode;
      targetLabel = appState.sharedSyncState.storageMode === 'firestore'
        ? 'Firebase'
        : (appState.sharedSyncState.storageMode === 'postgres' ? 'Neon PostgreSQL' : 'server');
      saveSyncPersistence(true);
      refreshRealtimeSubscription();
      if (appState.sharedSyncState.offlineNotified && hadPendingBefore) {
        appState.sharedSyncState.offlineNotified = false;
        showToast('Koneksi kembali stabil — seluruh perubahan tertunda berhasil tersimpan ke ' + targetLabel + '.', 'ok');
      } else {
        appState.sharedSyncState.offlineNotified = false;
      }
    }
  } catch (err) {
    var msg = (err && err.message) || 'Gagal menyinkronkan ke server';
    appState.sharedSyncState.lastError = msg;
    if (err && err.status === 401) {
      appState.sharedSyncState.pending = true;
      appState.sharedSyncState.dirty = false;
      saveSyncPersistence(false);
      void syncAppAuthStatus(true);
    } else {
      appState.sharedSyncState.pending = true;
      appState.sharedSyncState.dirty = true;
      saveSyncPersistence(false);
      scheduleSharedSyncRetry();
      if (!appState.sharedSyncState.offlineNotified) {
        appState.sharedSyncState.offlineNotified = true;
        showToast('Sinkronisasi tertunda — data tetap aman dan akan dikirim ulang otomatis.', 'warn');
      }
    }
  } finally {
    appState.sharedSyncState.inFlight = false;
    if (appState.sharedSyncState.dirty && appState.appAuthStatusCache.authenticated && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      if (!appState.sharedSyncState.retryTimer) {
        scheduleSharedSyncPush();
      }
    }
  }
}

export async function pullSharedWarehouseState(isInitialOrManual?: boolean | string) {
  var cloud = await waitForCloudBridge(2000);
  if (!appState.appAuthStatusCache.authenticated || !cloud || !cloud.warehouse) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (isInitialOrManual === 'manual') {
      showToast('Perangkat sedang offline. Data tetap tersimpan aman secara lokal.', 'warn');
    }
    return;
  }
  if (appState.sharedSyncState.pending && appState.sharedSyncState.initialCloudLoaded) {
    if (isInitialOrManual === 'manual') {
      await pushSharedWarehouseState();
      if (!appState.sharedSyncState.pending) {
        var manualLabel = appState.sharedSyncState.storageMode === 'firestore'
          ? 'Firebase'
          : (appState.sharedSyncState.storageMode === 'postgres' ? 'Neon PostgreSQL' : 'server');
        showToast('Perubahan tertunda berhasil disimpan ke ' + manualLabel, 'ok');
      }
    } else if (!appState.sharedSyncState.inFlight && !appState.sharedSyncState.pushTimer && !appState.sharedSyncState.retryTimer) {
      void pushSharedWarehouseState();
    }
    return;
  }
  if (appState.sharedSyncState.inFlight || appState.sharedSyncState.dirty || appState.sharedSyncState.pushTimer) return;
  appState.sharedSyncState.inFlight = true;
  try {
    var sinceParam = isInitialOrManual === 'manual' ? null : appState.sharedSyncState.revision;
    var res = await window.__sgpCloud.warehouse.getState(sinceParam, appState.appAuthToken || null);
    if (res && res.storageMode) {
      appState.sharedSyncState.storageMode = res.storageMode;
    }
    appState.sharedSyncState.initialCloudLoaded = true;
    if (!res) return;
    if (res.changed === false) {
      appState.sharedSyncState.revision = Number(res.revision || appState.sharedSyncState.revision || 0);
      if (isInitialOrManual === 'manual') {
        showToast('Data sudah sinkron dengan server', 'ok');
      }
      return;
    }

    var targetCloudLabel = appState.sharedSyncState.storageMode === 'firestore'
      ? 'Firebase'
      : (appState.sharedSyncState.storageMode === 'postgres' ? 'Neon PostgreSQL' : 'server');
    var hasRemoteWarehouses = Array.isArray(res.warehousesMeta) && res.warehousesMeta.length > 0;
    if (!hasRemoteWarehouses) {
      var localSnap = buildSharedSnapshotFromLocal();
      if (!isSharedSnapshotEmpty(localSnap)) {
        appState.sharedSyncState.inFlight = false;
        await pushSharedWarehouseState(true);
        return;
      }
      appState.sharedSyncState.revision = Number(res.revision || 0);
      appState.sharedSyncState.snapshot = cloneJsonSafe(localSnap);
      appState.sharedSyncState.lastSyncedSnapshot = appState.sharedSyncState.snapshot;
      saveSyncPersistence(true);
      refreshRealtimeSubscription();
      if (isInitialOrManual === 'manual') {
        showToast('Terhubung ke ' + targetCloudLabel + ' (database masih kosong)', 'info');
      }
      return;
    }

    var localBefore = buildSharedSnapshotFromLocal();
    var remoteComparable = {
      warehousesMeta: (res.warehousesMeta || []).map(function (w) {
        return { id: w.id, nama: w.nama, legacy: Boolean(w.legacy) };
      }),
      warehouses: res.warehouses || {}
    };
    var localComparable = {
      warehousesMeta: localBefore.warehousesMeta,
      warehouses: localBefore.warehouses
    };
    var isDifferent = JSON.stringify(localComparable) !== JSON.stringify(remoteComparable);

    if (isDifferent) {
      var wasLoadedBefore = appState.sharedSyncState.revision > 0 && !isSharedSnapshotEmpty(localBefore);
      applySharedStateLocally(res);
      appState.sharedSyncState.lastSyncedSnapshot = appState.sharedSyncState.snapshot;
      triggerRenderOrDefer();
      refreshRealtimeSubscription();
      if (wasLoadedBefore && isInitialOrManual !== true) {
        showToast('Data terbaru disinkronkan dari ' + targetCloudLabel, 'info');
      } else if (isInitialOrManual === 'manual') {
        showToast('Data terbaru berhasil dimuat dari ' + targetCloudLabel, 'ok');
      }
    } else {
      appState.sharedSyncState.revision = Number(res.revision || appState.sharedSyncState.revision || 1);
      appState.sharedSyncState.snapshot = cloneJsonSafe(localBefore);
      appState.sharedSyncState.lastSyncedSnapshot = appState.sharedSyncState.snapshot;
      saveSyncPersistence(true);
      refreshRealtimeSubscription();
      if (isInitialOrManual === 'manual') {
        showToast('Data sudah sinkron dengan ' + targetCloudLabel, 'ok');
      }
    }
  } catch (err) {
    appState.sharedSyncState.lastError = (err && err.message) || '';
    if (err && err.status === 401) {
      void syncAppAuthStatus(true);
    } else if (isInitialOrManual === 'manual') {
      showToast((err && err.message) || 'Koneksi sinkronisasi tidak stabil, data lokal tetap aman', 'warn');
    }
  } finally {
    appState.sharedSyncState.inFlight = false;
    if (appState.sharedSyncState.dirty && !appState.sharedSyncState.retryTimer) {
      scheduleSharedSyncPush();
    }
  }
}

export function scheduleSharedSyncPush() {
  appState.sharedSyncState.dirty = true;
  appState.sharedSyncState.pending = true;
  saveSyncPersistence(false);
  if (!appState.appAuthStatusCache.authenticated) return;
  if (appState.sharedSyncState.retryTimer) {
    clearTimeout(appState.sharedSyncState.retryTimer);
    appState.sharedSyncState.retryTimer = null;
  }
  if (appState.sharedSyncState.pushTimer) clearTimeout(appState.sharedSyncState.pushTimer);
  appState.sharedSyncState.pushTimer = setTimeout(function () {
    appState.sharedSyncState.pushTimer = null;
    void pushSharedWarehouseState();
  }, 350);
}

export function startSharedSyncLoop() {
  stopSharedSyncLoop(false);
  updateSyncButtonUI();
  appState.sharedSyncState.pollTimer = setInterval(function () {
    if (document.hidden || !appState.appAuthStatusCache.authenticated) return;
    if (appState.sharedSyncState.pending) {
      if (!appState.sharedSyncState.inFlight && !appState.sharedSyncState.pushTimer && !appState.sharedSyncState.retryTimer) {
        void pushSharedWarehouseState();
      }
    } else if (appState.sharedSyncState.storageMode !== 'firestore') {
      void pullSharedWarehouseState(false);
    }
  }, 15000);
  if (appState.sharedSyncState.pending && appState.sharedSyncState.initialCloudLoaded) {
    void pushSharedWarehouseState();
  } else {
    void pullSharedWarehouseState(true);
  }
}

export function stopSharedSyncLoop(resetState?: boolean) {
  if (window.__sgpCloud && window.__sgpCloud.warehouse && window.__sgpCloud.warehouse.stopRealtime) {
    window.__sgpCloud.warehouse.stopRealtime();
  }
  if (appState.sharedSyncState.pollTimer) {
    clearInterval(appState.sharedSyncState.pollTimer);
    appState.sharedSyncState.pollTimer = null;
  }
  if (appState.sharedSyncState.pushTimer) {
    clearTimeout(appState.sharedSyncState.pushTimer);
    appState.sharedSyncState.pushTimer = null;
  }
  if (appState.sharedSyncState.retryTimer) {
    clearTimeout(appState.sharedSyncState.retryTimer);
    appState.sharedSyncState.retryTimer = null;
  }
  if (resetState) {
    appState.sharedSyncState.revision = 0;
    appState.sharedSyncState.snapshot = null;
    appState.sharedSyncState.lastSyncedSnapshot = null;
    appState.sharedSyncState.dirty = false;
    appState.sharedSyncState.pending = false;
    appState.sharedSyncState.pendingRender = false;
    appState.sharedSyncState.retryDelayMs = 2000;
    appState.sharedSyncState.offlineNotified = false;
    appState.sharedSyncState.initialCloudLoaded = false;
    safeDel(SYNC_META_KEY);
    safeDel(SYNC_BASE_KEY);
    updateSyncButtonUI();
  }
}

export function writeWarehouseData(wid: string, data: any, skipSync?: boolean) {
  var p = whPrefix(wid);
  FIELDS.forEach(function (f) {
    safeSet(p + f, data[f]);
  });
  safeSet(p + 'updatedAt', Date.now());
  if (!skipSync) {
    scheduleSharedSyncPush();
  }
}

export function deleteWarehouseStorage(wid: string, skipSync?: boolean) {
  var p = whPrefix(wid);
  FIELDS.forEach(function (f) {
    safeDel(p + f);
  });
  if (!skipSync) {
    scheduleSharedSyncPush();
  }
}

export function curData() {
  return readWarehouseData(appState.W.cur);
}
