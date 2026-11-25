import { computeStockForMode, computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { readWarehouseData, saveRegistry } from '../core/warehouseRegistry.ts';
import { openCameraScanner } from '../services/scannerService.ts';
import { exportAllDatabaseExcel } from '../services/xlsxService.ts';
import { appState, renderApp } from '../state/store.ts';
import { iconSvg, openCopyTSV, openSkuDetailModal, pageHeaderHtml } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { addDaysISO, esc, fmtNum, normBarcode, normLoc, normSku, todayISO } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 7: STOK ===
export function renderStok(root, d, an) {
  var canViewStockHistory = getEffectiveRole() !== 'stockkeeper';
  var q = appState.searchState.stok.trim().toUpperCase();
  var catSet = new Set<string>();
  an.rows.forEach(function (r) {
    if (r.kategori) catSet.add(r.kategori);
  });
  var allCats = Array.from(catSet).sort(function (a, b) { return a.localeCompare(b); });
  if (appState.stokCategoryFilter && allCats.indexOf(appState.stokCategoryFilter) < 0) appState.stokCategoryFilter = '';

  function getFilteredStokRows() {
    var curQ = appState.searchState.stok.trim().toUpperCase();
    return an.rows.slice().sort(function (a, b) {
      var c = a.lok.localeCompare(b.lok);
      return c !== 0 ? c : String(a.nama || a.sku).localeCompare(String(b.nama || b.sku));
    }).filter(function (r) {
      if (appState.stokFilter === 'ada' && !(r.qty > 0)) return false;
      if (appState.stokFilter === 'menipis' && !(r.qty > 0 && r.qty <= d.min)) return false;
      if (appState.stokFilter === 'minus' && !(r.qty < 0)) return false;
      if (appState.stokCategoryFilter && (r.kategori || 'Lainnya') !== appState.stokCategoryFilter) return false;
      if (!curQ) return true;
      return String(r.nama || '').toUpperCase().indexOf(curQ) >= 0;
    });
  }

  function buildStokTbodyHtml(list: any[]) {
    if (list.length === 0) {
      return '<tr><td colspan="' + (canViewStockHistory ? '8' : '7') + '" class="muted" style="text-align:center;padding:24px">Tidak ada barang dengan nama atau filter tersebut.</td></tr>';
    }
    return list.map(function (r) {
      var badge = r.qty < 0
        ? '<span class="badge badge-err">Minus</span>'
        : (r.qty === 0
          ? '<span class="badge badge-neutral">Kosong</span>'
          : (r.qty <= d.min ? '<span class="badge badge-warn">Menipis</span>' : '<span class="badge badge-ok">Aman</span>'));
      var eb = an.skuExpMap[normSku(r.sku)];
      var expCell = '<span class="muted">-</span>';
      if (eb) {
        expCell = '<span class="badge ' + eb.expInfo.badgeCls + '">' + esc(eb.exp) + ' · ' + esc(eb.expInfo.label) + '</span>';
      }
      return '<tr>' +
        '<td>' + esc(r.lok) + '</td>' +
        '<td class="mono">' + esc(r.barcode || '-') + '</td>' +
        '<td class="mono">' + esc(r.sku) + '</td>' +
        '<td><div><strong>' + esc(r.nama || '-') + '</strong></div><div class="muted" style="font-size:11.5px">' + esc(r.kategori || 'Lainnya') + '</div></td>' +
        '<td>' + expCell + '</td>' +
        '<td class="right num"><strong>' + fmtNum(r.qty) + '</strong></td>' +
        '<td>' + badge + '</td>' +
        (canViewStockHistory ? '<td class="right"><button type="button" class="btn btn-sm" data-stok-detail-sku="' + esc(r.sku) + '" data-stok-detail-bc="' + esc(r.barcode || '') + '">Riwayat</button></td>' : '') +
        '</tr>';
    }).join('');
  }

  var rows = getFilteredStokRows();
  var totalShownQty = rows.reduce(function (s, r) { return s + r.qty; }, 0);

  var html = pageHeaderHtml(
    canViewStockHistory ? 'Stok Gudang' : 'Stok Aktif',
    'Posisi stok terkini per lokasi dan SKU (' + (d.mode === 'all' ? 'Snapshot ALL STOCK + baru' : 'Mutasi sejak ' + d.cutoff) + ').'
  );

  html += '<div class="card">' +
    '<div class="field" style="margin-bottom:12px">' +
    '<label for="search-stok">Cari Nama Barang (Real-Time)</label>' +
    '<div class="scan-row">' +
    '<div class="search-wrap" style="max-width:none;flex:1">' +
    '<input id="search-stok" type="search" class="input" placeholder="Ketik nama barang untuk cek ketersediaan stok…" value="' + esc(appState.searchState.stok) + '" autocomplete="off" />' +
    '<span class="search-kbd">/</span>' +
    '</div>' +
    (appState.searchState.stok ? '<button type="button" class="btn btn-sm" id="stok-search-clear">Reset</button>' : '<button type="button" class="btn btn-sm" id="stok-search-clear" style="display:none">Reset</button>') +
    '<button type="button" class="btn" id="stok-cam-btn">Kamera</button>' +
    '</div>' +
    '</div>' +
    '<div class="toolbar">' +
    '<select id="stok-cat-filter" class="input" aria-label="Filter kategori produk" style="width:auto;min-width:170px">' +
    '<option value="">Semua Kategori</option>' +
    allCats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (appState.stokCategoryFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('') +
    '</select>' +
    '<div class="seg-group" role="tablist">' +
    '<button type="button" class="seg-btn' + (appState.stokFilter === 'all' ? ' active' : '') + '" data-sf="all">Semua</button>' +
    '<button type="button" class="seg-btn' + (appState.stokFilter === 'ada' ? ' active' : '') + '" data-sf="ada">Ada Stok</button>' +
    '<button type="button" class="seg-btn' + (appState.stokFilter === 'menipis' ? ' active' : '') + '" data-sf="menipis">Menipis (≤' + fmtNum(d.min) + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.stokFilter === 'minus' ? ' active' : '') + '" data-sf="minus">Minus</button>' +
    '</div>' +
    (canViewStockHistory ? '<button type="button" class="btn" id="copy-stok-btn">Salin ke Sheets</button>' : '') +
    '<button type="button" class="btn" id="stok-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>' +
    '</div>' +
    '<div id="stok-summary-bar" class="muted" style="font-size:12.5px;margin-bottom:10px">Menampilkan <strong class="num">' + fmtNum(rows.length) + '</strong> baris stok · Total Qty: <strong class="num">' + fmtNum(totalShownQty) + ' PCS</strong>' +
    (appState.stokCategoryFilter ? ' · Kategori: <strong>' + esc(appState.stokCategoryFilter) + '</strong>' : '') +
    (appState.searchState.stok.trim() ? ' · Kata kunci nama: <strong>' + esc(appState.searchState.stok.trim()) + '</strong>' : '') +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Lokasi</th><th>Barcode</th><th>SKU</th><th>Nama Barang</th><th>Info Expire</th><th class="right">Stok</th><th>Status</th>' + (canViewStockHistory ? '<th class="right">Detail</th>' : '') + '</tr></thead><tbody id="stok-table-body">' +
    buildStokTbodyHtml(rows) +
    '</tbody></table></div></div>';

  root.innerHTML = html;

  function updateStokTableInPlace() {
    rows = getFilteredStokRows();
    totalShownQty = rows.reduce(function (s, r) { return s + r.qty; }, 0);
    var tbody = byId('stok-table-body');
    if (tbody) tbody.innerHTML = buildStokTbodyHtml(rows);
    var summary = byId('stok-summary-bar');
    if (summary) {
      summary.innerHTML = 'Menampilkan <strong class="num">' + fmtNum(rows.length) + '</strong> baris stok · Total Qty: <strong class="num">' + fmtNum(totalShownQty) + ' PCS</strong>' +
        (appState.stokCategoryFilter ? ' · Kategori: <strong>' + esc(appState.stokCategoryFilter) + '</strong>' : '') +
        (appState.searchState.stok.trim() ? ' · Kata kunci nama: <strong>' + esc(appState.searchState.stok.trim()) + '</strong>' : '');
    }
    var clearBtn = byId('stok-search-clear');
    if (clearBtn) clearBtn.style.display = appState.searchState.stok ? '' : 'none';
  }

  var stokTableBody = byId('stok-table-body');
  if (stokTableBody) {
    stokTableBody.addEventListener('click', function (e) {
      var btn = (e.target as Element | null)?.closest('[data-stok-detail-sku]');
      if (!btn) return;
      openSkuDetailModal(btn.getAttribute('data-stok-detail-sku'), btn.getAttribute('data-stok-detail-bc'));
    });
  }

  byId('search-stok').addEventListener('input', function (e) {
    appState.searchState.stok = targetEl(e).value;
    updateStokTableInPlace();
  });

  byId('stok-search-clear')?.addEventListener('click', function () {
    appState.searchState.stok = '';
    var s = byId('search-stok');
    if (s) {
      s.value = '';
      s.focus();
    }
    updateStokTableInPlace();
  });

  byId('stok-cat-filter').addEventListener('change', function (e) {
    appState.stokCategoryFilter = targetEl(e).value;
    renderApp();
  });

  byId('stok-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      var nb = normBarcode(code);
      var ns = normSku(code);
      var m = findMasterByBarcode(d.master, nb) || findMasterBySku(d.master, ns);
      var rowHit = !m ? an.rows.find(function (r) { return normBarcode(r.barcode) === nb || normSku(r.sku) === ns; }) : null;
      appState.searchState.stok = (m && m.nama) || (rowHit && rowHit.nama) || code;
      renderApp();
    });
  });

  root.querySelectorAll('[data-sf]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.stokFilter = b.getAttribute('data-sf');
      renderApp();
    });
  });

  byId('copy-stok-btn')?.addEventListener('click', function () {
    var latestRows = getFilteredStokRows();
    openCopyTSV('Salin Tabel Stok', ['Lokasi', 'Barcode', 'SKU', 'Nama Barang', 'Kategori', 'Tgl Expire', 'Status Expire', 'Qty'], latestRows.map(function (r) {
      var eb = an.skuExpMap[normSku(r.sku)];
      return [r.lok, r.barcode, r.sku, r.nama, r.kategori || 'Lainnya', eb ? eb.exp : '', eb ? eb.expInfo.label : '', r.qty];
    }));
  });

  byId('stok-export-xlsx-btn')?.addEventListener('click', exportAllDatabaseExcel);
}

// === HALAMAN 8: SEMUA GUDANG ===
export function renderSemuaGudang(root) {
  var whAnalyses = appState.W.list.map(function (w) {
    var data = readWarehouseData(w.id);
    return { meta: w, data: data, an: computeWarehouseAnalysis(data) };
  });

  var skuMatrix = Object.create(null);
  whAnalyses.forEach(function (wa) {
    Object.keys(wa.an.skuMap).forEach(function (sku) {
      var item = wa.an.skuMap[sku];
      if (!skuMatrix[sku]) {
        skuMatrix[sku] = { sku: sku, nama: item.nama, perWh: Object.create(null), total: 0 };
      }
      if (!skuMatrix[sku].nama && item.nama) skuMatrix[sku].nama = item.nama;
      skuMatrix[sku].perWh[wa.meta.id] = item.qty;
      skuMatrix[sku].total += item.qty;
    });
  });

  var q = appState.searchState.semua.trim().toUpperCase();
  var matrixRows = Object.keys(skuMatrix).map(function (k) { return skuMatrix[k]; }).filter(function (r) {
    if (!q) return true;
    return [r.sku, r.nama].join(' ').toUpperCase().indexOf(q) >= 0;
  }).sort(function (a, b) { return b.total - a.total; });

  // Saran redistribusi: SKU menipis (<= min) di satu gudang tapi melimpah (> min * 2) di gudang lain
  var suggestions = [];
  if (whAnalyses.length > 1) {
    Object.keys(skuMatrix).forEach(function (sku) {
      var row = skuMatrix[sku];
      var needy = [];
      var surplus = [];
      whAnalyses.forEach(function (wa) {
        var qty = Number(row.perWh[wa.meta.id] || 0);
        var minT = Number(wa.data.min || 10);
        if (qty <= minT) needy.push({ wa: wa, qty: qty, need: Math.max(minT * 2 - qty, minT) });
        else if (qty > minT * 2) surplus.push({ wa: wa, qty: qty, excess: qty - minT * 2 });
      });
      if (needy.length && surplus.length) {
        needy.sort(function (a, b) { return a.qty - b.qty; });
        surplus.sort(function (a, b) { return b.excess - a.excess; });
        var qtySuggest = Math.min(needy[0].need, surplus[0].excess);
        if (qtySuggest > 0) {
          suggestions.push({
            sku: sku,
            nama: row.nama,
            dari: surplus[0].wa,
            dariQty: surplus[0].qty,
            ke: needy[0].wa,
            keQty: needy[0].qty,
            saranQty: Math.round(qtySuggest)
          });
        }
      }
    });
  }

  var html = pageHeaderHtml(
    'Semua Gudang',
    'Perbandingan stok lintas gudang beserta rekomendasi redistribusi stok otomatis.'
  );

  html += '<div class="kpi-grid">';
  whAnalyses.forEach(function (wa) {
    var st = wa.an.stats;
    var isCur = wa.meta.id === appState.W.cur;
    html += '<div class="kpi-card' + (st.minusCount > 0 ? ' err' : (st.lowCount > 0 ? ' warn' : ' ok')) + '">' +
      '<div class="kpi-label">' + esc(wa.meta.nama) + (isCur ? ' · Aktif' : '') + '</div>' +
      '<div class="kpi-value num">' + fmtNum(st.totalPcs) + ' PCS</div>' +
      '<div class="kpi-sub">' + fmtNum(st.skuAktif) + ' SKU · Menipis: ' + fmtNum(st.lowCount) + ' · Minus: ' + fmtNum(st.minusCount) + '</div>' +
      '</div>';
  });
  html += '</div>';

  // Saran Redistribusi
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Saran Redistribusi Antar-Gudang</h2><span class="badge badge-info">' + suggestions.length + ' saran</span></div>';
  if (whAnalyses.length < 2) {
    html += '<p class="muted" style="margin:0">Tambahkan minimal 2 gudang untuk melihat saran redistribusi stok antar-gudang.</p>';
  } else if (suggestions.length === 0) {
    html += '<p class="muted" style="margin:0">Tidak ada ketimpangan stok signifikan antar-gudang saat ini.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nama Produk</th><th>Dari Gudang (Stok)</th><th>Ke Gudang (Stok)</th><th class="right">Saran Kirim</th><th class="right">Aksi</th></tr></thead><tbody>';
    suggestions.forEach(function (sg, idx) {
      html += '<tr>' +
        '<td class="mono">' + esc(sg.sku) + '</td>' +
        '<td>' + esc(sg.nama || '-') + '</td>' +
        '<td>' + esc(sg.dari.meta.nama) + ' <span class="badge badge-ok num">' + fmtNum(sg.dariQty) + '</span></td>' +
        '<td>' + esc(sg.ke.meta.nama) + ' <span class="badge badge-warn num">' + fmtNum(sg.keQty) + '</span></td>' +
        '<td class="right num"><strong>' + fmtNum(sg.saranQty) + ' PCS</strong></td>' +
        '<td class="right"><button type="button" class="btn btn-sm" data-redist-idx="' + idx + '">Buat Transfer</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  // Matriks SKU x Gudang
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Matriks Stok SKU × Gudang</h2></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-semua" type="search" class="input" placeholder="Cari SKU atau nama produk…" value="' + esc(appState.searchState.semua) + '" /><span class="search-kbd">/</span></div>' +
    '<button type="button" class="btn" id="allwh-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>' +
    '<button type="button" class="btn" id="copy-semua-btn">Salin ke Sheets</button>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nama Produk</th>' +
    whAnalyses.map(function (wa) { return '<th class="right">' + esc(wa.meta.nama) + '</th>'; }).join('') +
    '<th class="right">Total</th></tr></thead><tbody>';

  if (matrixRows.length === 0) {
    html += '<tr><td colspan="' + (3 + whAnalyses.length) + '" class="muted" style="text-align:center;padding:24px">Belum ada data stok di gudang mana pun.</td></tr>';
  } else {
    matrixRows.forEach(function (r) {
      html += '<tr><td class="mono">' + esc(r.sku) + '</td><td>' + esc(r.nama || '-') + '</td>' +
        whAnalyses.map(function (wa) {
          var qv = Number(r.perWh[wa.meta.id] || 0);
          return '<td class="right num">' + fmtNum(qv) + '</td>';
        }).join('') +
        '<td class="right num"><strong>' + fmtNum(r.total) + '</strong></td></tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  byId('search-semua').addEventListener('input', function (e) {
    appState.searchState.semua = targetEl(e).value;
    renderApp();
    var s = byId('search-semua');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });

  byId('allwh-export-xlsx-btn')?.addEventListener('click', exportAllDatabaseExcel);

  byId('copy-semua-btn').addEventListener('click', function () {
    var hdr = ['SKU', 'Nama Produk'].concat(whAnalyses.map(function (w) { return w.meta.nama; })).concat(['Total']);
    var rowsTsv = matrixRows.map(function (r) {
      return [r.sku, r.nama].concat(whAnalyses.map(function (w) { return Number(r.perWh[w.meta.id] || 0); })).concat([r.total]);
    });
    openCopyTSV('Salin Stok Semua Gudang', hdr, rowsTsv);
  });

  root.querySelectorAll('[data-redist-idx]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sg = suggestions[Number(btn.getAttribute('data-redist-idx'))];
      if (!sg) return;
      // Pindah sementara ke gudang asal agar user langsung di form Transfer
      appState.W.cur = sg.dari.meta.id;
      saveRegistry();
      var srcItem = sg.dari.an.rows.find(function (r) { return r.sku === sg.sku && r.qty > 0; });
      window.__transferPrefill = {
        dstWhId: sg.ke.meta.id,
        srcLok: srcItem ? srcItem.lok : '',
        sku: sg.sku,
        qty: sg.saranQty
      };
      appState.currentTab = 'transfer';
      renderApp();
    });
  });
}

// === HALAMAN 9: ANALITIK ===
export function renderAnalitik(root, d, an) {
  var today = todayISO();
  var start14 = addDaysISO(today, -13);
  var start30 = addDaysISO(today, -29);
  var cut = d.cutoff || '';

  // 14 hari masuk vs keluar
  var days14 = [];
  var dayMap = Object.create(null);
  for (var i = 0; i < 14; i++) {
    var dt = addDaysISO(start14, i);
    var entry = { tgl: dt, masuk: 0, keluar: 0 };
    days14.push(entry);
    dayMap[dt] = entry;
  }
  (d.masuk || []).forEach(function (r) {
    if (r.tgl && dayMap[r.tgl] && (!cut || r.tgl >= cut)) dayMap[r.tgl].masuk += Number(r.qty || 0);
  });
  (d.keluar || []).forEach(function (r) {
    if (r.tgl && dayMap[r.tgl] && (!cut || r.tgl >= cut)) dayMap[r.tgl].keluar += Number(r.qty || 0);
  });

  var maxDayVal = Math.max(10, days14.reduce(function (m, x) { return Math.max(m, x.masuk, x.keluar); }, 0));

  // Bangun SVG 14 hari
  var svgW = 760;
  var svgH = 220;
  var padL = 44;
  var padR = 16;
  var padT = 16;
  var padB = 38;
  var plotW = svgW - padL - padR;
  var plotH = svgH - padT - padB;
  var slotW = plotW / 14;
  var barW = Math.max(8, Math.floor((slotW - 10) / 2));

  var svgParts = '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;min-width:560px;height:auto;display:block" role="img" aria-label="Grafik Masuk vs Keluar 14 Hari">';
  for (var g = 0; g <= 4; g++) {
    var gy = padT + (plotH * g) / 4;
    var gVal = Math.round(maxDayVal * (1 - g / 4));
    svgParts += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (svgW - padR) + '" y2="' + gy + '" stroke="var(--border)" stroke-dasharray="3 3"/>';
    svgParts += '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10.5" fill="var(--text-subtle)">' + gVal + '</text>';
  }
  days14.forEach(function (x, idx) {
    var cx = padL + idx * slotW + slotW / 2;
    var hIn = Math.round((x.masuk / maxDayVal) * plotH);
    var hOut = Math.round((x.keluar / maxDayVal) * plotH);
    var xIn = cx - barW - 1;
    var xOut = cx + 1;
    svgParts += '<rect x="' + xIn + '" y="' + (padT + plotH - hIn) + '" width="' + barW + '" height="' + hIn + '" rx="3" fill="#16a34a"><title>' + x.tgl + ' Masuk: ' + fmtNum(x.masuk) + '</title></rect>';
    svgParts += '<rect x="' + xOut + '" y="' + (padT + plotH - hOut) + '" width="' + barW + '" height="' + hOut + '" rx="3" fill="#b5154f"><title>' + x.tgl + ' Keluar: ' + fmtNum(x.keluar) + '</title></rect>';
    svgParts += '<text x="' + cx + '" y="' + (svgH - 14) + '" text-anchor="middle" font-size="10" fill="var(--text-subtle)">' + x.tgl.slice(5) + '</text>';
  });
  svgParts += '</svg>';

  // Agregat 30 hari keluar per SKU
  var out30Map = Object.create(null);
  var totalOut30 = 0;
  (d.keluar || []).forEach(function (r) {
    if (!r.tgl || r.tgl < start30 || (cut && r.tgl < cut)) return;
    var s = normSku(r.sku);
    if (!s) return;
    if (!out30Map[s]) out30Map[s] = { sku: s, nama: r.nama || '', qty: 0 };
    out30Map[s].qty += Number(r.qty || 0);
    if (!out30Map[s].nama && r.nama) out30Map[s].nama = r.nama;
    totalOut30 += Number(r.qty || 0);
  });

  // Top mover & Kelas ABC
  var topMovers = Object.keys(out30Map).map(function (k) { return out30Map[k]; }).sort(function (a, b) { return b.qty - a.qty; });
  var cum = 0;
  topMovers.forEach(function (tm) {
    cum += tm.qty;
    var pct = totalOut30 > 0 ? (cum / totalOut30) * 100 : 100;
    tm.share = totalOut30 > 0 ? (tm.qty / totalOut30) * 100 : 0;
    tm.cumPct = pct;
    tm.abc = pct <= 80 ? 'A' : (pct <= 95 ? 'B' : 'C');
  });

  // Saran reorder (cover < N hari, target 30 hari)
  var coverDays = Number(d.cover || 7);
  var reorderList = [];
  Object.keys(an.skuMap).forEach(function (sku) {
    var curQty = Number(an.skuMap[sku].qty || 0);
    var out30 = out30Map[sku] ? out30Map[sku].qty : 0;
    if (out30 <= 0) return;
    var avgDaily = out30 / 30;
    var cov = curQty / avgDaily;
    if (cov < coverDays) {
      var suggestOrder = Math.max(0, Math.ceil(avgDaily * 30 - curQty));
      if (suggestOrder > 0) {
        reorderList.push({
          sku: sku,
          nama: an.skuMap[sku].nama,
          stok: curQty,
          avgDaily: avgDaily,
          cover: cov,
          orderQty: suggestOrder
        });
      }
    }
  });
  reorderList.sort(function (a, b) { return a.cover - b.cover; });

  // Dead stock (stok > 0, keluar 30 hari === 0)
  var deadStock = Object.keys(an.skuMap).map(function (sku) { return an.skuMap[sku]; }).filter(function (item) {
    return item.qty > 0 && !(out30Map[item.sku] && out30Map[item.sku].qty > 0);
  }).sort(function (a, b) { return b.qty - a.qty; });

  // Utilisasi lokasi
  var locQtyMap = Object.create(null);
  (d.lokasi || []).forEach(function (l) { locQtyMap[normLoc(l)] = 0; });
  an.rows.forEach(function (r) {
    if (r.qty > 0) locQtyMap[r.lok] = (locQtyMap[r.lok] || 0) + r.qty;
  });
  var allLocNames = Object.keys(locQtyMap);
  var filledCount = allLocNames.filter(function (l) { return locQtyMap[l] > 0; }).length;
  var emptyCount = Math.max(0, allLocNames.length - filledCount);
  var densestLocs = allLocNames.map(function (l) { return { lok: l, qty: locQtyMap[l] }; })
    .filter(function (x) { return x.qty > 0; })
    .sort(function (a, b) { return b.qty - a.qty; });

  var html = pageHeaderHtml(
    'Analitik Gudang',
    'Tren pergerakan 14 hari, saran pengadaan ulang, analisis Pareto ABC, dead stock 30 hari, dan utilisasi lokasi.'
  );

  // Grafik 14 hari
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Masuk vs Keluar (14 Hari Terakhir)</h2>' +
    '<div style="display:flex;gap:12px;font-size:12px"><span style="color:#16a34a;font-weight:600">■ Barang Masuk</span><span style="color:#b5154f;font-weight:600">■ Barang Keluar</span></div>' +
    '</div><div class="chart-box">' + svgParts + '</div></div>';

  // Saran Reorder
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Saran Reorder (Cover &lt; ' + fmtNum(coverDays) + ' Hari · Target 30 Hari)</h2>' +
    '<button type="button" class="btn btn-sm" id="copy-reorder-btn">Salin Saran Reorder</button></div>';
  if (reorderList.length === 0) {
    html += '<p class="muted" style="margin:0">Belum ada SKU yang memerlukan reorder berdasarkan target cover ' + fmtNum(coverDays) + ' hari.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nama Produk</th><th class="right">Stok</th><th class="right">Rata² Keluar/Hr</th><th class="right">Cover (Hr)</th><th class="right">Saran Order (30 Hr)</th></tr></thead><tbody>';
    reorderList.forEach(function (r) {
      html += '<tr><td class="mono">' + esc(r.sku) + '</td><td>' + esc(r.nama || '-') + '</td><td class="right num">' + fmtNum(r.stok) + '</td><td class="right num">' + r.avgDaily.toFixed(1) + '</td><td class="right num"><span class="badge badge-warn">' + r.cover.toFixed(1) + ' hr</span></td><td class="right num"><strong>' + fmtNum(r.orderQty) + ' PCS</strong></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  html += '<div class="grid-2">';

  // Top Mover ABC
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Top Mover 30 Hari (Kelas ABC)</h2><span class="muted" style="font-size:12px">A ≤ 80% · B ≤ 95% · C sisanya</span></div>';
  if (topMovers.length === 0) {
    html += '<p class="muted" style="margin:0">Belum ada barang keluar dalam 30 hari terakhir.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Kelas</th><th>SKU</th><th>Nama Produk</th><th class="right">Keluar 30Hr</th><th class="right">Kumulatif</th></tr></thead><tbody>';
    topMovers.slice(0, 20).forEach(function (t) {
      var cls = t.abc === 'A' ? 'badge-ok' : (t.abc === 'B' ? 'badge-info' : 'badge-neutral');
      html += '<tr><td><span class="badge ' + cls + '">' + t.abc + '</span></td><td class="mono">' + esc(t.sku) + '</td><td>' + esc(t.nama || '-') + '</td><td class="right num">' + fmtNum(t.qty) + '</td><td class="right num">' + t.cumPct.toFixed(1) + '%</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  // Dead Stock & Utilisasi Lokasi
  html += '<div class="card"><div class="card-header"><h2 class="card-title">Dead Stock & Utilisasi Lokasi</h2></div>' +
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
    '<span class="badge badge-ok">Terisi: ' + fmtNum(filledCount) + ' lokasi</span>' +
    '<span class="badge badge-neutral">Kosong: ' + fmtNum(emptyCount) + ' lokasi</span>' +
    '<span class="badge badge-warn">Dead Stock: ' + fmtNum(deadStock.length) + ' SKU</span>' +
    '</div>' +
    '<h3 style="font-size:13px;margin:0 0 8px">Dead Stock (Ada Stok, Tanpa Keluar 30 Hari)</h3>';
  if (deadStock.length === 0) {
    html += '<p class="muted" style="margin:0 0 14px">Tidak ada dead stock.</p>';
  } else {
    html += '<div class="table-wrap" style="max-height:190px;margin-bottom:14px"><table><thead><tr><th>SKU</th><th>Nama Produk</th><th class="right">Stok</th></tr></thead><tbody>';
    deadStock.slice(0, 15).forEach(function (ds) {
      html += '<tr><td class="mono">' + esc(ds.sku) + '</td><td>' + esc(ds.nama || '-') + '</td><td class="right num">' + fmtNum(ds.qty) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '<h3 style="font-size:13px;margin:0 0 8px">Lokasi Terpadat</h3>';
  if (densestLocs.length === 0) {
    html += '<p class="muted" style="margin:0">Belum ada lokasi terisi.</p>';
  } else {
    html += '<div class="table-wrap" style="max-height:170px"><table><thead><tr><th>Lokasi</th><th class="right">Total PCS</th></tr></thead><tbody>';
    densestLocs.slice(0, 10).forEach(function (dl) {
      html += '<tr><td>' + esc(dl.lok) + '</td><td class="right num">' + fmtNum(dl.qty) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div></div>';

  root.innerHTML = html;

  byId('copy-reorder-btn').addEventListener('click', function () {
    openCopyTSV('Salin Saran Reorder (Target 30 Hari)', ['SKU', 'Nama Produk', 'Stok Saat Ini', 'Rata-rata Keluar/Hari', 'Cover (Hari)', 'Saran Order (PCS)'], reorderList.map(function (r) {
      return [r.sku, r.nama, r.stok, r.avgDaily.toFixed(2), r.cover.toFixed(1), r.orderQty];
    }));
  });
}

// === HALAMAN 10: CEK DATA ===
export function renderCekData(root, d, an) {
  // Rekonsiliasi ALL STOCK vs Hitungan Mutasi
  var mapAll = computeStockForMode(d, 'all');
  var mapMut = computeStockForMode(d, 'mut');
  var allKeys = Array.from(new Set(Object.keys(mapAll).concat(Object.keys(mapMut))));
  var reconDiffs = [];
  allKeys.forEach(function (k) {
    var a = mapAll[k];
    var m = mapMut[k];
    var qAll = a ? a.qty : 0;
    var qMut = m ? m.qty : 0;
    if (Math.abs(qAll - qMut) > 0.0001) {
      reconDiffs.push({
        lok: (a || m).lok,
        sku: (a || m).sku,
        nama: (a || m).nama,
        qAll: qAll,
        qMut: qMut,
        diff: qAll - qMut
      });
    }
  });

  function renderSection(title, badgeCls, count, headers, rows, rowRenderer) {
    var limited = rows.slice(0, 15);
    var extra = rows.length - limited.length;
    var out = '<div class="card"><div class="card-header"><h2 class="card-title">' + esc(title) + '</h2><span class="badge ' + badgeCls + '">' + fmtNum(count) + '</span></div>';
    if (rows.length === 0) {
      out += '<p class="muted" style="margin:0">Tidak ada temuan pada pemeriksaan ini.</p>';
    } else {
      out += '<div class="table-wrap"><table><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
      limited.forEach(function (r) { out += rowRenderer(r); });
      out += '</tbody></table></div>';
      if (extra > 0) {
        out += '<div class="form-hint">+' + fmtNum(extra) + ' lainnya</div>';
      }
    }
    out += '</div>';
    return out;
  }

  var html = pageHeaderHtml(
    'Cek Data & Audit',
    'Pemeriksaan otomatis integritas stok, rekonsiliasi ALL STOCK vs mutasi, validasi lokasi, dan duplikasi master.'
  );

  html += renderSection(
    '1. Rekonsiliasi ALL STOCK vs Hitungan Mutasi',
    reconDiffs.length ? 'badge-warn' : 'badge-ok',
    reconDiffs.length,
    ['Lokasi', 'SKU', 'Nama Produk', 'ALL STOCK', 'Mutasi', 'Selisih'],
    reconDiffs,
    function (r) {
      return '<tr><td>' + esc(r.lok) + '</td><td class="mono">' + esc(r.sku) + '</td><td>' + esc(r.nama || '-') + '</td><td class="num">' + fmtNum(r.qAll) + '</td><td class="num">' + fmtNum(r.qMut) + '</td><td class="num"><span class="badge badge-warn">' + fmtNum(r.diff) + '</span></td></tr>';
    }
  );

  html += renderSection(
    '2. Barang Keluar Bermasalah',
    an.keluarBermasalah.length ? 'badge-err' : 'badge-ok',
    an.keluarBermasalah.length,
    ['Tanggal', 'Lokasi', 'SKU', 'Qty', 'Pesan Validasi'],
    an.keluarBermasalah,
    function (x) {
      return '<tr><td class="num">' + esc(x.row.tgl || '-') + '</td><td>' + esc(x.row.lok || '-') + '</td><td class="mono">' + esc(x.row.sku || '-') + '</td><td class="num">' + fmtNum(x.row.qty) + '</td><td><span class="badge badge-' + x.status.cls + '">' + esc(x.status.text) + '</span></td></tr>';
    }
  );

  html += renderSection(
    '3. Stok Minus',
    an.minusList.length ? 'badge-err' : 'badge-ok',
    an.minusList.length,
    ['Lokasi', 'SKU', 'Nama Produk', 'Stok'],
    an.minusList,
    function (r) {
      return '<tr><td>' + esc(r.lok) + '</td><td class="mono">' + esc(r.sku) + '</td><td>' + esc(r.nama || '-') + '</td><td class="num"><span class="badge badge-err">' + fmtNum(r.qty) + '</span></td></tr>';
    }
  );

  html += renderSection(
    '4. Lokasi Transaksi Belum Ada di Master Lokasi',
    an.badLocTx.length ? 'badge-warn' : 'badge-ok',
    an.badLocTx.length,
    ['Jenis', 'Tanggal', 'Lokasi Transaksi', 'SKU', 'Qty'],
    an.badLocTx,
    function (r) {
      return '<tr><td>' + esc(r.jenis) + '</td><td class="num">' + esc(r.tgl || '-') + '</td><td>' + esc(r.lok) + '</td><td class="mono">' + esc(r.sku || '-') + '</td><td class="num">' + fmtNum(r.qty) + '</td></tr>';
    }
  );

  html += renderSection(
    '5. Barcode Masuk Tidak Ada di Master Barang',
    an.unknownMasukBc.length ? 'badge-warn' : 'badge-ok',
    an.unknownMasukBc.length,
    ['Tanggal', 'Barcode', 'SKU', 'Nama', 'Lokasi', 'Qty'],
    an.unknownMasukBc,
    function (r) {
      return '<tr><td class="num">' + esc(r.tgl || '-') + '</td><td class="mono">' + esc(r.barcode) + '</td><td class="mono">' + esc(r.sku || '-') + '</td><td>' + esc(r.nama || '-') + '</td><td>' + esc(r.lok) + '</td><td class="num">' + fmtNum(r.qty) + '</td></tr>';
    }
  );

  html += renderSection(
    '6. Barcode Ganda di Master Barang',
    an.dupBarcodes.length ? 'badge-warn' : 'badge-ok',
    an.dupBarcodes.length,
    ['Barcode', 'Jumlah Duplikat', 'Daftar SKU'],
    an.dupBarcodes,
    function (r) {
      return '<tr><td class="mono">' + esc(r.barcode) + '</td><td class="num">' + fmtNum(r.count) + '</td><td>' + esc(r.items.map(function (m) { return m.sku + ' (' + m.nama + ')'; }).join(', ')) + '</td></tr>';
    }
  );

  html += '<div class="card"><div class="card-header"><h2 class="card-title">7. Transaksi Historical (&lt; ' + esc(d.cutoff || '-') + ')</h2><span class="badge badge-neutral">' + fmtNum(an.histCount) + ' transaksi</span></div>' +
    '<p class="muted" style="margin:0">Transaksi dengan tanggal sebelum cutoff berstatus <strong>HISTORICAL</strong> dan tidak ikut dihitung ke stok aktif.</p></div>';

  html += renderSection(
    '8. Deteksi Barang Expired & Mendekati Expire (< ' + Number(d.expMonths || 7) + ' Bulan)',
    an.expAlerts.length ? (an.expiredList.length ? 'badge-err' : 'badge-warn') : 'badge-ok',
    an.expAlerts.length,
    ['Tgl Expire', 'Lokasi', 'Batch', 'SKU', 'Nama Produk', 'Qty', 'Status'],
    an.expAlerts,
    function (b) {
      return '<tr><td class="num">' + esc(b.exp) + '</td><td>' + esc(b.lok || '-') + '</td><td class="mono">' + esc(b.batch || '-') + '</td><td class="mono">' + esc(b.sku) + '</td><td>' + esc(b.nama || '-') + '</td><td class="num">' + fmtNum(b.qty) + '</td><td><span class="badge ' + b.expInfo.badgeCls + '">' + esc(b.expInfo.label) + '</span></td></tr>';
    }
  );

  html += renderSection(
    '9. Barang Defect Dalam Karantina Aktif',
    an.defectActive.length ? 'badge-warn' : 'badge-ok',
    an.defectActive.length,
    ['Tanggal', 'Lokasi', 'SKU', 'Nama Produk', 'Kategori', 'Qty'],
    an.defectActive,
    function (df) {
      return '<tr><td class="num">' + esc(df.tgl) + '</td><td>' + esc(df.lok || '-') + '</td><td class="mono">' + esc(df.sku) + '</td><td>' + esc(df.nama || '-') + '</td><td><span class="badge badge-warn">' + esc(df.kategori) + '</span></td><td class="num">' + fmtNum(df.qty) + '</td></tr>';
    }
  );

  root.innerHTML = html;
}
