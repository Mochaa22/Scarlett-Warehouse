import { buildCycleCountCSV, computeCycleSessionMetrics, downloadCSVFile, formatIndoDateUpper } from '../core/cycleCountEngine.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData, getWhMeta, saveRegistry, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { appState, renderApp } from '../state/store.ts';
import { closeTextModal, confirmDialog, openCopyTSV, openTextModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { addDaysISO, buildMasterLookups, esc, fmtNum, inferProductCategory, normBarcode, normLoc, normSku, parseDate, parseQty, resolveProductCategory, todayISO, uid } from '../utils/format.ts';
import { byId, qsa, targetEl } from '../utils/dom.ts';

// === HALAMAN 6B: CYCLE COUNT HARIAN & AKURASI ===
let cycleRole = 'admin'; // 'admin' | 'petugas'
let cycleAdminTab = 'pantau'; // 'pantau' | 'pilih' | 'akurasi'
let cycleSelectedSessionId = '';
let cyclePetugasFilter = 'all'; // 'all' | 'pending' | 'done' | 'mine'
let cycleAdminSearch = '';
let cyclePickerSearch = '';
let cyclePickerCat = '';
let cyclePickerFilter = 'all'; // 'all' | 'unscheduled'
let cycleAssignPetugas = 'Semua Petugas';
let cycleSelectedSkus = new Set();
let cycleScanAutoInc = false;

export function renderCycleCount(root, d, an) {
  var sessions = (d.cycleCounts || []).slice().sort(function (a, b) {
    return String(b.tgl || '').localeCompare(String(a.tgl || ''));
  });
  var today = todayISO();
  if (!cycleSelectedSessionId || !sessions.some(function (s) { return s.id === cycleSelectedSessionId; })) {
    var todayS = sessions.find(function (s) { return s.tgl === today; });
    cycleSelectedSessionId = todayS ? todayS.id : (sessions[0] ? sessions[0].id : '');
  }
  var activeSession = sessions.find(function (s) { return s.id === cycleSelectedSessionId; }) || null;
  var metrics = activeSession ? computeCycleSessionMetrics(activeSession, d.cycleCounts) : null;
  var overview = an.cycleOverview || { trend: [], byPetugas: [], topDiffSkus: [] };
  var whMeta = getWhMeta(appState.W.cur);
  var masterLookups = buildMasterLookups(d.master);

  var skuLocHintMap = Object.create(null);
  an.rows.forEach(function (r) {
    if (r.qty === 0) return;
    var s = normSku(r.sku);
    if (!skuLocHintMap[s]) skuLocHintMap[s] = [];
    skuLocHintMap[s].push(r.lok + ': ' + fmtNum(r.qty));
  });

  var catalogMap = Object.create(null);
  (d.master || []).forEach(function (m) {
    var s = normSku(m.sku);
    if (!s) return;
    if (!catalogMap[s]) {
      catalogMap[s] = {
        sku: s,
        barcode: normBarcode(m.barcode),
        nama: String(m.nama || '').trim(),
        kategori: inferProductCategory(m.nama, m.kategori),
        stokWms: an.skuMap[s] ? Number(an.skuMap[s].qty || 0) : 0
      };
    }
  });
  Object.keys(an.skuMap).forEach(function (s) {
    var item = an.skuMap[s];
    if (!catalogMap[s]) {
      catalogMap[s] = {
        sku: s,
        barcode: normBarcode(item.barcode),
        nama: String(item.nama || '').trim(),
        kategori: resolveProductCategory(s, item.barcode, item.nama, masterLookups),
        stokWms: Number(item.qty || 0)
      };
    } else {
      catalogMap[s].stokWms = Number(item.qty || 0);
      if (!catalogMap[s].nama && item.nama) catalogMap[s].nama = item.nama;
      if (!catalogMap[s].barcode && item.barcode) catalogMap[s].barcode = normBarcode(item.barcode);
    }
  });
  var catalogList = Object.keys(catalogMap).map(function (k) { return catalogMap[k]; }).sort(function (a, b) {
    return String(a.nama || a.sku).localeCompare(String(b.nama || b.sku));
  });

  function ensureSessionForDate(targetDate: string, opts?: any) {
    var dt = parseDate(targetDate) || todayISO();
    var dNow = curData();
    dNow.cycleCounts = Array.isArray(dNow.cycleCounts) ? dNow.cycleCounts : [];
    var existing = dNow.cycleCounts.find(function (s) { return s.tgl === dt; });
    if (existing) {
      cycleSelectedSessionId = existing.id;
      return existing;
    }
    var created = {
      id: 'cc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      tgl: dt,
      judul: (opts && opts.judul) || 'Cycle Count Harian',
      status: 'AKTIF',
      blindCount: false,
      createdBy: appState.W.user,
      createdAt: new Date().toISOString(),
      closedAt: '',
      items: []
    };
    dNow.cycleCounts.unshift(created);
    writeWarehouseData(appState.W.cur, dNow);
    cycleSelectedSessionId = created.id;
    return created;
  }

  var headerActions = '<div class="seg-group" role="tablist" aria-label="Peran Cycle Count">' +
    '<button type="button" class="seg-btn' + (cycleRole === 'admin' ? ' active' : '') + '" data-cc-role="admin">Admin (Pantau &amp; Pilih)</button>' +
    '<button type="button" class="seg-btn' + (cycleRole === 'petugas' ? ' active' : '') + '" data-cc-role="petugas">Petugas Lapangan (Hitung)</button>' +
    '</div>';

  var html = pageHeaderHtml(
    'Cycle Count Harian & Akurasi',
    'Admin menentukan produk target harian dan memantau akurasi stok, sementara petugas lapangan menghitung fisik via HP/scanner lalu unduh laporan CSV.',
    headerActions
  );

  html += '<div class="card"><div class="form-grid">' +
    '<div class="field"><label for="cc-session-sel">Sesi Tanggal Cycle Count</label><select id="cc-session-sel" class="input">' +
    (sessions.length
      ? sessions.map(function (s) {
          var sm = computeCycleSessionMetrics(s, d.cycleCounts);
          return '<option value="' + esc(s.id) + '"' + (s.id === (activeSession && activeSession.id) ? ' selected' : '') + '>' +
            esc(s.tgl) + ' · ' + (s.status === 'SELESAI' ? 'Selesai' : 'Aktif') + ' (' + sm.countedItems + '/' + sm.totalItems + ' SKU)</option>';
        }).join('')
      : '<option value="">(Belum ada sesi cycle count)</option>') +
    '</select></div>' +
    '<div class="field"><label for="cc-new-date">Buat / Buka Sesi Tanggal</label><div class="scan-row"><input id="cc-new-date" type="date" class="input" value="' + esc(today) + '" /><button type="button" class="btn btn-primary" id="cc-create-session-btn">Buka Sesi</button></div></div>' +
    '<div class="field"><label for="cc-user-inp">Nama User Aktif (' + (cycleRole === 'admin' ? 'Admin' : 'Petugas Hitung') + ')</label><div class="scan-row"><input id="cc-user-inp" type="text" class="input" value="' + esc(appState.W.user) + '" placeholder="Mis. Budi / Sari / Admin" /><button type="button" class="btn" id="cc-save-user-btn">Set</button></div></div>' +
    '</div></div>';

  function wireRoleAndSessionControls() {
    root.querySelectorAll('[data-cc-role]').forEach(function (b) {
      b.addEventListener('click', function () {
        cycleRole = b.getAttribute('data-cc-role');
        renderApp();
      });
    });
    var sessSel = byId('cc-session-sel');
    if (sessSel) {
      sessSel.addEventListener('change', function (e) {
        cycleSelectedSessionId = targetEl(e).value;
        renderApp();
      });
    }
    var createBtn = byId('cc-create-session-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var dt = parseDate(byId('cc-new-date').value);
        if (!dt) { showToast('Tanggal cycle count tidak valid', 'warn'); return; }
        ensureSessionForDate(dt);
        showToast('Sesi Cycle Count ' + dt + ' siap digunakan', 'ok');
        renderApp();
      });
    }
    var saveUserBtn = byId('cc-save-user-btn');
    if (saveUserBtn) {
      saveUserBtn.addEventListener('click', function () {
        var val = byId('cc-user-inp').value.trim();
        if (!val) { showToast('Nama petugas wajib diisi', 'warn'); return; }
        appState.W.user = val;
        saveRegistry();
        showToast('Petugas aktif diset ke: ' + val, 'ok');
        renderApp();
      });
    }
  }

  if (!activeSession) {
    html += '<div class="empty-state">' +
      '<h3>Belum Ada Jadwal Cycle Count</h3>' +
      '<p>Klik tombol di bawah untuk membuat sesi Cycle Count hari ini (' + esc(today) + '), lalu pilih produk yang perlu dihitung oleh petugas lapangan.</p>' +
      '<div class="empty-actions">' +
      '<button type="button" class="btn btn-primary" id="cc-empty-start">Buat Cycle Count Hari Ini</button>' +
      '</div></div>';
    root.innerHTML = html;
    wireRoleAndSessionControls();
    var emptyStartBtn = byId('cc-empty-start');
    if (emptyStartBtn) {
      emptyStartBtn.addEventListener('click', function () {
        ensureSessionForDate(today);
        cycleRole = 'admin';
        cycleAdminTab = 'pilih';
        showToast('Sesi Cycle Count hari ini dibuat. Pilih produk target.', 'ok');
        renderApp();
      });
    }
    return;
  }

  if (cycleRole === 'admin') {
    html += '<div class="toolbar" style="margin-bottom:16px">' +
      '<div class="seg-group" role="tablist">' +
      '<button type="button" class="seg-btn' + (cycleAdminTab === 'pantau' ? ' active' : '') + '" data-cc-atab="pantau">Pantau &amp; Laporan (' + metrics.countedItems + '/' + metrics.totalItems + ')</button>' +
      '<button type="button" class="seg-btn' + (cycleAdminTab === 'pilih' ? ' active' : '') + '" data-cc-atab="pilih">Tentukan Produk (' + catalogList.length + ')</button>' +
      '<button type="button" class="seg-btn' + (cycleAdminTab === 'akurasi' ? ' active' : '') + '" data-cc-atab="akurasi">Tren Akurasi (' + overview.trend.length + ' hari)</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-primary btn-sm" id="cc-dl-csv-btn">Download CSV</button>' +
      '<button type="button" class="btn btn-sm" id="cc-copy-csv-btn">Salin CSV</button>' +
      '<button type="button" class="btn btn-sm" id="cc-copy-tsv-btn">Salin TSV (Sheets)</button>' +
      '</div></div>';

    if (cycleAdminTab === 'pantau') {
      var accUnitStr = metrics.unitAccuracyPct !== null ? metrics.unitAccuracyPct.toFixed(1) + '%' : '-';
      var accSkuStr = metrics.skuAccuracyPct !== null ? metrics.skuAccuracyPct.toFixed(1) + '%' : '-';
      var unitKpiCls = metrics.unitAccuracyPct === null ? '' : (metrics.unitAccuracyPct >= 98 ? 'ok' : (metrics.unitAccuracyPct >= 90 ? 'warn' : 'err'));
      var skuKpiCls = metrics.skuAccuracyPct === null ? '' : (metrics.skuAccuracyPct >= 95 ? 'ok' : (metrics.skuAccuracyPct >= 80 ? 'warn' : 'err'));

      html += '<div class="kpi-grid">' +
        '<div class="kpi-card"><div class="kpi-top"><div class="kpi-label">Progres Hitung</div><div class="kpi-tag">' + (activeSession.status === 'SELESAI' ? 'Selesai' : 'Aktif') + '</div></div><div class="kpi-value num">' + fmtNum(metrics.countedItems) + ' / ' + fmtNum(metrics.totalItems) + '</div><div class="kpi-sub">' + metrics.progressPct.toFixed(0) + '% SKU selesai · Menunggu: ' + fmtNum(metrics.pendingItems) + '</div></div>' +
        '<div class="kpi-card ' + unitKpiCls + '"><div class="kpi-top"><div class="kpi-label">Akurasi Unit (PCS)</div><div class="kpi-tag">Fisik vs WMS</div></div><div class="kpi-value num">' + accUnitStr + '</div><div class="kpi-sub">Total selisih abs: ±' + fmtNum(metrics.absDiffTotal) + ' PCS</div></div>' +
        '<div class="kpi-card ' + skuKpiCls + '"><div class="kpi-top"><div class="kpi-label">Akurasi SKU Tepat</div><div class="kpi-tag">Match Rate</div></div><div class="kpi-value num">' + accSkuStr + '</div><div class="kpi-sub">' + fmtNum(metrics.matchedItems) + ' tepat · ' + fmtNum(metrics.diffItems) + ' selisih</div></div>' +
        '<div class="kpi-card ' + (metrics.todayDiffItems > 0 ? 'warn' : 'ok') + '"><div class="kpi-top"><div class="kpi-label">Selisih Hari Ini</div><div class="kpi-tag">Perubahan Harian</div></div><div class="kpi-value num">' + (metrics.netTodayDiff > 0 ? '+' : '') + fmtNum(metrics.netTodayDiff) + ' PCS</div><div class="kpi-sub">' + fmtNum(metrics.todayDiffItems) + ' SKU berubah selisih hari ini</div></div>' +
        '</div>';

      html += '<div class="card">' +
        '<div class="toolbar">' +
        '<div class="search-wrap"><input id="cc-admin-search" type="search" class="input" placeholder="Cari SKU, nama produk, petugas…" value="' + esc(cycleAdminSearch) + '" /><span class="search-kbd">/</span></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;cursor:pointer"><input id="cc-blind-chk" type="checkbox"' + (activeSession.blindCount ? ' checked' : '') + ' /> Mode Hitung Buta (Sembunyikan WMS ke Petugas)</label>' +
        '<button type="button" class="btn btn-sm" id="cc-sync-wms-btn">Refresh Stok WMS</button>' +
        '<button type="button" class="btn btn-sm" id="cc-goto-pick-btn">+ Tambah Produk</button>' +
        '<button type="button" class="btn btn-sm" id="cc-apply-opname-btn">Terapkan Opname Selisih</button>' +
        '<button type="button" class="btn btn-sm ' + (activeSession.status === 'SELESAI' ? '' : 'btn-primary') + '" id="cc-toggle-status-btn">' + (activeSession.status === 'SELESAI' ? 'Buka Kembali Sesi' : 'Tutup / Selesaikan Sesi') + '</button>' +
        '<button type="button" class="btn btn-danger btn-sm" id="cc-delete-session-btn">Hapus Sesi</button>' +
        '</div></div>';

      var aq = cycleAdminSearch.trim().toUpperCase();
      var filteredAdminRows = metrics.rows.filter(function (r) {
        if (!aq) return true;
        return [r.sku, r.barcode, r.nama, r.assignedTo, r.countedBy, r.catatan].join(' ').toUpperCase().indexOf(aq) >= 0;
      });

      html += '<div class="muted" style="font-size:12.5px;margin-bottom:10px">' +
        'Pratinjau Laporan: <strong>STOK AKHIR ' + esc(whMeta.nama.toUpperCase()) + ' ' + esc(formatIndoDateUpper(activeSession.tgl)) + '</strong> · Kolom kuning menandakan <strong>Selisih Hari Ini ≠ 0</strong>.' +
        '</div>';

      html += '<div class="table-wrap"><table><thead><tr>' +
        '<th>SKU</th><th>Nama Produk</th><th>Petugas</th><th class="right">Stok WMS</th><th class="right">Stok Fisik</th><th class="right">Selisih Hari Ini</th><th class="right">Selisih Sebelumnya</th><th>Status</th><th class="right">Aksi</th>' +
        '</tr></thead><tbody>';

      if (filteredAdminRows.length === 0) {
        html += '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">' +
          (metrics.totalItems === 0 ? 'Belum ada produk di jadwal ini. Klik "+ Tambah Produk" untuk menentukan produk yang mau di-cycle count.' : 'Tidak ada baris yang cocok dengan pencarian.') +
          '</td></tr>';
      } else {
        filteredAdminRows.forEach(function (r) {
          var hasDiffToday = r.counted && r.selisihHariIni !== 0;
          var isNewSku = r.selisihSebelumnya === null;
          var statusBadge = !r.counted
            ? '<span class="badge badge-neutral">Menunggu</span>'
            : (r.selisihTotal === 0
              ? '<span class="badge badge-ok">Sesuai</span>'
              : '<span class="badge badge-warn">Selisih ' + (r.selisihTotal > 0 ? '+' : '') + fmtNum(r.selisihTotal) + '</span>');
          var whoLabel = r.countedBy ? (r.countedBy + (r.countedAt ? ' · ' + r.countedAt : '')) : (r.assignedTo || 'Semua Petugas');
          html += '<tr class="' + (isNewSku ? 'cc-row-new' : '') + '">' +
            '<td class="mono">' + esc(r.sku) + '</td>' +
            '<td><div><strong>' + esc(r.nama || '-') + '</strong></div>' + (r.catatan ? '<div class="muted" style="font-size:11.5px">' + esc(r.catatan) + '</div>' : '') + '</td>' +
            '<td>' + esc(whoLabel) + '</td>' +
            '<td class="right num">' + fmtNum(r.stokWms) + '</td>' +
            '<td class="right num">' + (r.counted ? '<strong>' + fmtNum(r.stokFisik) + '</strong>' : '<span class="muted">-</span>') + '</td>' +
            '<td class="right num ' + (hasDiffToday ? 'cc-diff-cell' : '') + '">' + (r.counted ? fmtNum(r.selisihHariIni) : '<span class="muted">-</span>') + '</td>' +
            '<td class="right num">' + (r.selisihSebelumnya !== null ? fmtNum(r.selisihSebelumnya) : '<span class="muted">-</span>') + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td class="right" style="white-space:nowrap">' +
            '<button type="button" class="btn btn-sm" data-cc-edit="' + esc(r.id) + '">Edit</button> ' +
            '<button type="button" class="btn btn-danger btn-sm" data-cc-del="' + esc(r.id) + '">Hapus</button>' +
            '</td></tr>';
        });
      }
      html += '</tbody></table></div></div>';
    } else if (cycleAdminTab === 'pilih') {
      var scheduledSet = new Set((activeSession.items || []).map(function (it) { return normSku(it.sku); }));
      var pickCats = Array.from(new Set(catalogList.map(function (c) { return c.kategori; }))).sort();
      var pq = cyclePickerSearch.trim().toUpperCase();
      var filteredCatalog = catalogList.filter(function (c) {
        if (cyclePickerFilter === 'unscheduled' && scheduledSet.has(c.sku)) return false;
        if (cyclePickerCat && c.kategori !== cyclePickerCat) return false;
        if (!pq) return true;
        return [c.sku, c.barcode, c.nama, c.kategori].join(' ').toUpperCase().indexOf(pq) >= 0;
      });

      html += '<div class="card"><div class="card-header"><h2 class="card-title">Pilih Produk Cycle Count (' + esc(activeSession.tgl) + ')</h2><span class="badge badge-info">' + scheduledSet.size + ' SKU sudah terjadwal</span></div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">' +
        '<button type="button" class="btn btn-sm" data-cc-preset="topmover">Preset: Top Mover 30Hr</button>' +
        '<button type="button" class="btn btn-sm" data-cc-preset="low">Preset: Stok Menipis (≤' + fmtNum(d.min) + ')</button>' +
        '<button type="button" class="btn btn-sm" data-cc-preset="prevdiff">Preset: Selisih Sebelumnya</button>' +
        '<button type="button" class="btn btn-sm" data-cc-preset="expire">Preset: Expire &lt; ' + fmtNum(d.expMonths || 7) + ' Bln</button>' +
        '<button type="button" class="btn btn-sm" data-cc-preset="random10">Preset: Acak 10 SKU</button>' +
        '<button type="button" class="btn btn-sm" data-cc-preset="all">Pilih Semua Aktif</button>' +
        '<button type="button" class="btn btn-sm" id="cc-paste-skus-btn">Tempel Daftar SKU</button>' +
        '</div>' +
        '<div class="toolbar">' +
        '<div class="search-wrap"><input id="cc-pick-search" type="search" class="input" placeholder="Cari SKU, barcode, nama produk…" value="' + esc(cyclePickerSearch) + '" /><span class="search-kbd">/</span></div>' +
        '<select id="cc-pick-cat" class="input filter-select"><option value="">Semua Kategori</option>' +
        pickCats.map(function (cat) { return '<option value="' + esc(cat) + '"' + (cyclePickerCat === cat ? ' selected' : '') + '>' + esc(cat) + '</option>'; }).join('') +
        '</select>' +
        '<div class="seg-group">' +
        '<button type="button" class="seg-btn' + (cyclePickerFilter === 'all' ? ' active' : '') + '" data-cc-pfilt="all">Semua</button>' +
        '<button type="button" class="seg-btn' + (cyclePickerFilter === 'unscheduled' ? ' active' : '') + '" data-cc-pfilt="unscheduled">Belum Terjadwal</button>' +
        '</div>' +
        '</div>' +
        '<div class="form-grid" style="margin-bottom:14px">' +
        '<div class="field"><label for="cc-assign-petugas">Tugaskan ke Petugas Lapangan</label><input id="cc-assign-petugas" type="text" class="input" value="' + esc(cycleAssignPetugas) + '" placeholder="Mis. Budi / Sari / Semua Petugas" /></div>' +
        '<div class="field"><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" class="btn btn-sm" id="cc-pick-select-all">Centang Semua Terlihat</button>' +
        '<button type="button" class="btn btn-sm" id="cc-pick-clear">Bersihkan Centang</button>' +
        '<button type="button" class="btn btn-primary" id="cc-add-selected-btn">Tambahkan Terpilih (' + cycleSelectedSkus.size + ')</button>' +
        '</div></div></div>';

      html += '<div class="table-wrap" style="max-height:420px"><table><thead><tr>' +
        '<th style="width:42px"><input type="checkbox" id="cc-pick-head-chk" aria-label="Pilih semua" /></th>' +
        '<th>SKU</th><th>Barcode</th><th>Nama Produk</th><th>Kategori</th><th class="right">Stok WMS</th><th>Status Jadwal</th>' +
        '</tr></thead><tbody>';

      if (filteredCatalog.length === 0) {
        html += '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Tidak ada produk yang sesuai filter (pastikan Master Barang atau Stok sudah terisi).</td></tr>';
      } else {
        filteredCatalog.forEach(function (c) {
          var isSched = scheduledSet.has(c.sku);
          var isChk = cycleSelectedSkus.has(c.sku);
          html += '<tr>' +
            '<td><input type="checkbox" class="cc-pick-chk" data-sku="' + esc(c.sku) + '"' + (isChk ? ' checked' : '') + ' /></td>' +
            '<td class="mono">' + esc(c.sku) + '</td>' +
            '<td class="mono">' + esc(c.barcode || '-') + '</td>' +
            '<td>' + esc(c.nama || '-') + '</td>' +
            '<td>' + esc(c.kategori) + '</td>' +
            '<td class="right num">' + fmtNum(c.stokWms) + '</td>' +
            '<td>' + (isSched ? '<span class="badge badge-ok">Sudah di Jadwal</span>' : '<span class="badge badge-neutral">Belum</span>') + '</td>' +
            '</tr>';
        });
      }
      html += '</tbody></table></div></div>';
    } else {
      var trend = overview.trend.slice(-14);
      html += '<div class="card"><div class="card-header"><h2 class="card-title">Grafik Tren Akurasi Cycle Count</h2>' +
        '<div style="display:flex;gap:12px;font-size:12px"><span style="color:#16a34a;font-weight:600">● Akurasi Unit (%)</span><span style="color:#b5154f;font-weight:600">● Akurasi SKU Tepat (%)</span></div></div>';
      if (trend.length === 0) {
        html += '<p class="muted" style="margin:0">Belum ada data hitung fisik untuk menampilkan grafik tren akurasi.</p>';
      } else {
        var sw = 760, sh = 220, pL = 44, pR = 24, pT = 18, pB = 36;
        var pw = sw - pL - pR, ph = sh - pT - pB;
        var svgChart = '<svg viewBox="0 0 ' + sw + ' ' + sh + '" style="width:100%;min-width:520px;height:auto;display:block" role="img" aria-label="Tren Akurasi Cycle Count">';
        [0, 25, 50, 75, 100].forEach(function (val) {
          var y = pT + ph - (val / 100) * ph;
          svgChart += '<line x1="' + pL + '" y1="' + y + '" x2="' + (sw - pR) + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="3 3"/>';
          svgChart += '<text x="' + (pL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10.5" fill="var(--text-subtle)">' + val + '%</text>';
        });
        var unitPts = [], skuPts = [];
        trend.forEach(function (t, i) {
          var x = trend.length === 1 ? (pL + pw / 2) : (pL + (i / (trend.length - 1)) * pw);
          var uVal = t.unitAccuracyPct !== null ? t.unitAccuracyPct : null;
          var sVal = t.skuAccuracyPct !== null ? t.skuAccuracyPct : null;
          if (uVal !== null) unitPts.push({ x: x, y: pT + ph - (uVal / 100) * ph, v: uVal, tgl: t.tgl });
          if (sVal !== null) skuPts.push({ x: x, y: pT + ph - (sVal / 100) * ph, v: sVal, tgl: t.tgl });
          svgChart += '<text x="' + x + '" y="' + (sh - 12) + '" text-anchor="middle" font-size="10" fill="var(--text-subtle)">' + esc(t.tgl.slice(5)) + '</text>';
        });
        if (skuPts.length > 1) {
          svgChart += '<polyline fill="none" stroke="#b5154f" stroke-width="2.2" points="' + skuPts.map(function (p) { return p.x + ',' + p.y; }).join(' ') + '"/>';
        }
        if (unitPts.length > 1) {
          svgChart += '<polyline fill="none" stroke="#16a34a" stroke-width="2.5" points="' + unitPts.map(function (p) { return p.x + ',' + p.y; }).join(' ') + '"/>';
        }
        skuPts.forEach(function (p) {
          svgChart += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#b5154f"><title>' + esc(p.tgl) + ' Akurasi SKU: ' + p.v.toFixed(1) + '%</title></circle>';
        });
        unitPts.forEach(function (p) {
          svgChart += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4.5" fill="#16a34a"><title>' + esc(p.tgl) + ' Akurasi Unit: ' + p.v.toFixed(1) + '%</title></circle>';
        });
        svgChart += '</svg>';
        html += '<div class="chart-box">' + svgChart + '</div>';
      }
      html += '</div>';

      html += '<div class="grid-2">' +
        '<div class="card"><div class="card-header"><h2 class="card-title">Akurasi per Petugas Lapangan</h2></div>' +
        (overview.byPetugas.length === 0
          ? '<p class="muted" style="margin:0">Belum ada hitungan dari petugas lapangan.</p>'
          : '<div class="table-wrap"><table><thead><tr><th>Petugas</th><th class="right">Dihitung</th><th class="right">SKU Tepat</th><th class="right">Akurasi Unit</th></tr></thead><tbody>' +
            overview.byPetugas.map(function (p) {
              return '<tr><td><strong>' + esc(p.petugas) + '</strong></td><td class="right num">' + fmtNum(p.counted) + '</td><td class="right num">' + fmtNum(p.matched) + ' (' + p.skuAccuracyPct.toFixed(1) + '%)</td><td class="right num"><span class="badge ' + (p.unitAccuracyPct >= 98 ? 'badge-ok' : 'badge-warn') + '">' + p.unitAccuracyPct.toFixed(1) + '%</span></td></tr>';
            }).join('') +
            '</tbody></table></div>') +
        '</div>' +

        '<div class="card"><div class="card-header"><h2 class="card-title">SKU Paling Sering Selisih</h2></div>' +
        (overview.topDiffSkus.length === 0
          ? '<p class="muted" style="margin:0">Belum ada SKU dengan selisih.</p>'
          : '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nama Produk</th><th class="right">Sesi Selisih</th><th class="right">Selisih Terakhir</th></tr></thead><tbody>' +
            overview.topDiffSkus.slice(0, 15).map(function (sd) {
              return '<tr><td class="mono">' + esc(sd.sku) + '</td><td>' + esc(sd.nama || '-') + '</td><td class="right num">' + fmtNum(sd.diffSessions) + ' / ' + fmtNum(sd.sessions) + '</td><td class="right num">' + (sd.lastDiff > 0 ? '+' : '') + fmtNum(sd.lastDiff) + '</td></tr>';
            }).join('') +
            '</tbody></table></div>') +
        '</div></div>';

      html += '<div class="card"><div class="card-header"><h2 class="card-title">Riwayat Sesi Cycle Count Harian</h2></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Status</th><th class="right">SKU Dihitung</th><th class="right">Akurasi SKU</th><th class="right">Akurasi Unit</th><th class="right">Net Selisih Hari Ini</th><th class="right">Aksi</th></tr></thead><tbody>' +
        overview.trend.slice().reverse().map(function (t) {
          return '<tr><td class="num"><strong>' + esc(t.tgl) + '</strong></td>' +
            '<td><span class="badge ' + (t.status === 'SELESAI' ? 'badge-ok' : 'badge-info') + '">' + esc(t.status) + '</span></td>' +
            '<td class="right num">' + fmtNum(t.countedItems) + ' / ' + fmtNum(t.totalItems) + '</td>' +
            '<td class="right num">' + (t.skuAccuracyPct !== null ? t.skuAccuracyPct.toFixed(1) + '%' : '-') + '</td>' +
            '<td class="right num">' + (t.unitAccuracyPct !== null ? t.unitAccuracyPct.toFixed(1) + '%' : '-') + '</td>' +
            '<td class="right num">' + (t.netTodayDiff > 0 ? '+' : '') + fmtNum(t.netTodayDiff) + '</td>' +
            '<td class="right" style="white-space:nowrap"><button type="button" class="btn btn-sm" data-cc-open-sess="' + esc(t.id) + '">Buka</button> <button type="button" class="btn btn-sm" data-cc-dl-sess="' + esc(t.id) + '">CSV</button></td></tr>';
        }).join('') +
        '</tbody></table></div></div>';
    }
  } else {
    var isBlind = !!activeSession.blindCount;
    var isClosed = activeSession.status === 'SELESAI';

    html += '<div class="card">' +
      '<div class="toolbar">' +
      '<div class="seg-group" role="tablist">' +
      '<button type="button" class="seg-btn' + (cyclePetugasFilter === 'all' ? ' active' : '') + '" data-cc-pfilter="all">Semua (' + metrics.totalItems + ')</button>' +
      '<button type="button" class="seg-btn' + (cyclePetugasFilter === 'pending' ? ' active' : '') + '" data-cc-pfilter="pending">Belum Dihitung (' + metrics.pendingItems + ')</button>' +
      '<button type="button" class="seg-btn' + (cyclePetugasFilter === 'done' ? ' active' : '') + '" data-cc-pfilter="done">Sudah Dihitung (' + metrics.countedItems + ')</button>' +
      '<button type="button" class="seg-btn' + (cyclePetugasFilter === 'mine' ? ' active' : '') + '" data-cc-pfilter="mine">Tugas Saya</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-sm" id="cc-petugas-csv-btn">Download CSV</button>' +
      '</div></div>' +
      '<div class="scanner-bar" style="margin-bottom:0">' +
      '<div class="scan-row"><input id="cc-scan-inp" type="text" class="input mono" placeholder="Scan barcode / ketik SKU untuk langsung hitung…" autocapitalize="characters" enterkeyhint="search" autocomplete="off" /><button type="button" class="btn btn-primary" id="cc-cam-btn">Kamera HP</button></div>' +
      '<label><input id="cc-scan-inc" type="checkbox"' + (cycleScanAutoInc ? ' checked' : '') + ' /> Tambah +1 fisik otomatis saat scan</label>' +
      '</div>' +
      (isClosed ? '<div class="inline-alert warn">Sesi tanggal ' + esc(activeSession.tgl) + ' sudah ditutup Admin. Minta Admin membuka kembali sesi jika masih ada perubahan hitungan.</div>' : '') +
      '</div>';

    var userUpper = String(appState.W.user || '').trim().toUpperCase();
    var fieldItems = metrics.rows.filter(function (r) {
      if (cyclePetugasFilter === 'pending' && r.counted) return false;
      if (cyclePetugasFilter === 'done' && !r.counted) return false;
      if (cyclePetugasFilter === 'mine') {
        var ass = String(r.assignedTo || '').trim().toUpperCase();
        var cby = String(r.countedBy || '').trim().toUpperCase();
        if (ass && ass !== 'SEMUA PETUGAS' && ass !== userUpper && cby !== userUpper) return false;
      }
      return true;
    });

    if (fieldItems.length === 0) {
      html += '<div class="empty-state"><h3>' +
        (metrics.totalItems === 0 ? 'Belum Ada Produk yang Ditugaskan' : 'Semua Tugas di Filter Ini Sudah Selesai') +
        '</h3><p>' +
        (metrics.totalItems === 0 ? 'Minta Admin menentukan produk target pada tab Admin → Tentukan Produk.' : 'Ganti filter ke "Semua" untuk melihat seluruh daftar produk hari ini.') +
        '</p></div>';
    } else {
      html += '<div class="cc-field-grid">';
      fieldItems.forEach(function (r) {
        var locHints = skuLocHintMap[normSku(r.sku)] || [];
        var cardCls = r.counted ? (r.selisihTotal === 0 || isBlind ? ' done' : ' diff') : '';
        var valStr = r.counted ? String(r.stokFisik) : '';
        html += '<div class="cc-count-card' + cardCls + '" id="cc-card-' + esc(r.id) + '" data-cc-card-sku="' + esc(r.sku) + '" data-cc-card-bc="' + esc(r.barcode || '') + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
          '<div><div class="mono muted" style="font-size:12px">SKU ' + esc(r.sku) + (r.barcode ? ' · ' + esc(r.barcode) : '') + '</div>' +
          '<div style="font-size:15px;font-weight:700;margin-top:2px">' + esc(r.nama || '-') + '</div></div>' +
          (r.counted
            ? (isBlind ? '<span class="badge badge-ok">Terhitung</span>' : (r.selisihTotal === 0 ? '<span class="badge badge-ok">Sesuai</span>' : '<span class="badge badge-warn">Selisih ' + (r.selisihTotal > 0 ? '+' : '') + fmtNum(r.selisihTotal) + '</span>'))
            : '<span class="badge badge-neutral">Menunggu</span>') +
          '</div>' +
          '<div class="muted" style="font-size:12px">' +
          'Ditugaskan: <strong>' + esc(r.assignedTo || 'Semua Petugas') + '</strong>' +
          (!isBlind ? ' · Stok WMS: <strong class="num">' + fmtNum(r.stokWms) + ' PCS</strong>' : ' · Mode Hitung Buta') +
          (locHints.length ? '<div style="margin-top:2px">Lokasi Rak: ' + esc(locHints.join(' · ')) + '</div>' : '') +
          '</div>' +
          '<div class="cc-stepper">' +
          '<button type="button" class="cc-step-btn" data-cc-step="-1" data-id="' + esc(r.id) + '"' + (isClosed ? ' disabled' : '') + '>−1</button>' +
          '<input type="text" inputmode="decimal" class="input num cc-fisik-inp" data-id="' + esc(r.id) + '" value="' + esc(valStr) + '" placeholder="Qty fisik…"' + (isClosed ? ' readonly' : '') + ' style="text-align:center;font-weight:700" />' +
          '<button type="button" class="cc-step-btn" data-cc-step="1" data-id="' + esc(r.id) + '"' + (isClosed ? ' disabled' : '') + '>+1</button>' +
          '</div>' +
          '<input type="text" class="input cc-note-inp" data-id="' + esc(r.id) + '" value="' + esc(r.catatan || '') + '" placeholder="Catatan temuan lapangan (opsional)…"' + (isClosed ? ' readonly' : '') + ' />' +
          '<div class="cc-card-foot">' +
          (!isBlind && !isClosed ? '<button type="button" class="btn btn-sm" data-cc-match="' + esc(r.id) + '" data-wms="' + esc(r.stokWms) + '">Sesuai WMS (' + fmtNum(r.stokWms) + ')</button>' : '<span class="muted" style="font-size:12px">' + (r.countedBy ? ('Oleh ' + esc(r.countedBy) + (r.countedAt ? ' · ' + esc(r.countedAt) : '')) : '') + '</span>') +
          '<button type="button" class="btn btn-primary btn-sm" data-cc-save="' + esc(r.id) + '"' + (isClosed ? ' disabled' : '') + '>Simpan Hitungan</button>' +
          '</div>' +
          '</div>';
      });
      html += '</div>';
    }
  }

  root.innerHTML = html;
  wireRoleAndSessionControls();

  function triggerDownloadCsvForSession(sess) {
    if (!sess) return;
    var dNow = curData();
    var fallbackLocal = function () {
      var csv = buildCycleCountCSV(sess, dNow.cycleCounts, whMeta.nama);
      var ok = downloadCSVFile('cycle-count-' + sess.tgl + '.csv', csv);
      if (ok) {
        showToast('File CSV diunduh: cycle-count-' + sess.tgl + '.csv', 'ok');
      } else {
        openTextModal({
          title: 'Salin Laporan CSV Cycle Count (' + sess.tgl + ')',
          desc: 'Browser membatasi unduhan langsung. Salin CSV di bawah ini untuk disimpan sebagai .csv.',
          text: csv,
          actionLabel: 'Salin CSV',
          readonly: true
        });
      }
    };
    if (window.__sgpCloud && window.__sgpCloud.api && window.__sgpCloud.api.downloadCycleCountCsv) {
      var metricsNow = computeCycleSessionMetrics(sess, dNow.cycleCounts);
      var enrichedLines = metricsNow.rows.map(function (ln) {
        return {
          sku: ln.sku,
          nama: ln.nama,
          sysQty: ln.stokWms,
          stokWms: ln.stokWms,
          physQty: ln.stokFisik,
          stokFisik: ln.stokFisik,
          prevDiff: ln.selisihSebelumnya,
          selisihSebelumnya: ln.selisihSebelumnya
        };
      });
      window.__sgpCloud.api.downloadCycleCountCsv(enrichedLines, sess.tgl, whMeta.nama, appState.appAuthToken || null)
        .then(function (csvText) {
          var cleanCsv = String(csvText || '').replace(/^\uFEFF/, '');
          var ok = downloadCSVFile('cycle-count-' + sess.tgl + '.csv', cleanCsv);
          if (ok) showToast('File CSV diunduh dari server: cycle-count-' + sess.tgl + '.csv', 'ok');
          else fallbackLocal();
        })
        .catch(fallbackLocal);
      return;
    }
    fallbackLocal();
  }

  function addSkusToSession(skuArray, assignPetugas) {
    if (!skuArray || skuArray.length === 0) {
      showToast('Tidak ada produk yang dipilih', 'warn');
      return;
    }
    var dNow = curData();
    var sIdx = (dNow.cycleCounts || []).findIndex(function (s) { return s.id === activeSession.id; });
    if (sIdx < 0) return;
    var sess = dNow.cycleCounts[sIdx];
    var existingSkus = new Set((sess.items || []).map(function (it) { return normSku(it.sku); }));
    var added = 0;
    skuArray.forEach(function (sku) {
      var ns = normSku(sku);
      if (!ns || existingSkus.has(ns)) return;
      var catItem = catalogMap[ns];
      var masterItem = catItem || findMasterBySku(dNow.master, ns);
      sess.items.push({
        id: uid(),
        sku: ns,
        barcode: masterItem ? normBarcode(masterItem.barcode) : '',
        nama: masterItem ? String(masterItem.nama || '').trim() : '',
        kategori: masterItem ? (masterItem.kategori || inferProductCategory(masterItem.nama)) : 'Lainnya',
        assignedTo: assignPetugas || 'Semua Petugas',
        stokWms: an.skuMap[ns] ? Number(an.skuMap[ns].qty || 0) : 0,
        stokFisik: null,
        selisihSebelumnya: null,
        status: 'MENUNGGU',
        countedBy: '',
        countedAt: '',
        catatan: ''
      });
      existingSkus.add(ns);
      added += 1;
    });
    writeWarehouseData(appState.W.cur, dNow);
    cycleSelectedSkus.clear();
    if (added > 0) showToast(added + ' SKU ditambahkan ke jadwal Cycle Count ' + sess.tgl, 'ok');
    else showToast('Semua SKU tersebut sudah ada di jadwal sesi ini', 'warn');
    renderApp();
  }

  if (cycleRole === 'admin') {
    root.querySelectorAll('[data-cc-atab]').forEach(function (b) {
      b.addEventListener('click', function () {
        cycleAdminTab = b.getAttribute('data-cc-atab');
        renderApp();
      });
    });

    byId('cc-dl-csv-btn').addEventListener('click', function () {
      triggerDownloadCsvForSession(activeSession);
    });
    byId('cc-copy-csv-btn').addEventListener('click', function () {
      var csv = buildCycleCountCSV(activeSession, d.cycleCounts, whMeta.nama);
      openTextModal({
        title: 'Salin CSV Cycle Count (' + activeSession.tgl + ')',
        desc: 'Format CSV persis laporan spreadsheet (' + metrics.rows.length + ' baris produk).',
        text: csv,
        actionLabel: 'Salin CSV',
        readonly: true
      });
    });
    byId('cc-copy-tsv-btn').addEventListener('click', function () {
      openCopyTSV(
        'Salin Laporan Cycle Count (' + activeSession.tgl + ')',
        ['SKU', 'NAMA PRODUK', 'STOK WMS', 'STOK FISIK', 'SELISIH HARI INI', 'SELISIH SEBELUMNYA'],
        metrics.rows.map(function (r) {
          return [
            r.sku,
            r.nama || '',
            r.stokWms,
            r.counted ? r.stokFisik : '',
            r.counted ? r.selisihHariIni : '',
            r.selisihSebelumnya !== null ? r.selisihSebelumnya : ''
          ];
        })
      );
    });

    if (cycleAdminTab === 'pantau') {
      byId('cc-admin-search').addEventListener('input', function (e) {
        cycleAdminSearch = targetEl(e).value;
        renderApp();
        var el = byId('cc-admin-search');
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });

      byId('cc-blind-chk').addEventListener('change', function (e) {
        var dNow = curData();
        var idx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
        if (idx >= 0) {
          dNow.cycleCounts[idx].blindCount = !!targetEl(e).checked;
          writeWarehouseData(appState.W.cur, dNow);
          showToast(targetEl(e).checked ? 'Mode Hitung Buta diaktifkan untuk petugas' : 'Stok WMS ditampilkan ke petugas', 'ok');
        }
      });

      byId('cc-sync-wms-btn').addEventListener('click', function () {
        var dNow = curData();
        var anNow = computeWarehouseAnalysis(dNow);
        var idx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
        if (idx < 0) return;
        var updated = 0;
        dNow.cycleCounts[idx].items.forEach(function (it) {
          var ns = normSku(it.sku);
          var liveQty = anNow.skuMap[ns] ? Number(anNow.skuMap[ns].qty || 0) : 0;
          if (it.stokWms !== liveQty) {
            it.stokWms = liveQty;
            updated += 1;
          }
        });
        writeWarehouseData(appState.W.cur, dNow);
        showToast('Stok WMS disegarkan (' + updated + ' SKU diperbarui)', 'ok');
        renderApp();
      });

      byId('cc-goto-pick-btn').addEventListener('click', function () {
        cycleAdminTab = 'pilih';
        renderApp();
      });

      byId('cc-toggle-status-btn').addEventListener('click', function () {
        var dNow = curData();
        var idx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
        if (idx < 0) return;
        var nextSt = dNow.cycleCounts[idx].status === 'SELESAI' ? 'AKTIF' : 'SELESAI';
        dNow.cycleCounts[idx].status = nextSt;
        dNow.cycleCounts[idx].closedAt = nextSt === 'SELESAI' ? new Date().toISOString() : '';
        writeWarehouseData(appState.W.cur, dNow);
        showToast('Status sesi diubah menjadi ' + nextSt, 'ok');
        renderApp();
      });

      byId('cc-apply-opname-btn').addEventListener('click', function () {
        var diffItems = metrics.rows.filter(function (r) { return r.counted && r.selisihTotal !== 0; });
        if (diffItems.length === 0) {
          showToast('Tidak ada item terhitung dengan selisih untuk disesuaikan', 'warn');
          return;
        }
        var defaultLoc = (d.lokasi && d.lokasi[0]) ? normLoc(d.lokasi[0]) : 'STAGING';
        confirmDialog(
          'Terapkan Penyesuaian Opname Cycle Count',
          '<p style="margin:0">Akan dibuat <strong>' + diffItems.length + '</strong> transaksi penyesuaian bertanda <strong>OPNAME CYCLE COUNT</strong> pada tanggal ' + esc(activeSession.tgl) + ' untuk menyamakan Stok WMS dengan Stok Fisik. Lanjutkan?</p>',
          function () {
            var dNow = curData();
            var anNow = computeWarehouseAnalysis(dNow);
            var countAdj = 0;
            diffItems.forEach(function (it) {
              var ns = normSku(it.sku);
              var liveQty = anNow.skuMap[ns] ? Number(anNow.skuMap[ns].qty || 0) : 0;
              var adj = Number(it.stokFisik) - liveQty;
              if (adj === 0) return;
              var firstLocRow = anNow.rows.find(function (r) { return normSku(r.sku) === ns && r.qty !== 0; }) ||
                anNow.rows.find(function (r) { return normSku(r.sku) === ns; });
              var lokTarget = firstLocRow ? firstLocRow.lok : defaultLoc;
              if (adj > 0) {
                dNow.masuk.push({
                  id: uid(), tgl: activeSession.tgl, barcode: it.barcode || '', sku: ns, nama: it.nama || '',
                  lok: lokTarget, qty: adj, ket: 'OPNAME CYCLE COUNT', by: appState.W.user, n: 1
                });
              } else {
                dNow.keluar.push({
                  id: uid(), tgl: activeSession.tgl, barcode: it.barcode || '', sku: ns, nama: it.nama || '',
                  lok: lokTarget, qty: Math.abs(adj), ket: 'OPNAME CYCLE COUNT', by: appState.W.user, n: 1
                });
              }
              countAdj += 1;
            });
            writeWarehouseData(appState.W.cur, dNow);
            if (countAdj > 0) showToast(countAdj + ' penyesuaian opname WMS diterapkan', 'ok');
            else showToast('Stok WMS saat ini sudah sama dengan stok fisik', 'ok');
            renderApp();
          },
          false
        );
      });

      byId('cc-delete-session-btn').addEventListener('click', function () {
        confirmDialog(
          'Hapus Sesi Cycle Count',
          '<p style="margin:0">Yakin ingin menghapus seluruh jadwal &amp; hasil hitung sesi <strong>' + esc(activeSession.tgl) + '</strong>?</p>',
          function () {
            var dNow = curData();
            dNow.cycleCounts = (dNow.cycleCounts || []).filter(function (s) { return s.id !== activeSession.id; });
            writeWarehouseData(appState.W.cur, dNow);
            cycleSelectedSessionId = '';
            showToast('Sesi cycle count dihapus', 'ok');
            renderApp();
          },
          true
        );
      });

      root.querySelectorAll('[data-cc-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          var itemId = b.getAttribute('data-cc-del');
          var dNow = curData();
          var idx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
          if (idx >= 0) {
            dNow.cycleCounts[idx].items = dNow.cycleCounts[idx].items.filter(function (it) { return it.id !== itemId; });
            writeWarehouseData(appState.W.cur, dNow);
            showToast('Produk dihapus dari jadwal sesi ini', 'ok');
            renderApp();
          }
        });
      });

      root.querySelectorAll('[data-cc-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          var itemId = b.getAttribute('data-cc-edit');
          var rowObj = metrics.rows.find(function (r) { return r.id === itemId; });
          if (!rowObj) return;
          openTextModal({
            title: 'Edit Hasil Hitung SKU ' + rowObj.sku,
            desc: 'Ubah nilai baris format: StokFisik | Petugas | Catatan (pisahkan dengan tanda |).',
            text: (rowObj.counted ? rowObj.stokFisik : '') + ' | ' + (rowObj.countedBy || rowObj.assignedTo || appState.W.user) + ' | ' + (rowObj.catatan || ''),
            actionLabel: 'Simpan Perubahan',
            readonly: false,
            onAction: function () {
              var raw = byId('text-modal-area').value;
              var parts = raw.split('|');
              var fisRaw = String(parts[0] || '').trim();
              var petugasNew = String(parts[1] || '').trim();
              var catNew = parts.slice(2).join('|').trim();
              var dNow = curData();
              var sIdx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
              if (sIdx < 0) return;
              var item = dNow.cycleCounts[sIdx].items.find(function (it) { return it.id === itemId; });
              if (!item) return;
              if (fisRaw === '') {
                item.stokFisik = null;
                item.status = 'MENUNGGU';
              } else {
                item.stokFisik = parseQty(fisRaw);
                item.status = 'TERVERIFIKASI';
                item.countedBy = petugasNew || appState.W.user;
                item.countedAt = new Date().toTimeString().slice(0, 5);
              }
              if (petugasNew) item.assignedTo = petugasNew;
              item.catatan = catNew;
              writeWarehouseData(appState.W.cur, dNow);
              closeTextModal();
              showToast('Data cycle count SKU ' + item.sku + ' diperbarui', 'ok');
              renderApp();
            }
          });
        });
      });
    } else if (cycleAdminTab === 'pilih') {
      byId('cc-pick-search').addEventListener('input', function (e) {
        cyclePickerSearch = targetEl(e).value;
        renderApp();
        var el = byId('cc-pick-search');
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });

      byId('cc-pick-cat').addEventListener('change', function (e) {
        cyclePickerCat = targetEl(e).value;
        renderApp();
      });

      byId('cc-assign-petugas').addEventListener('input', function (e) {
        cycleAssignPetugas = targetEl(e).value;
      });

      root.querySelectorAll('[data-cc-pfilt]').forEach(function (b) {
        b.addEventListener('click', function () {
          cyclePickerFilter = b.getAttribute('data-cc-pfilt');
          renderApp();
        });
      });

      root.querySelectorAll('.cc-pick-chk').forEach(function (chk) {
        chk.addEventListener('change', function () {
          var s = chk.getAttribute('data-sku');
          if (chk.checked) cycleSelectedSkus.add(s);
          else cycleSelectedSkus.delete(s);
          var addBtn = byId('cc-add-selected-btn');
          if (addBtn) addBtn.textContent = 'Tambahkan Terpilih (' + cycleSelectedSkus.size + ')';
        });
      });

      var headChk = byId('cc-pick-head-chk');
      if (headChk) {
        headChk.addEventListener('change', function () {
          var items = root.querySelectorAll('.cc-pick-chk');
          items.forEach(function (chk) {
            chk.checked = headChk.checked;
            var s = chk.getAttribute('data-sku');
            if (headChk.checked) cycleSelectedSkus.add(s);
            else cycleSelectedSkus.delete(s);
          });
          var addBtn = byId('cc-add-selected-btn');
          if (addBtn) addBtn.textContent = 'Tambahkan Terpilih (' + cycleSelectedSkus.size + ')';
        });
      }

      byId('cc-pick-select-all').addEventListener('click', function () {
        root.querySelectorAll('.cc-pick-chk').forEach(function (chk) {
          chk.checked = true;
          cycleSelectedSkus.add(chk.getAttribute('data-sku'));
        });
        var addBtn = byId('cc-add-selected-btn');
        if (addBtn) addBtn.textContent = 'Tambahkan Terpilih (' + cycleSelectedSkus.size + ')';
      });

      byId('cc-pick-clear').addEventListener('click', function () {
        cycleSelectedSkus.clear();
        root.querySelectorAll('.cc-pick-chk').forEach(function (chk) { chk.checked = false; });
        var addBtn = byId('cc-add-selected-btn');
        if (addBtn) addBtn.textContent = 'Tambahkan Terpilih (0)';
      });

      byId('cc-add-selected-btn').addEventListener('click', function () {
        var petugas = byId('cc-assign-petugas').value.trim() || 'Semua Petugas';
        cycleAssignPetugas = petugas;
        addSkusToSession(Array.from(cycleSelectedSkus), petugas);
      });

      byId('cc-paste-skus-btn').addEventListener('click', function () {
        openTextModal({
          title: 'Tempel Daftar SKU / Barcode untuk Cycle Count',
          desc: 'Tempel daftar SKU atau Barcode (satu per baris atau dipisah koma/spasi) untuk langsung dimasukkan ke jadwal ' + activeSession.tgl + '.',
          text: '',
          actionLabel: 'Tambahkan ke Jadwal',
          readonly: false,
          onAction: function () {
            var raw = byId('text-modal-area').value;
            var tokens = raw.split(/[\r\n,;\t\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
            var picked = [];
            tokens.forEach(function (tok) {
              var mf = findMasterByBarcode(d.master, tok) || findMasterBySku(d.master, tok);
              if (mf) picked.push(normSku(mf.sku));
              else if (catalogMap[normSku(tok)]) picked.push(normSku(tok));
            });
            closeTextModal();
            var petugas = (byId('cc-assign-petugas') && byId('cc-assign-petugas').value.trim()) || cycleAssignPetugas || 'Semua Petugas';
            addSkusToSession(picked, petugas);
          }
        });
      });

      root.querySelectorAll('[data-cc-preset]').forEach(function (b) {
        b.addEventListener('click', function () {
          var preset = b.getAttribute('data-cc-preset');
          var petugas = byId('cc-assign-petugas').value.trim() || 'Semua Petugas';
          cycleAssignPetugas = petugas;
          var picked = [];

          if (preset === 'low') {
            an.lowList.forEach(function (r) { picked.push(normSku(r.sku)); });
          } else if (preset === 'expire') {
            an.expAlerts.forEach(function (eb) { if (eb.sku) picked.push(normSku(eb.sku)); });
          } else if (preset === 'all') {
            catalogList.forEach(function (c) { picked.push(c.sku); });
          } else if (preset === 'prevdiff') {
            var prevSess = sessions.find(function (s) { return s.id !== activeSession.id && s.tgl < activeSession.tgl; });
            if (prevSess) {
              var pm = computeCycleSessionMetrics(prevSess, d.cycleCounts);
              pm.rows.forEach(function (r) {
                if (r.counted && r.selisihTotal !== 0) picked.push(normSku(r.sku));
              });
            }
          } else if (preset === 'topmover') {
            var start30 = addDaysISO(todayISO(), -29);
            var cut = d.cutoff || '';
            var outMap = Object.create(null);
            (d.keluar || []).forEach(function (r) {
              if (!r.tgl || r.tgl < start30 || (cut && r.tgl < cut)) return;
              var s = normSku(r.sku);
              if (s) outMap[s] = (outMap[s] || 0) + Number(r.qty || 0);
            });
            picked = Object.keys(outMap).sort(function (a, b) { return outMap[b] - outMap[a]; }).slice(0, 15);
          } else if (preset === 'random10') {
            var pool = catalogList.filter(function (c) { return !scheduledSet.has(c.sku); }).map(function (c) { return c.sku; });
            for (var i = pool.length - 1; i > 0; i--) {
              var j = Math.floor(Math.random() * (i + 1));
              var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
            }
            picked = pool.slice(0, 10);
          }

          picked = Array.from(new Set(picked));
          if (picked.length === 0) {
            showToast('Tidak ada produk yang cocok untuk preset ini', 'warn');
            return;
          }
          addSkusToSession(picked, petugas);
        });
      });
    } else {
      root.querySelectorAll('[data-cc-open-sess]').forEach(function (b) {
        b.addEventListener('click', function () {
          cycleSelectedSessionId = b.getAttribute('data-cc-open-sess');
          cycleAdminTab = 'pantau';
          renderApp();
        });
      });
      root.querySelectorAll('[data-cc-dl-sess]').forEach(function (b) {
        b.addEventListener('click', function () {
          var sid = b.getAttribute('data-cc-dl-sess');
          var target = sessions.find(function (s) { return s.id === sid; });
          if (target) triggerDownloadCsvForSession(target);
        });
      });
    }
  } else {
    root.querySelectorAll('[data-cc-pfilter]').forEach(function (b) {
      b.addEventListener('click', function () {
        cyclePetugasFilter = b.getAttribute('data-cc-pfilter');
        renderApp();
      });
    });

    var pCsvBtn = byId('cc-petugas-csv-btn');
    if (pCsvBtn) {
      pCsvBtn.addEventListener('click', function () {
        triggerDownloadCsvForSession(activeSession);
      });
    }

    var ccScanInc = byId('cc-scan-inc');
    if (ccScanInc) {
      ccScanInc.addEventListener('change', function (e) {
        cycleScanAutoInc = !!targetEl(e).checked;
      });
    }

    function saveFieldCount(itemId, rawVal, keepScanFocus) {
      if (activeSession.status === 'SELESAI') {
        showToast('Sesi ini sudah ditutup Admin', 'warn');
        return;
      }
      var sVal = String(rawVal == null ? '' : rawVal).trim();
      if (sVal === '') {
        showToast('Masukkan angka Stok Fisik terlebih dahulu', 'warn');
        return;
      }
      var qty = parseQty(sVal);
      if (qty < 0) {
        showToast('Stok fisik tidak boleh bernilai negatif', 'warn');
        return;
      }
      var safeId = CSS.escape(String(itemId || ''));
      var noteEl = root.querySelector('.cc-note-inp[data-id="' + safeId + '"]');
      var noteVal = noteEl ? noteEl.value.trim() : '';

      var dNow = curData();
      var sIdx = dNow.cycleCounts.findIndex(function (s) { return s.id === activeSession.id; });
      if (sIdx < 0) return;
      var item = dNow.cycleCounts[sIdx].items.find(function (it) { return it.id === itemId; });
      if (!item) return;
      item.stokFisik = qty;
      item.status = 'TERHITUNG';
      item.countedBy = appState.W.user;
      item.countedAt = new Date().toTimeString().slice(0, 5);
      item.catatan = noteVal;
      writeWarehouseData(appState.W.cur, dNow);
      playBeep(true);
      showToast('Tersimpan: ' + (item.nama || item.sku) + ' = ' + fmtNum(qty) + ' PCS', 'ok');
      renderApp();
      if (keepScanFocus) {
        var reScan = byId('cc-scan-inp');
        if (reScan) reScan.focus();
      }
    }

    root.querySelectorAll('[data-cc-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var delta = Number(b.getAttribute('data-cc-step'));
        var inp = root.querySelector('.cc-fisik-inp[data-id="' + CSS.escape(String(id || '')) + '"]');
        if (!inp) return;
        var cur = inp.value.trim() === '' ? 0 : parseQty(inp.value);
        inp.value = Math.max(0, cur + delta);
      });
    });

    root.querySelectorAll('[data-cc-match]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-cc-match');
        var wms = b.getAttribute('data-wms');
        saveFieldCount(id, wms, false);
      });
    });

    root.querySelectorAll('[data-cc-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-cc-save');
        var inp = root.querySelector('.cc-fisik-inp[data-id="' + CSS.escape(String(id || '')) + '"]');
        saveFieldCount(id, inp ? inp.value : '', false);
      });
    });

    root.querySelectorAll('.cc-fisik-inp').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveFieldCount(inp.getAttribute('data-id'), inp.value, false);
        }
      });
    });

    function handleCycleScan(rawCode) {
      var bc = normBarcode(rawCode);
      if (!bc) return;
      var mf = findMasterByBarcode(d.master, bc) || findMasterBySku(d.master, bc);
      var skuTarget = mf ? normSku(mf.sku) : normSku(bc);
      var cards = qsa<HTMLElement>(root, '[data-cc-card-sku]');
      var targetCard = cards.find(function (el) {
        return normBarcode(el.getAttribute('data-cc-card-bc')) === bc || normSku(el.getAttribute('data-cc-card-sku')) === skuTarget;
      });
      if (!targetCard) {
        playBeep(false);
        showToast('Produk tidak ada di jadwal Cycle Count yang tampil saat ini', 'warn');
        return;
      }
      playBeep(true);
      targetCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      targetCard.classList.add('tr-highlight');
      setTimeout(function () { targetCard!.classList.remove('tr-highlight'); }, 1200);
      var inp = targetCard.querySelector('.cc-fisik-inp') as HTMLInputElement | null;
      if (inp) {
        if (cycleScanAutoInc && activeSession.status !== 'SELESAI') {
          var nextVal = (inp.value.trim() === '' ? 0 : parseQty(inp.value)) + 1;
          inp.value = String(nextVal);
          saveFieldCount(inp.getAttribute('data-id'), nextVal, true);
        } else {
          inp.focus();
          inp.select();
        }
      }
    }

    var ccScanInp = byId('cc-scan-inp');
    if (ccScanInp) {
      ccScanInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCycleScan(ccScanInp.value);
          if (cycleScanAutoInc) {
            var freshInp = byId('cc-scan-inp');
            if (freshInp) { freshInp.value = ''; freshInp.focus(); }
          } else {
            ccScanInp.select();
          }
        }
      });
    }
    var ccCamBtn = byId('cc-cam-btn');
    if (ccCamBtn) {
      ccCamBtn.addEventListener('click', function () {
        openCameraScanner(function (code) {
          if (ccScanInp) ccScanInp.value = code;
          handleCycleScan(code);
        });
      });
    }
  }
}
