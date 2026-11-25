import { getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { buildSampleData } from '../core/seedData.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData, getWhMeta, whPrefix, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { buildDailyWhatsappReport, openWhatsappSlipModal } from '../services/transactionService.ts';
import { exportAllDatabaseExcel, exportUnifiedReportExcel } from '../services/xlsxService.ts';
import { appState, renderApp, safeGet } from '../state/store.ts';
import { iconSvg, openSkuDetailModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { esc, fmtNum, getPeriodLabel, matchesDatePeriod, normBarcode, normSku, todayISO } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';
import { getAdminInboundMatches } from './inboundView.ts';

// === HALAMAN 1: DASHBOARD ===
export function renderDashboard(root, d, an) {
  var hasData = d.master.length > 0 || d.lokasi.length > 0 || d.opening.length > 0 || d.allstock.length > 0 || d.masuk.length > 0 || d.keluar.length > 0 || d.pindah.length > 0;
  var html = pageHeaderHtml(
    'Dashboard — ' + getWhMeta(appState.W.cur).nama,
    'Fokus operasional harian: Barang Masuk, Antrean Inbound Matching, Barang Keluar, dan Perpindahan Barang.',
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    (hasData ? '<button type="button" class="btn btn-primary btn-sm" id="dash-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel Laporan</span></button>' : '') +
    (hasData ? '<button type="button" class="btn btn-sm" id="dash-export-all-btn">' + iconSvg('download') + '<span>Database Lengkap</span></button>' : '') +
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

  // Laporan & Filter Dinamis (Inbound, Outbound, Surat Jalan) -> Terhubung ke Export Excel
  var rf = appState.reportFilter || (appState.reportFilter = { category: 'all', period: 'all', from: '', to: '', status: 'all', q: '' });
  var whName = getWhMeta(appState.W.cur).nama;
  var registerAll = safeGet(whPrefix(appState.W.cur) + 'inboundRegister', []);
  var allMasukRev = (d.masuk || []).slice().reverse();
  var allKeluarRev = (d.keluar || []).slice().reverse();
  var adminMatchFn = getAdminInboundMatches(allMasukRev, registerAll);

  function computeReportFiltered() {
    var qRep = String(rf.q || '').trim().toUpperCase();
    var matchSearch = function (fields: any[]) {
      if (!qRep) return true;
      return fields.join(' ').toUpperCase().indexOf(qRep) >= 0;
    };
    var matchStatus = function (row: any) {
      var done = isMasukAncanthoDone(row);
      if (rf.status === 'pending') return !done;
      if (rf.status === 'done') return done;
      return true;
    };

    var inboundRows = allMasukRev.filter(function (r) {
      if (!matchesDatePeriod(r.tgl, rf.period, rf.from, rf.to)) return false;
      if (!matchStatus(r)) return false;
      return matchSearch([r.tgl, r.barcode, r.sku, r.nama, r.lok, r.by, r.ancanthoBy, r.ket, r.ancanthoKet]);
    });

    var outboundRows = allKeluarRev.filter(function (r) {
      if (!matchesDatePeriod(r.tgl, rf.period, rf.from, rf.to)) return false;
      if (!matchStatus(r)) return false;
      return matchSearch([r.tgl, r.barcode, r.sku, r.nama, r.lok, r.by, r.ancanthoBy, r.ket, r.ancanthoKet]);
    });

    var suratJalanQueueRows = allMasukRev.filter(function (r) {
      if (!matchesDatePeriod(r.tgl, rf.period, rf.from, rf.to)) return false;
      if (!matchStatus(r)) return false;
      var im = adminMatchFn(r);
      return matchSearch([r.tgl, r.supplier, r.driver, r.noPlat, im.noDoc || r.noDoc, r.barcode, r.sku, r.nama, r.lok, r.by, r.ancanthoBy, r.ancanthoKet]);
    });

    var suratJalanRegisterRows = (registerAll || []).slice().reverse().filter(function (ib) {
      if (!matchesDatePeriod(ib.tgl, rf.period, rf.from, rf.to)) return false;
      return matchSearch([ib.tgl, ib.supplier, ib.driver, ib.noPlat, ib.noDoc, ib.barcode, ib.sku, ib.nama]);
    });

    var previewRows: any[] = [];
    if (rf.category === 'all' || rf.category === 'inbound') {
      inboundRows.forEach(function (r) {
        var done = isMasukAncanthoDone(r);
        previewRows.push({
          tgl: r.tgl || '-',
          kat: 'Inbound',
          katCls: 'badge-ok',
          code: r.barcode || r.sku || '-',
          sku: r.sku || '',
          nama: r.nama || r.sku || '-',
          lok: r.lok || '-',
          qty: '+' + fmtNum(r.qty),
          rawQty: Number(r.qty || 0),
          status: done ? 'Done' : 'Menunggu Admin',
          stCls: done ? 'badge-ok' : 'badge-warn',
          pic: r.by || '-',
          ket: r.ket || r.ancanthoKet || ''
        });
      });
    }
    if (rf.category === 'all' || rf.category === 'outbound') {
      outboundRows.forEach(function (r) {
        var done = isMasukAncanthoDone(r);
        previewRows.push({
          tgl: r.tgl || '-',
          kat: 'Outbound',
          katCls: 'badge-warn',
          code: r.barcode || r.sku || '-',
          sku: r.sku || '',
          nama: r.nama || r.sku || '-',
          lok: r.lok || '-',
          qty: '-' + fmtNum(r.qty),
          rawQty: Number(r.qty || 0),
          status: done ? 'Done Transfer' : 'Menunggu Admin',
          stCls: done ? 'badge-ok' : 'badge-warn',
          pic: r.by || '-',
          ket: r.ket || r.ancanthoKet || ''
        });
      });
    }
    if (rf.category === 'surat_jalan') {
      suratJalanQueueRows.forEach(function (r) {
        var done = isMasukAncanthoDone(r);
        var im = adminMatchFn(r);
        previewRows.push({
          tgl: r.tgl || '-',
          kat: 'Surat Jalan',
          katCls: 'badge-info',
          code: r.barcode || r.sku || '-',
          sku: r.sku || '',
          nama: r.nama || r.sku || '-',
          lok: (im.noDoc ? ('Doc ' + im.noDoc + ' · ') : '') + (r.lok || '-'),
          qty: fmtNum(r.qty),
          rawQty: Number(r.qty || 0),
          status: im.label + (done ? ' · Done' : ''),
          stCls: done ? 'badge-ok' : im.cls,
          pic: r.by || '-',
          ket: r.supplier || r.ancanthoKet || ''
        });
      });
    }

    previewRows.sort(function (a, b) {
      return String(b.tgl || '').localeCompare(String(a.tgl || ''));
    });

    return {
      inboundRows: inboundRows,
      outboundRows: outboundRows,
      suratJalanQueueRows: suratJalanQueueRows,
      suratJalanRegisterRows: suratJalanRegisterRows,
      previewRows: previewRows,
      periodLabel: getPeriodLabel(rf.period, rf.from, rf.to)
    };
  }

  var repData = computeReportFiltered();
  var catLabels: Record<string, string> = {
    all: 'Inbound & Outbound',
    inbound: 'Inbound (Barang Masuk)',
    outbound: 'Outbound (Barang Keluar)',
    surat_jalan: 'Surat Jalan'
  };

  function buildReportTableBodyHtml(data: any) {
    var rows = data.previewRows;
    if (!rows.length) {
      return '<tr><td colspan="7" class="muted" style="text-align:center;padding:22px">Tidak ada data transaksi yang sesuai filter ini.</td></tr>';
    }
    return rows.slice(0, 120).map(function (row) {
      return '<tr>' +
        '<td class="num">' + esc(row.tgl) + '</td>' +
        '<td><span class="badge ' + row.katCls + '">' + esc(row.kat) + '</span></td>' +
        '<td><div class="mono" style="font-size:12px">' + esc(row.code) + '</div>' + (row.sku && row.sku !== row.code ? '<div class="muted mono" style="font-size:11px">' + esc(row.sku) + '</div>' : '') + '</td>' +
        '<td><strong>' + esc(row.nama) + '</strong>' + (row.ket ? '<div class="muted" style="font-size:11.5px">' + esc(row.ket) + '</div>' : '') + '</td>' +
        '<td><span class="masuk-loc-pill">' + esc(row.lok) + '</span></td>' +
        '<td class="right num"><strong>' + esc(row.qty) + '</strong></td>' +
        '<td><div><span class="badge ' + row.stCls + '">' + esc(row.status) + '</span></div><div class="muted" style="font-size:11px;margin-top:2px">' + esc(row.pic) + '</div></td>' +
        '</tr>';
    }).join('');
  }

  function buildReportSummaryHtml(data: any) {
    var totalPcsRep = data.previewRows.reduce(function (s: number, r: any) { return s + Number(r.rawQty || 0); }, 0);
    var catTxt = catLabels[rf.category] || 'Semua';
    return 'Menampilkan <strong>' + fmtNum(Math.min(120, data.previewRows.length)) + '</strong> dari <strong>' + fmtNum(data.previewRows.length) + '</strong> baris · ' +
      'Total <strong>' + fmtNum(totalPcsRep) + ' PCS</strong> · Kategori: <strong>' + esc(catTxt) + '</strong> · Periode: <strong>' + esc(data.periodLabel) + '</strong>';
  }

  html += '<section class="card" id="dash-report-card">' +
    '<div class="card-header">' +
    '<div><h2 class="card-title">Laporan &amp; Filter Dinamis (Inbound, Outbound &amp; Surat Jalan)</h2>' +
    '<p class="muted" style="margin:2px 0 0;font-size:12.5px">Filter tabel di bawah terhubung langsung dengan tombol Download Excel (.xlsx).</p></div>' +
    '<button type="button" class="btn btn-primary btn-sm" id="dash-report-export-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>' +
    '</div>' +
    '<div class="form-grid" style="margin-bottom:12px">' +
    '<div class="field span-2"><label>Kategori Data</label><div class="seg-group" role="tablist" aria-label="Kategori Laporan">' +
    '<button type="button" class="seg-btn' + (rf.category === 'all' ? ' active' : '') + '" data-rep-cat="all">Semua (Inbound &amp; Outbound)</button>' +
    '<button type="button" class="seg-btn' + (rf.category === 'inbound' ? ' active' : '') + '" data-rep-cat="inbound">Inbound (Masuk)</button>' +
    '<button type="button" class="seg-btn' + (rf.category === 'outbound' ? ' active' : '') + '" data-rep-cat="outbound">Outbound (Keluar)</button>' +
    '<button type="button" class="seg-btn' + (rf.category === 'surat_jalan' ? ' active' : '') + '" data-rep-cat="surat_jalan">Surat Jalan</button>' +
    '</div></div>' +
    '<div class="field"><label for="rep-period">Periode</label><select id="rep-period" class="input">' +
    '<option value="all"' + (rf.period === 'all' ? ' selected' : '') + '>Semua Waktu</option>' +
    '<option value="month"' + (rf.period === 'month' ? ' selected' : '') + '>Bulan Ini</option>' +
    '<option value="today"' + (rf.period === 'today' ? ' selected' : '') + '>Hari Ini</option>' +
    '<option value="week"' + (rf.period === 'week' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
    '<option value="prev_month"' + (rf.period === 'prev_month' ? ' selected' : '') + '>Bulan Lalu</option>' +
    '<option value="custom"' + (rf.period === 'custom' ? ' selected' : '') + '>Rentang Tanggal</option>' +
    '</select></div>' +
    '<div class="field"><label for="rep-status">Status Ancantho</label><select id="rep-status" class="input">' +
    '<option value="all"' + (rf.status === 'all' ? ' selected' : '') + '>Semua Status</option>' +
    '<option value="pending"' + (rf.status === 'pending' ? ' selected' : '') + '>Menunggu Admin</option>' +
    '<option value="done"' + (rf.status === 'done' ? ' selected' : '') + '>Sudah Done</option>' +
    '</select></div>' +
    (rf.period === 'custom'
      ? '<div class="field"><label for="rep-from">Dari Tanggal</label><input id="rep-from" type="date" class="input" value="' + esc(rf.from || '') + '" /></div>' +
        '<div class="field"><label for="rep-to">Sampai Tanggal</label><input id="rep-to" type="date" class="input" value="' + esc(rf.to || '') + '" /></div>'
      : '') +
    '</div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="rep-search" type="search" class="input" placeholder="Cari produk, barcode, SKU, lokasi, PIC, no doc…" value="' + esc(rf.q || '') + '" /><span class="search-kbd">/</span></div>' +
    '<button type="button" class="btn btn-sm" id="rep-reset-btn">Reset Filter</button>' +
    '</div>' +
    '<div id="rep-summary" class="muted" style="font-size:12.5px;margin:0 0 10px">' + buildReportSummaryHtml(repData) + '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Kategori</th><th>Barcode / SKU</th><th>Nama Barang</th><th>Lokasi / Doc</th><th class="right">Jumlah</th><th>Status &amp; PIC</th></tr></thead><tbody id="rep-table-body">' +
    buildReportTableBodyHtml(repData) +
    '</tbody></table></div>' +
    '</section>';

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

  function triggerFilteredReportExport() {
    var latest = computeReportFiltered();
    exportUnifiedReportExcel({
      whName: whName,
      d: d,
      an: an,
      category: rf.category,
      periodLabel: latest.periodLabel,
      period: rf.period,
      from: rf.from,
      to: rf.to,
      inboundRows: latest.inboundRows,
      outboundRows: latest.outboundRows,
      suratJalanQueueRows: latest.suratJalanQueueRows,
      suratJalanRegisterRows: latest.suratJalanRegisterRows,
      adminMatchFn: adminMatchFn
    });
  }

  var dashExportBtn = byId('dash-export-xlsx-btn');
  if (dashExportBtn) dashExportBtn.addEventListener('click', triggerFilteredReportExport);
  var dashReportExportBtn = byId('dash-report-export-btn');
  if (dashReportExportBtn) dashReportExportBtn.addEventListener('click', triggerFilteredReportExport);
  var dashExportAllBtn = byId('dash-export-all-btn');
  if (dashExportAllBtn) dashExportAllBtn.addEventListener('click', exportAllDatabaseExcel);

  root.querySelectorAll('[data-rep-cat]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      rf.category = btn.getAttribute('data-rep-cat') || 'all';
      renderApp();
    });
  });
  var repPeriodEl = byId('rep-period') as HTMLSelectElement;
  if (repPeriodEl) {
    repPeriodEl.addEventListener('change', function () {
      rf.period = repPeriodEl.value || 'all';
      renderApp();
    });
  }
  var repStatusEl = byId('rep-status') as HTMLSelectElement;
  if (repStatusEl) {
    repStatusEl.addEventListener('change', function () {
      rf.status = repStatusEl.value || 'all';
      renderApp();
    });
  }
  var repFromEl = byId('rep-from') as HTMLInputElement;
  if (repFromEl) {
    repFromEl.addEventListener('change', function () {
      rf.from = repFromEl.value || '';
      renderApp();
    });
  }
  var repToEl = byId('rep-to') as HTMLInputElement;
  if (repToEl) {
    repToEl.addEventListener('change', function () {
      rf.to = repToEl.value || '';
      renderApp();
    });
  }
  var repSearchEl = byId('rep-search') as HTMLInputElement;
  if (repSearchEl) {
    repSearchEl.addEventListener('input', function (e) {
      rf.q = targetEl(e).value;
      var updated = computeReportFiltered();
      var tbody = byId('rep-table-body');
      var sumEl = byId('rep-summary');
      if (tbody) tbody.innerHTML = buildReportTableBodyHtml(updated);
      if (sumEl) sumEl.innerHTML = buildReportSummaryHtml(updated);
    });
  }
  var repResetBtn = byId('rep-reset-btn');
  if (repResetBtn) {
    repResetBtn.addEventListener('click', function () {
      appState.reportFilter = { category: 'all', period: 'all', from: '', to: '', status: 'all', q: '' };
      renderApp();
    });
  }

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
