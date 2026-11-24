import { getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { buildSampleData } from '../core/seedData.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData, getWhMeta, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { buildDailyWhatsappReport, openWhatsappSlipModal } from '../services/transactionService.ts';
import { exportAllDatabaseExcel } from '../services/xlsxService.ts';
import { appState, renderApp } from '../state/store.ts';
import { iconSvg, openSkuDetailModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { esc, fmtNum, normBarcode, normSku, todayISO } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

// === HALAMAN 1: DASHBOARD ===
export function renderDashboard(root, d, an) {
  var hasData = d.master.length > 0 || d.lokasi.length > 0 || d.opening.length > 0 || d.allstock.length > 0 || d.masuk.length > 0 || d.keluar.length > 0 || d.pindah.length > 0;
  var html = pageHeaderHtml(
    'Dashboard — ' + getWhMeta(appState.W.cur).nama,
    'Fokus operasional harian: Barang Masuk, Antrean Inbound Matching, Barang Keluar, dan Perpindahan Barang.',
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-sm" id="dash-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel</span></button>' +
    (hasData ? '<button type="button" class="btn btn-wa btn-sm" id="dash-wa-btn">' + iconSvg('whatsapp') + '<span>Laporan Harian WA</span></button>' : '') +
    '</div>'
  );

  var dashboardRole = getEffectiveRole();
  var st = an.stats;
  if (dashboardRole === 'admin' || dashboardRole === 'super_admin') {
    var total = st.totalLokasi;
    var filled = st.lokasiMasterTerisi;
    var empty = total - filled;
    var percent = total ? filled / total * 100 : 0;
    html += '<section class="card" aria-labelledby="dash-occupancy-title">' +
      '<div class="card-header"><h2 class="card-title" id="dash-occupancy-title">Occupancy Lokasi</h2>' +
      (total ? '<span class="badge badge-neutral">' + fmtNum(percent) + '% terisi</span>' : '') + '</div>' +
      '<div class="occupancy-counts">' +
        '<div><span class="muted">Lokasi Terisi</span><strong class="num" id="dash-occupancy-filled">' + fmtNum(filled) + '</strong></div>' +
        '<div><span class="muted">Lokasi Kosong</span><strong class="num" id="dash-occupancy-empty">' + fmtNum(empty) + '</strong></div>' +
        '<div><span class="muted">Total Lokasi</span><strong class="num" id="dash-occupancy-total">' + fmtNum(total) + '</strong></div>' +
      '</div>' +
      (total ? '<progress class="occupancy-progress" aria-label="Proporsi lokasi terisi" value="' + filled + '" max="' + total + '"></progress>' :
        '<p class="muted" style="margin:10px 0 0">Master Lokasi belum diisi.</p>') +
      '</section>';
  }

  if (!hasData) {
    html += '<div class="empty-state">' +
      '<h3>Gudang Ini Belum Memiliki Data</h3>' +
      '<p>Mulai dengan mengimpor file spreadsheet .xlsx dari Google Sheets Anda, atau muat data contoh Scarlett GP1 untuk langsung menguji alur Masuk, Inbound, Keluar, dan Perpindahan.</p>' +
      '<div class="empty-actions">' +
      '<button type="button" class="btn btn-primary" id="btn-empty-sample">Muat Data Contoh</button>' +
      (getEffectiveRole() === 'super_admin' ? '<button type="button" class="btn" id="btn-empty-import">Buka Master &amp; Impor</button>' : '') +
      '</div></div>';
    root.innerHTML = html;
    byId('btn-empty-sample').addEventListener('click', function () {
      writeWarehouseData(appState.W.cur, buildSampleData());
      showToast('Data contoh berhasil dimuat ke ' + getWhMeta(appState.W.cur).nama, 'ok');
      renderApp();
    });
    var emptyImpBtn = byId('btn-empty-import');
    if (emptyImpBtn) {
      emptyImpBtn.addEventListener('click', function () {
        appState.currentTab = 'master';
        renderApp();
      });
    }
    return;
  }

  html += '<div class="meta-strip">' +
    '<span>Cutoff <strong>' + esc(d.cutoff || '-') + '</strong></span>' +
    '<span aria-hidden="true">·</span>' +
    '<span>Mode Stok <strong>' + (d.mode === 'all' ? 'ALL STOCK + Baru' : 'Mutasi') + '</strong></span>' +
    '<span aria-hidden="true">·</span>' +
    '<span>Petugas <strong>' + esc(appState.W.user) + '</strong></span>' +
    '</div>';

  html += '<div class="quick-grid dash-stagger">' +
    '<button type="button" class="quick-tile primary" data-jump="masuk">' + iconSvg('masuk') + '<span>Catat Masuk</span></button>' +
    '<button type="button" class="quick-tile" data-jump="inbound">' + iconSvg('inbound') + '<span>Antrean Inbound' + (an.stats.masukPending > 0 ? ' (' + an.stats.masukPending + ')' : '') + '</span></button>' +
    '<button type="button" class="quick-tile" data-jump="keluar">' + iconSvg('keluar') + '<span>Catat Keluar</span></button>' +
    '<button type="button" class="quick-tile" data-jump="pindah">' + iconSvg('pindah') + '<span>Pindah Barang</span></button>' +
    '<button type="button" class="quick-tile" data-jump="stok">' + iconSvg('stok') + '<span>Stok Aktif</span></button>' +
    '<button type="button" class="quick-tile" id="dash-wa-tile">' + iconSvg('whatsapp') + '<span>Laporan WA</span></button>' +
    '</div>';

  var expMonths = Number(d.expMonths || 7);

  if (an.expAlerts.length > 0) {
    var topAlerts = an.expAlerts.slice(0, 3).map(function (b) {
      return '<strong>' + esc(b.nama || b.sku) + '</strong> (' + esc(b.lok || '-') + ', Exp ' + esc(b.exp) + ' · ' + esc(b.expInfo.label) + ')';
    }).join(' · ');
    html += '<div class="exp-banner' + (st.expiredCount > 0 ? ' critical' : '') + '">' +
      '<div style="flex:1;min-width:240px">' +
      '<div class="exp-banner-title">' + iconSvg('expire') + '<span>' +
      (st.expiredCount > 0 ? 'Perhatian FEFO: Ada Barang Expired / Mendekati Expire (&lt; ' + expMonths + ' Bulan)' : 'Pengingat FEFO: Barang Mendekati Expire &lt; ' + expMonths + ' Bulan') +
      '</span></div>' +
      '<div class="exp-banner-desc"><strong>' + fmtNum(st.expAlertCount) + '</strong> batch (' + fmtNum(st.expAlertPcs) + ' PCS): ' + topAlerts + (an.expAlerts.length > 3 ? ' +' + (an.expAlerts.length - 3) + ' lainnya' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-primary btn-sm" data-jump="keluar">Keluarkan FEFO</button>' +
      (getEffectiveRole() === 'super_admin' ? '<button type="button" class="btn btn-sm" data-jump="expire">Monitor Expire</button>' : '') +
      '</div></div>';
  }

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Cek Barcode Cepat (PDA / Kamera HP)</h2></div>' +
    '<div class="scan-row">' +
    '<input id="dash-scan-inp" type="text" class="input mono" placeholder="Scan barcode atau ketik SKU lalu tekan Enter…" autocapitalize="characters" enterkeyhint="search" autocomplete="off" />' +
    '<button type="button" class="btn btn-primary" id="dash-scan-cam">Kamera HP</button>' +
    '</div>' +
    '<div id="dash-scan-res"></div>' +
    '</div>';

  html += '<div class="kpi-grid dash-stagger">' +
    '<div class="kpi-card ok clickable" data-jump="masuk"><div class="kpi-top"><div class="kpi-label">Masuk Hari Ini</div><div class="kpi-tag num">' + todayISO() + '</div></div><div class="kpi-value num">+' + fmtNum(st.masukToday) + ' PCS</div><div class="kpi-sub">Menunggu Admin Ancantho: ' + fmtNum(st.masukPending) + ' baris</div></div>' +
    '<div class="kpi-card ' + (st.masukPending > 0 ? 'warn' : 'ok') + ' clickable" data-jump="inbound"><div class="kpi-top"><div class="kpi-label">Antrean Inbound</div><div class="kpi-tag">Matching</div></div><div class="kpi-value num">' + fmtNum(st.masukPending) + ' baris</div><div class="kpi-sub">✓ ' + fmtNum(st.inboundMatched) + ' Match · ' + fmtNum(st.inboundMismatch) + ' Selisih · ' + fmtNum(st.inboundUnfilled) + ' Belum Isi</div></div>' +
    '<div class="kpi-card clickable" data-jump="keluar"><div class="kpi-top"><div class="kpi-label">Keluar Hari Ini</div><div class="kpi-tag num">' + todayISO() + '</div></div><div class="kpi-value num">-' + fmtNum(st.keluarToday) + ' PCS</div><div class="kpi-sub">Menunggu Ancantho: ' + fmtNum(st.keluarPending) + ' baris</div></div>' +
    '<div class="kpi-card clickable" data-jump="pindah"><div class="kpi-top"><div class="kpi-label">Perpindahan Hari Ini</div><div class="kpi-tag">Mutasi Rak</div></div><div class="kpi-value num">' + fmtNum(st.pindahTodayCount) + ' mutasi</div><div class="kpi-sub">Total ' + fmtNum(st.pindahTodayQty) + ' PCS dipindah antar rak</div></div>' +
    '<div class="kpi-card ok clickable" data-jump="stok"><div class="kpi-top"><div class="kpi-label">Total Stok Bagus</div><div class="kpi-tag">' + fmtNum(st.skuAktif) + ' SKU</div></div><div class="kpi-value num">' + fmtNum(st.totalPcs) + ' PCS</div></div>' +
    '<div class="kpi-card ' + ((st.lowCount + st.minusCount) > 0 ? 'warn' : 'ok') + ' clickable" data-jump="stok"><div class="kpi-top"><div class="kpi-label">Stok Menipis / Minus</div><div class="kpi-tag">≤ ' + fmtNum(d.min) + ' PCS</div></div><div class="kpi-value num">' + fmtNum(st.lowCount) + ' / ' + fmtNum(st.minusCount) + '</div><div class="kpi-sub">Menipis: ' + fmtNum(st.lowCount) + ' · Minus: ' + fmtNum(st.minusCount) + ' baris</div></div>' +
    '</div>';

  // Prioritas Tindakan Hari Ini (2 Kolom: Antrean Inbound & Keluar/Pindah)
  var pendingInboundList = (d.masuk || []).filter(function (r) { return !isMasukAncanthoDone(r); }).slice().reverse();
  var pendingKeluarList = (d.keluar || []).filter(function (r) { return !isMasukAncanthoDone(r); }).slice().reverse();
  var recentPindahList = (d.pindah || []).slice().reverse();

  html += '<div class="grid-2">';

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Antrean Inbound (Matching Ancantho)</h2><button type="button" class="btn btn-primary btn-sm" data-jump="inbound">Kelola (' + pendingInboundList.length + ')</button></div>';
  if (pendingInboundList.length === 0) {
    html += '<p class="muted" style="margin:0">Semua input barang masuk Stockkeeper sudah selesai dicocokkan &amp; diinput ke Ancantho.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Lokasi</th><th>Produk</th><th class="right">SK</th><th class="right">Inbound</th><th>Status</th></tr></thead><tbody>';
    pendingInboundList.slice(0, 8).forEach(function (r) {
      var im = getMasukInboundMatch(r);
      html += '<tr>' +
        '<td><span class="masuk-loc-pill">' + esc(r.lok || '-') + '</span></td>' +
        '<td><strong>' + esc(r.nama || r.sku) + '</strong><div class="muted" style="font-size:11.5px">' + esc(r.by || '-') + ' · ' + esc(r.tgl || '-') + '</div></td>' +
        '<td class="right num">+' + fmtNum(r.qty) + '</td>' +
        '<td class="right num">' + (im.hasInbound ? fmtNum(im.inboundQty) : '<span class="muted">-</span>') + '</td>' +
        '<td><span class="badge ' + im.cls + '">' + esc(im.label) + '</span></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Keluar Menunggu &amp; Perpindahan Terbaru</h2><div style="display:flex;gap:6px"><button type="button" class="btn btn-sm" id="dash-keluar-admin-btn">Keluar (' + pendingKeluarList.length + ')</button><button type="button" class="btn btn-sm" data-jump="pindah">Pindah</button></div></div>';
  if (pendingKeluarList.length === 0 && recentPindahList.length === 0) {
    html += '<p class="muted" style="margin:0">Tidak ada antrean keluar menunggu maupun perpindahan terbaru.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Alur</th><th>Lokasi / Rute</th><th>Produk</th><th class="right">Qty</th><th>Petugas</th></tr></thead><tbody>';
    pendingKeluarList.slice(0, 5).forEach(function (r) {
      html += '<tr>' +
        '<td><span class="badge badge-warn">Keluar</span></td>' +
        '<td><span class="masuk-loc-pill">' + esc(r.lok || '-') + '</span></td>' +
        '<td>' + esc(r.nama || r.sku) + '</td>' +
        '<td class="right num">-' + fmtNum(r.qty) + '</td>' +
        '<td>' + esc(r.by || '-') + '</td>' +
        '</tr>';
    });
    recentPindahList.slice(0, 5).forEach(function (r) {
      html += '<tr>' +
        '<td><span class="badge badge-info">Pindah</span></td>' +
        '<td>' + esc(r.dari) + ' → ' + esc(r.ke) + '</td>' +
        '<td>' + esc(r.nama || r.sku) + '</td>' +
        '<td class="right num">' + fmtNum(r.qty) + '</td>' +
        '<td>' + esc(r.by || '-') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div></div>';

  // Aktivitas 4 Alur Utama Terakhir
  var activities = [];
  (d.masuk || []).forEach(function (r) {
    activities.push({ jenis: 'Masuk', cls: 'badge-ok', tgl: r.tgl, desk: r.lok + ' · ' + (r.nama || r.sku), qty: '+' + fmtNum(r.qty), by: r.by || '-' });
  });
  (d.keluar || []).forEach(function (r) {
    activities.push({ jenis: 'Keluar', cls: 'badge-warn', tgl: r.tgl, desk: r.lok + ' · ' + (r.nama || r.sku), qty: '-' + fmtNum(r.qty), by: r.by || '-' });
  });
  (d.pindah || []).forEach(function (r) {
    activities.push({ jenis: 'Pindah', cls: 'badge-info', tgl: r.tgl, desk: r.dari + ' → ' + r.ke + ' · ' + (r.nama || r.sku), qty: fmtNum(r.qty), by: r.by || '-' });
  });
  activities.sort(function (a, b) { return String(b.tgl || '').localeCompare(String(a.tgl || '')); });

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Aktivitas Masuk, Keluar &amp; Pindah Terakhir</h2><span class="muted" style="font-size:12px">15 transaksi terbaru</span></div>';
  if (activities.length === 0) {
    html += '<p class="muted" style="margin:0">Belum ada transaksi tercatat.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Jenis</th><th>Detail</th><th class="right">Qty</th><th>Petugas</th></tr></thead><tbody>';
    activities.slice(0, 15).forEach(function (a) {
      html += '<tr><td class="num">' + esc(a.tgl || '-') + '</td><td><span class="badge ' + a.cls + '">' + a.jenis + '</span></td><td>' + esc(a.desk) + '</td><td class="right num">' + esc(a.qty) + '</td><td>' + esc(a.by) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  root.innerHTML = html;
  root.querySelectorAll('[data-jump]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.currentTab = b.getAttribute('data-jump');
      renderApp();
    });
  });

  var keluarAdminJumpBtn = byId('dash-keluar-admin-btn');
  if (keluarAdminJumpBtn) {
    keluarAdminJumpBtn.addEventListener('click', function () {
      appState.keluarRole = pendingKeluarList.length > 0 ? 'admin' : 'stockkeeper';
      appState.currentTab = 'keluar';
      renderApp();
    });
  }

  function openDashWhatsapp() {
    openWhatsappSlipModal(
      'Laporan Harian Gudang — WhatsApp',
      'Salin pesan ringkasan atau klik Kirim WhatsApp untuk langsung membuka chat WA.',
      buildDailyWhatsappReport(curData(), computeWarehouseAnalysis(curData()))
    );
  }
  var dashExportBtn = byId('dash-export-xlsx-btn');
  if (dashExportBtn) dashExportBtn.addEventListener('click', exportAllDatabaseExcel);
  var dashWaBtn = byId('dash-wa-btn');
  var dashWaTile = byId('dash-wa-tile');
  if (dashWaBtn) dashWaBtn.addEventListener('click', openDashWhatsapp);
  if (dashWaTile) dashWaTile.addEventListener('click', openDashWhatsapp);

  var dashScanInp = byId('dash-scan-inp');
  var dashScanRes = byId('dash-scan-res');
  function runDashLookup(rawVal) {
    var q = normBarcode(rawVal);
    if (!q) { dashScanRes.innerHTML = ''; return; }
    var m = findMasterByBarcode(d.master, q) || findMasterBySku(d.master, q);
    var skuTarget = m ? normSku(m.sku) : normSku(q);
    var hits = an.rows.filter(function (r) {
      return (normBarcode(r.barcode) === q || normSku(r.sku) === skuTarget) && r.qty !== 0;
    });
    var batchHits = an.batchRows.filter(function (b) {
      return normBarcode(b.barcode) === q || normSku(b.sku) === skuTarget;
    });
    var defHits = an.defectActive.filter(function (df) {
      return normBarcode(df.barcode) === q || normSku(df.sku) === skuTarget;
    });
    if (!m && hits.length === 0 && batchHits.length === 0 && defHits.length === 0) {
      playBeep(false);
      dashScanRes.innerHTML = '<div class="inline-alert warn">Barcode/SKU <strong>' + esc(q) + '</strong> belum ditemukan di Master maupun stok aktif.</div>';
      return;
    }
    var hasExpAlert = batchHits.some(function (b) { return b.expInfo.isAlert; });
    playBeep(!hasExpAlert);
    var totalSku = hits.reduce(function (s, r) { return s + r.qty; }, 0);
    var titleTxt = m ? (m.nama + ' (' + m.sku + ')') : (((hits[0] || batchHits[0] || defHits[0]).nama || skuTarget) + ' (' + skuTarget + ')');
    var locBadges = hits.length
      ? hits.map(function (h) { return '<span class="badge ' + (h.qty < 0 ? 'badge-err' : (h.qty <= d.min ? 'badge-warn' : 'badge-ok')) + '">' + esc(h.lok) + ': ' + fmtNum(h.qty) + ' PCS</span>'; }).join(' ')
      : '<span class="badge badge-neutral">Stok 0 PCS</span>';
    var expBadges = batchHits.map(function (b) {
      return '<span class="badge ' + b.expInfo.badgeCls + '">Exp ' + esc(b.exp) + ' (' + esc(b.expInfo.label) + ' · ' + fmtNum(b.qty) + ' PCS)</span>';
    }).join(' ');
    var defTotal = defHits.reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);
    var defBadge = defTotal > 0 ? '<span class="badge badge-err">Defect Karantina: ' + fmtNum(defTotal) + ' PCS</span>' : '';
    dashScanRes.innerHTML = '<div class="inline-alert ' + (hasExpAlert ? 'warn' : 'info') + '" style="display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px">' +
      '<div><strong>' + esc(titleTxt) + '</strong> · Total Bagus: <strong class="num">' + fmtNum(totalSku) + ' PCS</strong></div>' +
      '<button type="button" class="btn btn-sm" id="dash-detail-btn">Kartu Stok &amp; Riwayat</button>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + locBadges + (expBadges ? ' ' + expBadges : '') + (defBadge ? ' ' + defBadge : '') + '</div>' +
      '</div>';
    var detBtn = byId('dash-detail-btn');
    if (detBtn) {
      detBtn.addEventListener('click', function () {
        openSkuDetailModal(skuTarget, m ? m.barcode : q);
      });
    }
  }
  if (dashScanInp) {
    dashScanInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runDashLookup(dashScanInp.value);
        dashScanInp.select();
      }
    });
    byId('dash-scan-cam').addEventListener('click', function () {
      openCameraScanner(function (code) {
        dashScanInp.value = code;
        runDashLookup(code);
      });
    });
  }
}
