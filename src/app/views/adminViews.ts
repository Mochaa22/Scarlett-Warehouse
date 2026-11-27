import { buildSampleData, isLocalDevEnvironment } from '../core/seedData.ts';
import { computeWarehouseAnalysis } from '../core/stockEngine.ts';
import { curData, defaultWhData, deleteWarehouseStorage, getWhMeta, readWarehouseData, saveRegistry, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { exportAllDatabaseExcel, importWorkbookToActive, parseDelimitedLines } from '../services/xlsxService.ts';
import { ROLE_LABELS, appState, renderApp } from '../state/store.ts';
import { closeTextModal, confirmDialog, iconSvg, openCopyTSV, openTextModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { defaultTabForRole, getEffectiveRole, persistPinSession, refreshPinStatus } from '../ui/rbac.ts';
import { defaultCutoffISO, esc, fmtNum, inferProductCategory, normBarcode, normLoc, normSku, parseDate, parseQty } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 11: KELOLA GUDANG ===
export function renderKelolaGudang(root) {
  var whStats = appState.W.list.map(function (w) {
    var wd = readWarehouseData(w.id);
    var wa = computeWarehouseAnalysis(wd);
    return { meta: w, stats: wa.stats, data: wd };
  });

  var html = pageHeaderHtml(
    'Kelola Gudang',
    'Atur daftar gudang, nama petugas pencatat transaksi, serta sinkronisasi Master Barang lintas gudang.'
  );

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Daftar Gudang</h2><span class="badge badge-neutral">' + appState.W.list.length + ' gudang</span></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Nama Gudang</th><th>Status</th><th class="right">SKU Aktif</th><th class="right">Total PCS</th><th class="right">Aksi</th></tr></thead><tbody>';

  whStats.forEach(function (ws) {
    var isCur = ws.meta.id === appState.W.cur;
    html += '<tr>' +
      '<td><input type="text" class="input wh-rename-inp" data-wh-id="' + esc(ws.meta.id) + '" value="' + esc(ws.meta.nama) + '" /></td>' +
      '<td>' + (isCur ? '<span class="badge badge-ok">Aktif</span>' : '<button type="button" class="btn btn-sm" data-wh-activate="' + esc(ws.meta.id) + '">Aktifkan</button>') + '</td>' +
      '<td class="right num">' + fmtNum(ws.stats.skuAktif) + '</td>' +
      '<td class="right num">' + fmtNum(ws.stats.totalPcs) + '</td>' +
      '<td class="right"><button type="button" class="btn btn-sm btn-danger" data-wh-del="' + esc(ws.meta.id) + '"' + (appState.W.list.length <= 1 ? ' disabled title="Minimal harus ada 1 gudang"' : '') + '>Hapus</button></td>' +
      '</tr>';
  });
  html += '</tbody></table></div></div>';

  html += '<div class="grid-2">';

  // Tambah Gudang
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Tambah Gudang Baru</h2></div>' +
    '<form id="form-add-wh">' +
    '<div class="field" style="margin-bottom:10px"><label for="new-wh-name">Nama Gudang</label><input id="new-wh-name" type="text" class="input" placeholder="Contoh: Scarlett GP2 Surabaya" required /></div>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer"><input id="copy-master-chk" type="checkbox" checked /> Salin Master Barang dari gudang aktif (' + esc(getWhMeta(appState.W.cur).nama) + ')</label>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer"><input id="copy-lokasi-chk" type="checkbox" /> Salin Master Lokasi dari gudang aktif</label>' +
    '<button type="submit" class="btn btn-primary">Tambah Gudang</button>' +
    '</form></div>';

  // Petugas & Sinkronisasi Master
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Petugas & Sinkronisasi Master</h2></div>' +
    '<form id="form-user" style="margin-bottom:16px">' +
    '<div class="field" style="margin-bottom:10px"><label for="wh-user-inp">Nama Petugas Aktif (Tercatat di setiap transaksi baru)</label><input id="wh-user-inp" type="text" class="input" value="' + esc(appState.W.user) + '" required /></div>' +
    '<button type="submit" class="btn btn-primary">Simpan Nama Petugas</button>' +
    '</form>' +
    '<hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />' +
    '<p class="muted" style="margin:0 0 10px;font-size:13px">Salin dan samakan seluruh daftar <strong>Master Barang</strong> dari gudang aktif (<strong>' + esc(getWhMeta(appState.W.cur).nama) + '</strong>) ke semua gudang lain.</p>' +
    '<button type="button" class="btn" id="sync-master-btn"' + (appState.W.list.length < 2 ? ' disabled' : '') + '>Sinkron Master Barang ke Semua Gudang</button>' +
    '</div></div>';

  root.innerHTML = html;

  root.querySelectorAll('.wh-rename-inp').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var id = inp.getAttribute('data-wh-id');
      var val = inp.value.trim();
      if (!val) { inp.value = getWhMeta(id).nama; return; }
      appState.W.list.forEach(function (w) { if (w.id === id) w.nama = val; });
      saveRegistry(true);
      showToast('Nama gudang diperbarui', 'ok');
      renderApp();
    });
  });

  root.querySelectorAll('[data-wh-activate]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      appState.W.cur = btn.getAttribute('data-wh-activate');
      saveRegistry();
      showToast('Gudang aktif: ' + getWhMeta(appState.W.cur).nama, 'ok');
      renderApp();
    });
  });

  root.querySelectorAll('[data-wh-del]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (appState.W.list.length <= 1) return;
      var id = btn.getAttribute('data-wh-del');
      var meta = getWhMeta(id);
      confirmDialog(
        'Hapus Gudang',
        '<p style="margin:0">Yakin ingin menghapus gudang <strong>' + esc(meta.nama) + '</strong> beserta seluruh stok dan transaksinya?</p>',
        function () {
          appState.W.list = appState.W.list.filter(function (w) { return w.id !== id; });
          deleteWarehouseStorage(id, true);
          if (appState.W.cur === id) appState.W.cur = appState.W.list[0].id;
          saveRegistry(true);
          showToast('Gudang ' + meta.nama + ' dihapus', 'ok');
          renderApp();
        },
        true
      );
    });
  });

  byId('form-add-wh').addEventListener('submit', function (e) {
    e.preventDefault();
    var nama = byId('new-wh-name').value.trim();
    if (!nama) return;
    var newId = 'g_' + Date.now().toString(36);
    var newData = defaultWhData();
    var activeD = curData();
    if (byId('copy-master-chk').checked) {
      newData.master = activeD.master.map(function (m) { return Object.assign({}, m); });
    }
    if (byId('copy-lokasi-chk').checked) {
      newData.lokasi = activeD.lokasi.slice();
    }
    newData.cutoff = activeD.cutoff;
    newData.min = activeD.min;
    newData.cover = activeD.cover;
    newData.expMonths = activeD.expMonths;

    appState.W.list.push({ id: newId, nama: nama, legacy: false });
    appState.W.cur = newId;
    saveRegistry(true);
    writeWarehouseData(newId, newData);
    showToast('Gudang baru "' + nama + '" ditambahkan dan diaktifkan', 'ok');
    renderApp();
  });

  byId('form-user').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = byId('wh-user-inp').value.trim();
    if (!u) return;
    appState.W.user = u;
    saveRegistry();
    showToast('Nama petugas disimpan: ' + u, 'ok');
    renderApp();
  });

  byId('sync-master-btn').addEventListener('click', function () {
    var srcD = curData();
    confirmDialog(
      'Sinkron Master Barang',
      '<p style="margin:0">Menimpa daftar Master Barang di <strong>' + (appState.W.list.length - 1) + '</strong> gudang lain dengan <strong>' + srcD.master.length + '</strong> item dari ' + esc(getWhMeta(appState.W.cur).nama) + '. Lanjutkan?</p>',
      function () {
        appState.W.list.forEach(function (w) {
          if (w.id === appState.W.cur) return;
          var wd = readWarehouseData(w.id);
          wd.master = srcD.master.map(function (m) { return Object.assign({}, m); });
          writeWarehouseData(w.id, wd);
        });
        showToast('Master Barang disinkronkan ke semua gudang', 'ok');
        renderApp();
      },
      false
    );
  });
}

// === HALAMAN 12: MASTER & IMPOR ===
export function renderMasterImpor(root, d) {
  var html = pageHeaderHtml(
    'Master & Impor',
    'Impor seluruh buku kerja .xlsx dari Google Sheets ke gudang aktif atau tempel data Master dan Stok Awal secara manual.'
  );

  if (window.__lastImportSummary && window.__lastImportSummary.length) {
    html += '<div class="card card-ok-tone"><div class="card-header"><h2 class="card-title">Ringkasan Impor Terakhir (' + esc(getWhMeta(appState.W.cur).nama) + ')</h2>' +
      '<button type="button" class="btn btn-sm" id="clear-imp-sum">Tutup</button></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
      window.__lastImportSummary.map(function (s) { return '<span class="badge badge-ok">' + esc(s) + '</span>'; }).join('') +
      '</div></div>';
  }

  html += '<div class="card"><div class="card-header"><h2 class="card-title">1. Impor Spreadsheet (.xlsx) ke ' + esc(getWhMeta(appState.W.cur).nama) + '</h2></div>' +
    '<div id="xlsx-dropzone" class="dropzone" tabindex="0">' +
    '<strong>Klik untuk memilih file .xlsx</strong> atau seret file ke area ini' +
    '<p class="muted" style="margin:6px 0 0;font-size:12.5px">Sheet yang dibaca: Master Barang, Master Lokasi, STOCK CONFIG (B2), OPENING_GP1_30SEP, ALL STOCK, Barang Masuk (kolom Batch &amp; Exp opsional), Barang Keluar, Perpindahan Lokasi, serta sheet opsional Expire / Batch Expire &amp; Defect.</p>' +
    '<input id="xlsx-file-input" type="file" accept=".xlsx,.xls" style="display:none" />' +
    '</div></div>';

  html += '<div class="grid-3">' +
    '<div class="card"><div class="card-header"><h2 class="card-title">Tempel Master Barang</h2><span class="badge badge-neutral">' + d.master.length + '</span></div>' +
    '<p class="muted" style="font-size:12px;margin-top:0">Format per baris (Tab / Koma): <code>Barcode, SKU, Nama[, Kategori]</code></p>' +
    '<textarea id="paste-master" class="input" placeholder="8997236030012\t5000011\tScarlett Body Lotion Romansa\tBody Lotion"></textarea>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn btn-primary btn-sm" id="btn-imp-master">Terapkan (Timpa)</button></div></div>' +

    '<div class="card"><div class="card-header"><h2 class="card-title">Tempel Master Lokasi</h2><span class="badge badge-neutral">' + d.lokasi.length + '</span></div>' +
    '<p class="muted" style="font-size:12px;margin-top:0">Satu nama lokasi per baris (otomatis huruf besar &amp; dirapikan).</p>' +
    '<textarea id="paste-lokasi" class="input" placeholder="RAK-A1\nRAK-A2\nSTAGING"></textarea>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn btn-primary btn-sm" id="btn-imp-lokasi">Terapkan (Timpa)</button></div></div>' +

    '<div class="card"><div class="card-header"><h2 class="card-title">Tempel Stok Awal</h2><span class="badge badge-neutral">' + d.opening.length + '</span></div>' +
    '<p class="muted" style="font-size:12px;margin-top:0">Format per baris: <code>Lokasi, Barcode, SKU, Nama, Qty</code></p>' +
    '<textarea id="paste-opening" class="input" placeholder="RAK-A1\t8997236030012\t5000011\tScarlett Romansa\t120"></textarea>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn btn-primary btn-sm" id="btn-imp-opening">Terapkan (Timpa)</button></div></div>' +
    '</div>';

  // Pratinjau Master Barang & Lokasi
  var masterQ = (appState.masterSearch || '').trim().toUpperCase();
  var masterRowsWithIdx = (d.master || []).map(function (m, idx) {
    return { item: m, idx: idx };
  }).filter(function (entry) {
    if (!masterQ) return true;
    var m = entry.item;
    return [m.barcode, m.sku, m.nama, inferProductCategory(m.nama, m.kategori)].join(' ').toUpperCase().indexOf(masterQ) >= 0;
  });

  html += '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><h2 class="card-title">Master Barang Tersimpan</h2>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="badge badge-neutral">' + fmtNum(masterRowsWithIdx.length) + '/' + fmtNum(d.master.length) + '</span>' +
    '<button type="button" class="btn btn-sm" id="copy-master-btn">Salin TSV</button>' +
    '</div></div>' +
    '<div class="toolbar" style="margin-bottom:10px">' +
    '<div class="search-wrap" style="max-width:none"><input id="search-master" type="search" class="input" placeholder="Cari barcode, SKU, nama produk, kategori…" value="' + esc(appState.masterSearch || '') + '" /><span class="search-kbd">/</span></div>' +
    '</div>' +
    '<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Barcode</th><th>SKU</th><th>Nama Produk</th><th>Kategori</th><th class="right">Aksi</th></tr></thead><tbody>' +
    (masterRowsWithIdx.length ? masterRowsWithIdx.map(function (entry) {
      var m = entry.item;
      return '<tr>' +
        '<td class="mono">' + esc(m.barcode) + '</td>' +
        '<td class="mono">' + esc(m.sku) + '</td>' +
        '<td>' + esc(m.nama) + '</td>' +
        '<td>' + esc(inferProductCategory(m.nama, m.kategori)) + '</td>' +
        '<td class="right"><button type="button" class="btn btn-sm btn-danger" data-del-master-idx="' + entry.idx + '">Hapus</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" class="muted" style="text-align:center">' + (d.master.length ? 'Tidak ada barang yang cocok dengan pencarian.' : 'Belum ada Master Barang.') + '</td></tr>') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-header"><h2 class="card-title">Master Lokasi Tersimpan</h2><button type="button" class="btn btn-sm" id="copy-lokasi-btn">Salin TSV</button></div>' +
    '<div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Lokasi</th></tr></thead><tbody>' +
    (d.lokasi.length ? d.lokasi.map(function (l) {
      return '<tr><td>' + esc(l) + '</td></tr>';
    }).join('') : '<tr><td class="muted" style="text-align:center">Belum ada Master Lokasi.</td></tr>') +
    '</tbody></table></div></div></div>';

  root.innerHTML = html;

  function matchesMasterRecord(rec: any, targetItem: any) {
    if (!rec || !targetItem) return false;
    var tSku = normSku(targetItem.sku);
    var tBc = normBarcode(targetItem.barcode);
    var rSku = normSku(rec.sku);
    var rBc = normBarcode(rec.barcode);
    if (tSku === '5000054' && tBc) {
      return rSku === tSku && (!rBc || rBc === tBc);
    }
    if (tBc && rBc && tBc === rBc) return true;
    if (tSku && rSku && tSku === rSku) return true;
    return false;
  }

  function getMasterItemTransactionUsage(whData: any, targetItem: any) {
    var counts = {
      masuk: 0,
      keluar: 0,
      pindah: 0,
      defect: 0,
      inboundRegister: 0,
      batches: 0,
      cycleCounts: 0
    };
    (whData.masuk || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.masuk++; });
    (whData.keluar || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.keluar++; });
    (whData.pindah || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.pindah++; });
    (whData.defect || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.defect++; });
    (whData.inboundRegister || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.inboundRegister++; });
    (whData.batches || []).forEach(function (r) { if (matchesMasterRecord(r, targetItem)) counts.batches++; });
    (whData.cycleCounts || []).forEach(function (sess) {
      (sess.items || []).forEach(function (it) {
        if (matchesMasterRecord(it, targetItem)) counts.cycleCounts++;
      });
    });
    var details: string[] = [];
    if (counts.masuk) details.push(counts.masuk + ' Barang Masuk');
    if (counts.keluar) details.push(counts.keluar + ' Barang Keluar');
    if (counts.pindah) details.push(counts.pindah + ' Perpindahan');
    if (counts.inboundRegister) details.push(counts.inboundRegister + ' Surat Jalan');
    if (counts.defect) details.push(counts.defect + ' Defect/Karantina');
    if (counts.batches) details.push(counts.batches + ' Batch Expire');
    if (counts.cycleCounts) details.push(counts.cycleCounts + ' Cycle Count');
    return {
      total: counts.masuk + counts.keluar + counts.pindah + counts.defect + counts.inboundRegister + counts.batches + counts.cycleCounts,
      details: details
    };
  }

  var searchMasterEl = byId('search-master');
  if (searchMasterEl) {
    searchMasterEl.addEventListener('input', function (e) {
      appState.masterSearch = targetEl(e).value;
      renderApp();
      var s = byId('search-master');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
  }

  root.querySelectorAll('[data-del-master-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = Number(btn.getAttribute('data-del-master-idx'));
      var dNow = curData();
      var target = (dNow.master || [])[idx];
      if (!target) return;

      var usage = getMasterItemTransactionUsage(dNow, target);
      if (usage.total > 0) {
        showToast('Tidak dapat menghapus: barang sudah memiliki riwayat transaksi', 'err');
        confirmDialog(
          'Penghapusan Ditolak',
          '<p style="margin:0 0 8px">Item <strong>' + esc(target.nama || target.sku || target.barcode) + '</strong> (<span class="mono">' + esc(target.sku || target.barcode) + '</span>) tidak dapat dihapus dari Master Data karena sudah memiliki <strong>' + fmtNum(usage.total) + ' riwayat transaksi</strong>:</p>' +
          '<p class="muted" style="margin:0">' + esc(usage.details.join(' · ')) + '</p>',
          null,
          false
        );
        return;
      }

      confirmDialog(
        'Konfirmasi Hapus Master Barang',
        '<p style="margin:0 0 8px">Anda yakin ingin menghapus barang berikut dari Master Data gudang aktif?</p>' +
        '<div class="inline-alert warn" style="margin:0">' +
        '<strong>' + esc(target.nama || '-') + '</strong><br/>' +
        'SKU: <span class="mono">' + esc(target.sku || '-') + '</span> · Barcode: <span class="mono">' + esc(target.barcode || '-') + '</span>' +
        '</div>',
        function () {
          var latest = curData();
          var curItem = (latest.master || [])[idx];
          if (!curItem || normSku(curItem.sku) !== normSku(target.sku) || normBarcode(curItem.barcode) !== normBarcode(target.barcode)) {
            showToast('Daftar Master berubah, silakan pilih ulang item', 'warn');
            renderApp();
            return;
          }
          var latestUsage = getMasterItemTransactionUsage(latest, curItem);
          if (latestUsage.total > 0) {
            showToast('Gagal hapus: barang memiliki riwayat transaksi (' + latestUsage.details.join(', ') + ')', 'err');
            renderApp();
            return;
          }
          latest.master.splice(idx, 1);
          writeWarehouseData(appState.W.cur, latest);
          showToast('Item "' + (curItem.nama || curItem.sku || curItem.barcode) + '" dihapus dari Master Data', 'ok');
          renderApp();
        },
        true
      );
    });
  });

  var clearSum = byId('clear-imp-sum');
  if (clearSum) {
    clearSum.addEventListener('click', function () {
      window.__lastImportSummary = null;
      renderApp();
    });
  }

  var dz = byId('xlsx-dropzone');
  var fileInp = byId('xlsx-file-input');
  dz.addEventListener('click', function () { fileInp.click(); });
  dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInp.click(); } });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      importWorkbookToActive(e.dataTransfer.files[0]);
    }
  });
  fileInp.addEventListener('change', function () {
    if (fileInp.files && fileInp.files[0]) {
      importWorkbookToActive(fileInp.files[0]);
      fileInp.value = '';
    }
  });

  byId('btn-imp-master').addEventListener('click', function () {
    var lines = parseDelimitedLines(byId('paste-master').value);
    var items = [];
    lines.forEach(function (cols) {
      var bc = normBarcode(cols[0]);
      var sku = normSku(cols[1]);
      var nama = String(cols[2] || '').trim();
      var kat = String(cols[3] || '').trim();
      if (bc || sku) {
        var mObj: Record<string, any> = { barcode: bc, sku: sku, nama: nama };
        if (kat) mObj.kategori = kat;
        items.push(mObj);
      }
    });
    if (items.length === 0) { showToast('Tidak ada baris valid untuk Master Barang', 'warn'); return; }
    var dNow = curData();
    dNow.master = items;
    writeWarehouseData(appState.W.cur, dNow);
    showToast(items.length + ' Master Barang disimpan', 'ok');
    renderApp();
  });

  byId('btn-imp-lokasi').addEventListener('click', function () {
    var lines = parseDelimitedLines(byId('paste-lokasi').value);
    var setL = new Set();
    lines.forEach(function (cols) {
      var l = normLoc(cols[0]);
      if (l) setL.add(l);
    });
    var arr = Array.from(setL);
    if (arr.length === 0) { showToast('Tidak ada lokasi valid', 'warn'); return; }
    var dNow = curData();
    dNow.lokasi = arr;
    writeWarehouseData(appState.W.cur, dNow);
    showToast(arr.length + ' Master Lokasi disimpan', 'ok');
    renderApp();
  });

  byId('btn-imp-opening').addEventListener('click', function () {
    var lines = parseDelimitedLines(byId('paste-opening').value);
    var items = [];
    lines.forEach(function (cols) {
      var lok = normLoc(cols[0]);
      var bc = normBarcode(cols[1]);
      var sku = normSku(cols[2]);
      var nama = String(cols[3] || '').trim();
      var qty = parseQty(cols[4]);
      if (lok && sku) items.push({ lok: lok, barcode: bc, sku: sku, nama: nama, qty: qty });
    });
    if (items.length === 0) { showToast('Tidak ada baris Stok Awal yang valid', 'warn'); return; }
    var dNow = curData();
    dNow.opening = items;
    writeWarehouseData(appState.W.cur, dNow);
    showToast(items.length + ' baris Stok Awal disimpan', 'ok');
    renderApp();
  });

  byId('copy-master-btn').addEventListener('click', function () {
    openCopyTSV('Salin Master Barang', ['Barcode', 'SKU', 'Nama Produk', 'Kategori'], d.master.map(function (m) {
      return [m.barcode, m.sku, m.nama, inferProductCategory(m.nama, m.kategori)];
    }));
  });

  byId('copy-lokasi-btn').addEventListener('click', function () {
    openCopyTSV('Salin Master Lokasi', ['Lokasi'], d.lokasi.map(function (l) { return [l]; }));
  });
}

// === HALAMAN 13: PENGATURAN & MASTER (KHUSUS SUPER ADMIN) ===
export function renderPengaturan(root, d) {
  var segHtml = '<div class="seg-group" role="tablist" aria-label="Menu Super Admin">' +
    '<button type="button" class="seg-btn' + (appState.settingsTab === 'role' ? ' active' : '') + '" data-cfg-tab="role">Akun &amp; PIN Role</button>' +
    '<button type="button" class="seg-btn' + (appState.settingsTab === 'master' ? ' active' : '') + '" data-cfg-tab="master">Master, Gudang &amp; Cadangan</button>' +
    '<button type="button" class="seg-btn' + (appState.settingsTab === 'tools' ? ' active' : '') + '" data-cfg-tab="tools">Alat Lanjutan</button>' +
    '</div>';

  var html = pageHeaderHtml(
    'Pengaturan & Master',
    'Pusat kendali Super Admin: kelola PIN akses Admin & Super Admin, Master SKU, parameter gudang, dan alat lanjutan.',
    segHtml
  );

  if (appState.settingsTab === 'role') {
    var pinConfigured = !!appState.pinStatusCache.configured;
    var activeRoleNow = getEffectiveRole();
    var storageLabel = appState.sharedSyncState.storageMode === 'firestore'
      ? 'Firebase Firestore (Cloud Persisten & Sinkron Real-Time)'
      : (appState.sharedSyncState.storageMode === 'redis'
          ? 'Redis / Vercel KV (Sinkron Lintas Perangkat)'
          : (appState.sharedSyncState.storageMode === 'ephemeral'
              ? 'Penyimpanan Sementara'
              : 'File Server Persisten (Sinkron Lintas Perangkat)'));

    html += '<div class="grid-2">' +
      '<div class="card"><div class="card-header"><h2 class="card-title">Sesi Login &amp; Hak Akses</h2>' +
      '<span class="badge badge-info">' + esc(ROLE_LABELS[activeRoleNow]) + '</span></div>' +
      '<div class="inline-alert info" style="margin-bottom:14px">' +
      'Setiap pengguna yang masuk melalui akun Google otomatis memulai sesi sebagai <strong>Stockkeeper</strong>. Akses <strong>Admin</strong> dan <strong>Super Admin</strong> hanya dapat dibuka dengan memasukkan PIN.' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px">' +
      '<div><span class="muted">Akun Google Aktif:</span> <strong>' + esc(appState.appAuthEmail || appState.W.user || '-') + '</strong></div>' +
      '<div><span class="muted">Role Default Setelah Login:</span> <strong>Stockkeeper</strong></div>' +
      '<div><span class="muted">Status Sesi PIN:</span> <strong>' + (appState.pinSessionToken && appState.pinSessionRole ? ('Terbuka (' + esc(ROLE_LABELS[appState.pinSessionRole]) + ')') : 'Terkunci (Stockkeeper)') + '</strong></div>' +
      '<div><span class="muted">Database Cloud:</span> <strong>' + esc(storageLabel) + '</strong> (Sinkron #' + esc(appState.sharedSyncState.revision) + ')</div>' +
      '</div>' +
      (appState.pinSessionToken ? '<div style="margin-top:14px"><button type="button" class="btn btn-danger" id="session-lock-btn">Kunci Akses PIN &amp; Kembali ke Stockkeeper</button></div>' : '') +
      '</div>';

    html += '<div class="card"><div class="card-header"><h2 class="card-title">PIN Akses Admin &amp; Super Admin</h2>' +
      '<span class="badge ' + (pinConfigured ? 'badge-ok' : 'badge-warn') + '">' +
      (appState.pinStatusCache.envManaged ? 'Server Env' : (pinConfigured ? 'PIN Aktif (Cloud)' : 'Belum Diatur')) +
      '</span></div>' +
      '<p class="muted" style="margin-top:0;font-size:12.5px">PIN tersimpan terenkripsi di Firebase Firestore agar perpindahan ke role Admin dan Super Admin tetap terlindungi di semua perangkat.</p>';

    if (appState.pinStatusCache.envManaged) {
      html += '<div class="inline-alert info">PIN dikelola melalui environment variable server (<code>ADMIN_BACKUP_PIN</code> &amp; <code>SUPER_ADMIN_BACKUP_PIN</code>).</div>';
    } else {
      html += '<form id="form-pin-manage">' +
        (pinConfigured && !appState.pinSessionToken
          ? '<div class="field" style="margin-bottom:10px"><label for="pin-cur-super">PIN Super Admin Lama</label><input id="pin-cur-super" type="password" inputmode="numeric" class="input" required placeholder="Masukkan PIN Super Admin saat ini…" autocomplete="off" /></div>'
          : '') +
        '<div class="field" style="margin-bottom:10px"><label for="pin-new-super">PIN Super Admin Baru (min. 4 karakter)</label><input id="pin-new-super" autocomplete="new-password" maxlength="24" type="password" inputmode="numeric" class="input" required minlength="4" placeholder="Mis. 2580" /></div>' +
        '<div class="field" style="margin-bottom:14px"><label for="pin-new-admin">PIN Admin Baru (harus berbeda)</label><input id="pin-new-admin" autocomplete="new-password" maxlength="24" type="password" inputmode="numeric" class="input" required minlength="4" placeholder="Mis. 1357" /></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="submit" class="btn btn-primary">' + (pinConfigured ? 'Perbarui PIN' : 'Simpan PIN Awal') + '</button>' +
        (appState.pinSessionToken ? '<button type="button" class="btn btn-danger" id="pin-logout-btn">Kunci Sesi PIN</button>' : '') +
        '</div></form>';
    }
    html += '</div></div>';

    html += '<div class="card" style="margin-top:14px"><div class="card-header">' +
      '<h2 class="card-title">Akses Tim Google (Multi-User &amp; Multi-Device)</h2>' +
      '<span class="badge badge-info">Masuk via Google</span></div>' +
      '<p class="muted" style="margin-top:0;font-size:12.5px">Daftarkan alamat email Google petugas gudang agar mereka dapat langsung login dengan Google dan mengakses database Firebase gudang yang sama secara real-time.</p>' +
      '<div class="grid-2">' +
      '<form id="form-add-operator-user">' +
      '<div class="field" style="margin-bottom:10px"><label for="op-email">Email Google Operator</label><input id="op-email" type="email" class="input" required placeholder="operator@gmail.com" autocomplete="off" /></div>' +
      '<div class="field" style="margin-bottom:14px"><label for="op-name">Nama Operator</label><input id="op-name" type="text" class="input" maxlength="80" placeholder="Mis. Budi / Shift Malam" /></div>' +
      '<button type="submit" class="btn btn-primary">Tambah / Perbarui Akses Operator</button>' +
      '</form>' +
      '<div><div id="operator-users-list"><p class="muted" style="font-size:13px;margin:0">Memuat daftar akun…</p></div></div>' +
      '</div></div>';

    root.innerHTML = html;

    root.querySelectorAll('[data-cfg-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        appState.settingsTab = b.getAttribute('data-cfg-tab');
        renderApp();
      });
    });

    var sessionLockBtn = byId('session-lock-btn');
    if (sessionLockBtn) {
      sessionLockBtn.addEventListener('click', function () {
        persistPinSession('', null);
        appState.rolePreviewOverride = '';
        appState.currentTab = defaultTabForRole(getEffectiveRole());
        showToast('Akses PIN dikunci. Kembali ke mode Stockkeeper.', 'ok');
        renderApp();
      });
    }

    var pinManageForm = byId('form-pin-manage');
    if (pinManageForm) {
      pinManageForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var curInp = byId('pin-cur-super');
        var superPin = byId('pin-new-super').value.trim();
        var adminInput = byId('pin-new-admin');
        var adminPin = adminInput.value.trim();
        if (superPin === adminPin) {
          showToast('Kedua PIN terisi sama. Isi kolom Admin dengan PIN lain, lalu simpan kembali.', 'err');
          adminInput.focus();
          adminInput.select();
          return;
        }
        var curSuperPin = curInp ? curInp.value.trim() : '';
        try {
          var res = await window.__sgpCloud.pinAuth.setupPins(
            { superAdminPin: superPin, adminPin: adminPin, currentSuperAdminPin: curSuperPin || undefined },
            appState.pinSessionToken || null,
            appState.appAuthToken || null
          );
          persistPinSession(res.token, res.role);
          appState.pinStatusCache.configured = true;
          appState.pinStatusCache.hasAdminPin = true;
          appState.pinStatusCache.hasSuperAdminPin = true;
          showToast('PIN berhasil disimpan di server', 'ok');
          renderApp();
        } catch (err) {
          showToast(err.message || 'Gagal menyimpan PIN', 'err');
        }
      });
    }

    var pinLogoutBtn = byId('pin-logout-btn');
    if (pinLogoutBtn) {
      pinLogoutBtn.addEventListener('click', function () {
        persistPinSession('', null);
        appState.rolePreviewOverride = '';
        appState.currentTab = defaultTabForRole(getEffectiveRole());
        showToast('Sesi PIN dikunci', 'ok');
        renderApp();
      });
    }

    async function loadAndRenderOperatorUsers() {
      var box = byId('operator-users-list');
      if (!box || !window.__sgpCloud || !window.__sgpCloud.appAuth) return;
      if (!appState.pinSessionToken) {
        box.innerHTML = '<div class="inline-alert warn" style="font-size:12.5px">Aktifkan sesi PIN Super Admin terlebih dahulu untuk melihat dan mengelola akun operator.</div>';
        return;
      }
      try {
        var data = await window.__sgpCloud.appAuth.listUsers(appState.pinSessionToken || null, appState.appAuthToken || null);
        var rowsHtml = '';
        if (data.primaryEmail) {
          rowsHtml += '<tr><td><strong>' + esc(data.primaryEmail) + '</strong></td><td>Akun Aktif</td><td><span class="badge badge-ok">Google Auth</span></td><td></td></tr>';
        }
        (data.users || []).forEach(function (u) {
          rowsHtml += '<tr><td>' + esc(u.email) + '</td><td>' + esc(u.name || '-') + '</td><td><span class="badge badge-ok">Firebase</span></td>' +
            '<td class="right"><button type="button" class="btn btn-sm btn-danger" data-del-op="' + esc(u.email) + '">Hapus</button></td></tr>';
        });
        if (!rowsHtml) {
          box.innerHTML = '<p class="muted" style="font-size:13px;margin:0">Belum ada akun operator tambahan.</p>';
          return;
        }
        box.innerHTML = '<div class="table-wrap" style="max-height:240px"><table><thead><tr><th>Email Google</th><th>Nama</th><th>Sumber</th><th></th></tr></thead><tbody>' +
          rowsHtml + '</tbody></table></div>';
        box.querySelectorAll('[data-del-op]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var targetEmail = btn.getAttribute('data-del-op');
            if (!targetEmail) return;
            confirmDialog(
              'Hapus Akses Operator',
              '<p style="margin:0">Cabut akses login untuk <strong>' + esc(targetEmail) + '</strong>?</p>',
              async function () {
                try {
                  await window.__sgpCloud.appAuth.deleteUser(targetEmail, appState.pinSessionToken || null, appState.appAuthToken || null);
                  showToast('Akses operator dihapus: ' + targetEmail, 'ok');
                  void loadAndRenderOperatorUsers();
                } catch (err) {
                  showToast((err && err.message) || 'Gagal menghapus akses operator', 'err');
                }
              },
              true
            );
          });
        });
      } catch (err) {
        box.innerHTML = '<div class="inline-alert err" style="font-size:12.5px">' + esc((err && err.message) || 'Gagal memuat daftar akun operator') + '</div>';
      }
    }

    var addOpForm = byId('form-add-operator-user');
    if (addOpForm) {
      addOpForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var emailVal = byId('op-email').value.trim();
        var nameVal = byId('op-name').value.trim();
        try {
          await window.__sgpCloud.appAuth.saveUser(
            { email: emailVal, name: nameVal, role: 'stockkeeper' },
            appState.pinSessionToken || null,
            appState.appAuthToken || null
          );
          byId('op-email').value = '';
          byId('op-name').value = '';
          showToast('Akses Google operator disimpan: ' + emailVal, 'ok');
          void loadAndRenderOperatorUsers();
        } catch (err) {
          showToast((err && err.message) || 'Gagal menyimpan akses operator', 'err');
        }
      });
    }

    refreshPinStatus();
    void loadAndRenderOperatorUsers();
    return;
  }

  if (appState.settingsTab === 'tools') {
    var tools = [
      { id: 'cyclecount', title: 'Cycle Count & Audit', desc: 'Rekap selisih stok per lokasi, nilai persentase akurasi, dan unduh CSV server.' },
      { id: 'defect', title: 'Barang Defect / Retur', desc: 'Catat barang rusak, penyok, atau karantina agar terpisah dari stok layak jual.' },
      { id: 'expire', title: 'Monitor Expire & FEFO', desc: 'Pantau batch mendekati kedaluwarsa dan terapkan prioritas pengeluaran FEFO.' },
      { id: 'transfer', title: 'Transfer Antar Gudang', desc: 'Catat dan sinkronkan perpindahan stok antar cabang gudang terdaftar.' },
      { id: 'opname', title: 'Stock Opname Manual', desc: 'Input hasil hitung fisik menyeluruh untuk penyesuaian saldo gudang.' },
      { id: 'analitik', title: 'Analitik & Reorder', desc: 'Proyeksi cover stok harian, tren keluar, dan daftar barang perlu restock.' },
      { id: 'cek', title: 'Cek Konsistensi Data', desc: 'Audit otomatis duplikasi SKU/barcode, minus stok, dan anomali transaksi.' }
    ];

    html += '<div class="card"><div class="card-header"><h2 class="card-title">Alat Lanjutan Khusus Super Admin</h2><span class="badge badge-info">Tersimpan Rapi</span></div>' +
      '<p class="muted" style="margin-top:0;font-size:13px">Menu lanjutan disembunyikan dari layar utama agar operasional harian Stockkeeper &amp; Admin tetap super simpel.</p>' +
      '<div class="tool-tile-grid">';
    tools.forEach(function (t) {
      html += '<button type="button" class="tool-tile" data-go-tab="' + t.id + '">' +
        '<div class="tool-tile-head">' + iconSvg(t.id) + '<span>' + esc(t.title) + '</span></div>' +
        '<div class="tool-tile-desc">' + esc(t.desc) + '</div>' +
        '</button>';
    });
    html += '</div></div>';

    root.innerHTML = html;

    root.querySelectorAll('[data-cfg-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        appState.settingsTab = b.getAttribute('data-cfg-tab');
        renderApp();
      });
    });
    root.querySelectorAll('[data-go-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        appState.currentTab = b.getAttribute('data-go-tab');
        renderApp();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    return;
  }

  // Default tab: 'master' (Master, Gudang & Cadangan)
  html += '<div class="card" style="margin-bottom:14px"><div class="card-header"><h2 class="card-title">Akses Cepat Master &amp; Multi-Gudang</h2></div>' +
    '<div class="tool-tile-grid">' +
    '<button type="button" class="tool-tile" data-go-tab="master"><div class="tool-tile-head">' + iconSvg('master') + '<span>Master SKU &amp; Impor</span></div><div class="tool-tile-desc">Kelola katalog produk, barcode, lokasi rak, stok awal, dan impor Sheets.</div></button>' +
    '<button type="button" class="tool-tile" data-go-tab="gudang"><div class="tool-tile-head">' + iconSvg('gudang') + '<span>Kelola Gudang</span></div><div class="tool-tile-desc">Tambah cabang gudang baru, ganti nama gudang aktif, atau hapus gudang.</div></button>' +
    '<button type="button" class="tool-tile" data-go-tab="semua"><div class="tool-tile-head">' + iconSvg('semua') + '<span>Ringkasan Semua Gudang</span></div><div class="tool-tile-desc">Lihat total stok lintas seluruh cabang gudang dalam satu tampilan.</div></button>' +
    '</div></div>';

  html += '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><h2 class="card-title">Parameter Gudang Aktif (' + esc(getWhMeta(appState.W.cur).nama) + ')</h2></div>' +
    '<form id="form-cfg">' +
    '<div class="field" style="margin-bottom:12px"><label for="cfg-cutoff">Tanggal Cutoff (Periode Aktif)</label><input id="cfg-cutoff" type="date" class="input" value="' + esc(d.cutoff) + '" /></div>' +
    '<div class="field" style="margin-bottom:12px"><label for="cfg-min">Batas Stok Menipis (PCS)</label><input id="cfg-min" type="number" min="0" class="input num" value="' + esc(d.min) + '" /></div>' +
    '<div class="field" style="margin-bottom:12px"><label for="cfg-mode">Sumber Perhitungan Stok</label><select id="cfg-mode" class="input">' +
    '<option value="mut"' + (d.mode === 'mut' ? ' selected' : '') + '>Mutasi (Stok Awal + Masuk − Keluar ± Pindah)</option>' +
    '<option value="all"' + (d.mode === 'all' ? ' selected' : '') + '>Snapshot ALL STOCK + Transaksi Baru (n:1)</option>' +
    '</select></div>' +
    '<div class="field" style="margin-bottom:12px"><label for="cfg-cover">Target Cover Stok Analitik (Hari)</label><input id="cfg-cover" type="number" min="1" class="input num" value="' + esc(d.cover) + '" /></div>' +
    '<div class="field" style="margin-bottom:14px"><label for="cfg-exp-months">Ambang Deteksi Expire Otomatis (Bulan)</label><input id="cfg-exp-months" type="number" min="1" max="36" class="input num" value="' + esc(d.expMonths || 7) + '" /></div>' +
    '<button type="submit" class="btn btn-primary">Simpan Pengaturan</button>' +
    '</form></div>';

  var canSeedDev = isLocalDevEnvironment();

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Cadangan, Pemulihan &amp; Publikasi</h2></div>' +
    '<div style="display:flex;flex-direction:column;gap:10px">' +
    '<button type="button" class="btn btn-primary" id="btn-export-all-xlsx">' + iconSvg('download') + '<span>Download Semua Database Excel (.xlsx)</span></button>' +
    '<button type="button" class="btn" id="btn-copy-html">Salin HTML Mandiri (Siap Publikasi)</button>' +
    '<button type="button" class="btn" id="btn-backup-json">Backup JSON Semua Gudang</button>' +
    '<button type="button" class="btn" id="btn-restore-json">Pulihkan Data (JSON Lama / Multi-Gudang)</button>' +
    (canSeedDev ? '<button type="button" class="btn" id="btn-load-sample">Muat Data Contoh (Dev Only)</button>' : '') +
    '<button type="button" class="btn btn-danger" id="btn-reset-wh">Reset Gudang Aktif</button>' +
    '</div>' +
    '<p class="form-hint">Tombol "Salin HTML Mandiri" menghasilkan satu file .html utuh tanpa framework untuk disimpan dan dipublikasikan di hosting web mana pun.</p>' +
    '</div></div>';

  root.innerHTML = html;

  root.querySelectorAll('[data-cfg-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.settingsTab = b.getAttribute('data-cfg-tab');
      renderApp();
    });
  });

  root.querySelectorAll('[data-go-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.currentTab = b.getAttribute('data-go-tab');
      renderApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  byId('form-cfg').addEventListener('submit', function (e) {
    e.preventDefault();
    var dNow = curData();
    dNow.cutoff = parseDate(byId('cfg-cutoff').value) || defaultCutoffISO();
    dNow.min = Math.max(0, Number(byId('cfg-min').value || 0));
    dNow.mode = byId('cfg-mode').value === 'all' ? 'all' : 'mut';
    dNow.cover = Math.max(1, Number(byId('cfg-cover').value || 7));
    dNow.expMonths = Math.max(1, Number(byId('cfg-exp-months').value || 7));
    writeWarehouseData(appState.W.cur, dNow);
    showToast('Pengaturan disimpan', 'ok');
    renderApp();
  });

  byId('btn-export-all-xlsx').addEventListener('click', exportAllDatabaseExcel);

  byId('btn-copy-html').addEventListener('click', function () {
    var snap = appState.initialHtmlSnapshot || ('<!DOCTYPE html>\n' + document.documentElement.outerHTML);
    openTextModal({
      title: 'Salin HTML Mandiri (Scarlett GP1)',
      desc: 'Salin seluruh kode di bawah ini dan simpan sebagai file berakhiran .html (misalnya scarlett-gp1.html) untuk dipublikasikan.',
      text: snap,
      actionLabel: 'Salin Seluruh HTML',
      readonly: true
    });
  });

  byId('btn-backup-json').addEventListener('click', function () {
    var payload = {
      format: 'sgp1_multi_v1',
      exportedAt: new Date().toISOString(),
      W: appState.W,
      warehouses: {}
    };
    appState.W.list.forEach(function (w) {
      payload.warehouses[w.id] = readWarehouseData(w.id);
    });
    openTextModal({
      title: 'Backup JSON Semua Gudang',
      desc: 'Salin dan simpan teks JSON berikut sebagai cadangan seluruh gudang Anda.',
      text: JSON.stringify(payload, null, 2),
      actionLabel: 'Salin JSON Backup',
      readonly: true
    });
  });

  byId('btn-restore-json').addEventListener('click', function () {
    openTextModal({
      title: 'Pulihkan Data dari JSON',
      desc: 'Tempel JSON cadangan format multi-gudang maupun format lama satu gudang di bawah ini, lalu klik Pulihkan Data.',
      text: '',
      actionLabel: 'Pulihkan Data',
      readonly: false,
      onAction: function () {
        var raw = byId('text-modal-area').value.trim();
        if (!raw) { showToast('Tempel JSON terlebih dahulu', 'warn'); return; }
        try {
          var obj = JSON.parse(raw);
          if (obj && obj.W && obj.warehouses && Array.isArray(obj.W.list) && obj.W.list.length > 0) {
            appState.W = obj.W;
            saveRegistry(true);
            appState.W.list.forEach(function (w) {
              if (obj.warehouses[w.id]) {
                writeWarehouseData(w.id, Object.assign(defaultWhData(), obj.warehouses[w.id]));
              }
            });
            closeTextModal();
            showToast('Cadangan multi-gudang berhasil dipulihkan', 'ok');
            renderApp();
          } else if (obj && (Array.isArray(obj.master) || Array.isArray(obj.masuk) || Array.isArray(obj.keluar) || Array.isArray(obj.opening))) {
            var merged = Object.assign(defaultWhData(), obj);
            writeWarehouseData(appState.W.cur, merged);
            closeTextModal();
            showToast('Cadangan satu gudang dipulihkan ke ' + getWhMeta(appState.W.cur).nama, 'ok');
            renderApp();
          } else {
            showToast('Format JSON tidak dikenali', 'err');
          }
        } catch (err) {
          showToast('JSON tidak valid: ' + (err.message || ''), 'err');
        }
      }
    });
  });

  var loadSampleBtn = byId('btn-load-sample');
  if (loadSampleBtn && canSeedDev) {
    loadSampleBtn.addEventListener('click', function () {
      confirmDialog(
        'Muat Data Contoh (Development)',
        '<p style="margin:0">Data gudang aktif (<strong>' + esc(getWhMeta(appState.W.cur).nama) + '</strong>) akan diganti dengan data contoh. Lanjutkan?</p>',
        function () {
          writeWarehouseData(appState.W.cur, buildSampleData());
          showToast('Data contoh berhasil dimuat', 'ok');
          renderApp();
        },
        false
      );
    });
  }

  byId('btn-reset-wh').addEventListener('click', function () {
    confirmDialog(
      'Reset Gudang Aktif',
      '<p style="margin:0">Seluruh data Master, Lokasi, Stok Awal, dan Transaksi di <strong>' + esc(getWhMeta(appState.W.cur).nama) + '</strong> akan dikosongkan. Tindakan ini tidak dapat dibatalkan.</p>',
      function () {
        writeWarehouseData(appState.W.cur, defaultWhData());
        showToast('Gudang aktif telah direset', 'ok');
        renderApp();
      },
      true
    );
  });
}
