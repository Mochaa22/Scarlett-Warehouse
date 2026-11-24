import { buildFefoLocationSuggestions, computeStockForMode, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData, getWhMeta, readWarehouseData, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { buildPindahWhatsappSlip, openWhatsappSlipModal, removeTxSafely } from '../services/transactionService.ts';
import { appState, renderApp } from '../state/store.ts';
import { iconSvg, openCopyTSV, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { esc, fmtNum, normBarcode, normLoc, normSku, parseDate, parseExpDate, parseQty, stockKey, todayISO, uid } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 4: TRANSFER GUDANG ===
export function renderTransfer(root, d, an) {
  var others = appState.W.list.filter(function (w) { return w.id !== appState.W.cur; });
  var html = pageHeaderHtml(
    'Transfer Gudang',
    'Kirim stok dari ' + getWhMeta(appState.W.cur).nama + ' ke gudang lain secara seimbang (otomatis keluar di asal & masuk di tujuan).'
  );

  if (others.length === 0) {
    var canManageWh = getEffectiveRole() === 'super_admin';
    html += '<div class="empty-state"><h3>Belum Ada Gudang Tujuan</h3>' +
      '<p>' + (canManageWh
        ? 'Tambahkan gudang kedua terlebih dahulu di menu Kelola Gudang agar fitur transfer antar-gudang dapat digunakan.'
        : 'Saat ini baru terdapat satu gudang. Hubungi Super Admin untuk menambahkan gudang kedua agar fitur pindah antar-gudang dapat digunakan.') + '</p>' +
      (canManageWh ? '<div class="empty-actions"><button type="button" class="btn btn-primary" id="btn-go-gudang">Buka Kelola Gudang</button></div>' : '') + '</div>';
    root.innerHTML = html;
    var goGudangBtn = byId('btn-go-gudang');
    if (goGudangBtn) {
      goGudangBtn.addEventListener('click', function () {
        appState.currentTab = 'gudang';
        renderApp();
      });
    }
    return;
  }

  var pre = window.__transferPrefill || null;
  window.__transferPrefill = null;

  var srcLocs = Array.from(new Set(an.rows.filter(function (r) { return r.qty > 0; }).map(function (r) { return r.lok; }))).sort();

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Form Transfer Antar-Gudang</h2></div>' +
    '<form id="form-transfer" class="form-grid">' +
    '<div class="field"><label for="tr-tgl">Tanggal</label><input id="tr-tgl" type="date" class="input" value="' + todayISO() + '" required /></div>' +
    '<div class="field"><label for="tr-dst-wh">Gudang Tujuan</label><select id="tr-dst-wh" class="input">' +
    others.map(function (w) {
      var sel = pre && pre.dstWhId === w.id ? ' selected' : '';
      return '<option value="' + esc(w.id) + '"' + sel + '>' + esc(w.nama) + '</option>';
    }).join('') +
    '</select></div>' +
    '<div class="field"><label for="tr-src-lok">Lokasi Asal (' + esc(getWhMeta(appState.W.cur).nama) + ')</label><select id="tr-src-lok" class="input"><option value="">— PILIH LOKASI ASAL —</option>' +
    srcLocs.map(function (l) {
      var sel = pre && pre.srcLok === l ? ' selected' : '';
      return '<option value="' + esc(l) + '"' + sel + '>' + esc(l) + '</option>';
    }).join('') +
    '</select></div>' +
    '<div class="field"><label for="tr-prod">Produk</label><select id="tr-prod" class="input" disabled><option value="">— PILIH LOKASI ASAL —</option></select></div>' +
    '<div class="field"><label for="tr-dst-lok">Lokasi Tujuan (Master Tujuan)</label><select id="tr-dst-lok" class="input"></select></div>' +
    '<div class="field"><label for="tr-qty">Qty Kirim (PCS)</label><input id="tr-qty" type="text" inputmode="decimal" class="input num" value="' + (pre && pre.qty ? esc(pre.qty) : '') + '" placeholder="0" /></div>' +
    '<div class="field"><button type="submit" class="btn btn-primary">Kirim Transfer</button></div>' +
    '</form>' +
    '<div id="tr-info" class="form-hint">Transfer hanya diizinkan bila lokasi tujuan terdaftar di Master Lokasi gudang tujuan dan Qty ≤ stok tersedia.</div>' +
    '</div>';

  // Kumpulkan riwayat transfer dari seluruh gudang yang melibatkan gudang aktif atau semua transfer
  var transfers = [];
  (d.keluar || []).forEach(function (r) {
    if (r.pairId) {
      transfers.push({ id: r.id, pairId: r.pairId, arah: 'Keluar', tgl: r.tgl, dari: getWhMeta(appState.W.cur).nama + ' (' + r.lok + ')', ke: r.partnerWhId ? getWhMeta(r.partnerWhId).nama : '-', sku: r.sku, nama: r.nama, qty: r.qty, ket: r.ket, by: r.by, type: 'keluar' });
    }
  });
  (d.masuk || []).forEach(function (r) {
    if (r.pairId) {
      transfers.push({ id: r.id, pairId: r.pairId, arah: 'Masuk', tgl: r.tgl, dari: r.partnerWhId ? getWhMeta(r.partnerWhId).nama : '-', ke: getWhMeta(appState.W.cur).nama + ' (' + r.lok + ')', sku: r.sku, nama: r.nama, qty: r.qty, ket: r.ket, by: r.by, type: 'masuk' });
    }
  });
  transfers.sort(function (a, b) { return String(b.tgl || '').localeCompare(String(a.tgl || '')); });

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Riwayat Transfer Gudang</h2>' +
    '<button type="button" class="btn btn-sm" id="copy-tr-btn">Salin ke Sheets</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Arah</th><th>Asal</th><th>Tujuan</th><th>SKU</th><th>Nama Produk</th><th class="right">Qty</th><th>Petugas</th><th class="right">Aksi</th></tr></thead><tbody>';

  if (transfers.length === 0) {
    html += '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Belum ada riwayat transfer antar-gudang.</td></tr>';
  } else {
    transfers.forEach(function (t) {
      html += '<tr>' +
        '<td class="num">' + esc(t.tgl) + '</td>' +
        '<td><span class="badge ' + (t.arah === 'Keluar' ? 'badge-warn' : 'badge-ok') + '">' + t.arah + '</span></td>' +
        '<td>' + esc(t.dari) + '</td>' +
        '<td>' + esc(t.ke) + '</td>' +
        '<td class="mono">' + esc(t.sku) + '</td>' +
        '<td>' + esc(t.nama || '-') + '</td>' +
        '<td class="right num">' + fmtNum(t.qty) + '</td>' +
        '<td>' + esc(t.by || '-') + '</td>' +
        '<td class="right"><button type="button" class="btn btn-sm btn-danger" data-del-tr-type="' + t.type + '" data-del-tr-id="' + esc(t.id) + '">Hapus Pasangan</button></td>' +
        '</tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  var dstWhEl = byId('tr-dst-wh');
  var srcLokEl = byId('tr-src-lok');
  var prodEl = byId('tr-prod');
  var dstLokEl = byId('tr-dst-lok');
  var prodMap = Object.create(null);

  function loadDstLocations() {
    var targetData = readWarehouseData(dstWhEl.value);
    var locs = (targetData.lokasi || []).slice().sort();
    if (locs.length === 0) {
      dstLokEl.innerHTML = '<option value="">(Master Lokasi gudang tujuan kosong)</option>';
    } else {
      dstLokEl.innerHTML = '<option value="">— PILIH LOKASI TUJUAN —</option>' +
        locs.map(function (l) { return '<option value="' + esc(l) + '">' + esc(l) + '</option>'; }).join('');
    }
  }

  function loadSrcProducts() {
    var lok = normLoc(srcLokEl.value);
    prodMap = Object.create(null);
    if (!lok) {
      prodEl.innerHTML = '<option value="">— PILIH LOKASI ASAL —</option>';
      prodEl.disabled = true;
      return;
    }
    var items = an.rows.filter(function (r) { return r.lok === lok && r.qty > 0; });
    if (items.length === 0) {
      prodEl.innerHTML = '<option value="">KOSONG</option>';
      prodEl.disabled = true;
    } else {
      var opts = items.length === 1 ? '' : '<option value="">— PILIH PRODUK —</option>';
      items.forEach(function (it) {
        prodMap[it.key] = it;
        var sel = pre && pre.sku === it.sku ? ' selected' : '';
        opts += '<option value="' + esc(it.key) + '"' + sel + '>' + esc((it.nama || it.sku) + ' · ' + it.sku + ' (Stok: ' + fmtNum(it.qty) + ')') + '</option>';
      });
      prodEl.innerHTML = opts;
      prodEl.disabled = false;
    }
  }

  dstWhEl.addEventListener('change', loadDstLocations);
  srcLokEl.addEventListener('change', loadSrcProducts);
  loadDstLocations();
  if (srcLokEl.value) loadSrcProducts();

  byId('form-transfer').addEventListener('submit', function (e) {
    e.preventDefault();
    var tgl = parseDate(byId('tr-tgl').value);
    var dstWhId = dstWhEl.value;
    var srcLok = normLoc(srcLokEl.value);
    var dstLok = normLoc(dstLokEl.value);
    var item = prodMap[prodEl.value];
    var qty = parseQty(byId('tr-qty').value);

    if (!tgl) { showToast('Tanggal transfer tidak valid', 'warn'); return; }
    if (!dstWhId || dstWhId === appState.W.cur) { showToast('Pilih gudang tujuan yang valid', 'warn'); return; }
    if (!srcLok || !item) { showToast('Pilih lokasi asal dan produk', 'warn'); return; }
    if (!(qty > 0)) { showToast('Qty harus lebih dari 0', 'warn'); return; }
    if (qty > item.qty) { showToast('Qty melebihi stok tersedia (' + fmtNum(item.qty) + ' PCS)', 'err'); return; }

    var dstData = readWarehouseData(dstWhId);
    var dstLocSet = new Set((dstData.lokasi || []).map(normLoc));
    if (!dstLok || !dstLocSet.has(dstLok)) {
      showToast('Lokasi tujuan harus terdaftar di Master Lokasi ' + getWhMeta(dstWhId).nama, 'err');
      return;
    }

    var pid = 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var srcMeta = getWhMeta(appState.W.cur);
    var dstMeta = getWhMeta(dstWhId);

    var srcNow = curData();
    srcNow.keluar.push({
      id: uid(),
      tgl: tgl,
      barcode: item.barcode,
      sku: item.sku,
      nama: item.nama,
      lok: srcLok,
      qty: qty,
      ket: 'TRANSFER → ' + dstMeta.nama,
      by: appState.W.user,
      n: 1,
      pairId: pid,
      partnerWhId: dstWhId
    });
    writeWarehouseData(appState.W.cur, srcNow);

    dstData.masuk.push({
      id: uid(),
      tgl: tgl,
      barcode: item.barcode,
      sku: item.sku,
      nama: item.nama,
      lok: dstLok,
      qty: qty,
      ket: 'TRANSFER ← ' + srcMeta.nama,
      by: appState.W.user,
      n: 1,
      pairId: pid,
      partnerWhId: appState.W.cur
    });
    writeWarehouseData(dstWhId, dstData);

    showToast('Transfer ' + fmtNum(qty) + ' PCS ke ' + dstMeta.nama + ' berhasil', 'ok');
    renderApp();
  });

  byId('copy-tr-btn').addEventListener('click', function () {
    openCopyTSV('Salin Riwayat Transfer Gudang', ['Tanggal', 'Arah', 'Asal', 'Tujuan', 'SKU', 'Nama Produk', 'Qty', 'Keterangan', 'Petugas'], transfers.map(function (t) {
      return [t.tgl, t.arah, t.dari, t.ke, t.sku, t.nama, t.qty, t.ket, t.by];
    }));
  });

  root.querySelectorAll('[data-del-tr-id]').forEach(function (b) {
    b.addEventListener('click', function () {
      removeTxSafely(b.getAttribute('data-del-tr-type'), b.getAttribute('data-del-tr-id'));
    });
  });
}

// === HALAMAN 5: PERPINDAHAN BARANG ANTAR LOKASI ===
export function getMovementExpiryOptions(d, item) {
  var balances = new Map();
  var batchExpiries = new Set();

  function matches(row, loc) {
    return stockKey(loc, row.sku, row.barcode) === item.key;
  }

  function add(exp, qty) {
    balances.set(exp, (balances.get(exp) || 0) + qty);
  }

  function affectsStock(row) {
    return row.tgl && (!d.cutoff || row.tgl >= d.cutoff) && (d.mode !== 'all' || row.n === 1);
  }

  // Barang Masuk can also create a Monitor Expire record for the same stock.
  (d.batches || []).forEach(function (row) {
    if (!matches(row, row.lok)) return;
    var exp = parseExpDate(row.exp);
    if (!exp) return;
    batchExpiries.add(exp);
    if (row.status !== 'HABIS' && row.qty > 0) add(exp, Number(row.qty));
  });
  (d.masuk || []).forEach(function (row) {
    if (!matches(row, row.lok) || !(row.qty > 0)) return;
    var exp = parseExpDate(row.exp);
    if (exp && !batchExpiries.has(exp)) add(exp, Number(row.qty));
  });
  (d.pindah || []).forEach(function (row) {
    if (!affectsStock(row)) return;
    var from = matches(row, row.dari);
    var to = matches(row, row.ke);
    if (from === to) return;
    var exp = parseExpDate(row.exp);
    if (exp) add(exp, Math.abs(Number(row.qty || 0)) * (to ? 1 : -1));
  });
  (d.keluar || []).forEach(function (row) {
    if (!affectsStock(row) || !matches(row, row.lok)) return;
    var exp = parseExpDate(row.exp);
    if (exp) add(exp, -Math.abs(Number(row.qty || 0)));
  });

  var dated = Array.from(balances).filter(function (entry) { return entry[1] > 0; });
  dated.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  var datedQty = dated.reduce(function (total, entry) { return total + entry[1]; }, 0);
  var options = dated.map(function (entry) {
    return { exp: entry[0], qty: Math.min(entry[1], item.qty) };
  });
  if (datedQty < item.qty) options.push({ exp: '', qty: item.qty - datedQty });
  return options;
}

export function renderPindah(root, d, an) {
  var srcLocs = Array.from(new Set(an.rows.filter(function (r) { return r.qty > 0; }).map(function (r) { return r.lok; }))).sort();
  var masterLocs = new Set((d.lokasi || []).map(normLoc).filter(Boolean));
  var bcOpts = d.master.map(function (m) { return '<option value="' + esc(m.barcode) + '">' + esc(m.sku + ' — ' + m.nama) + '</option>'; }).join('');

  var html = pageHeaderHtml(
    'Perpindahan Barang',
    'Scan kode lokasi asal dan tujuan, atau ketik dan pilih dari daftar. Scan barcode produk untuk melihat saran FEFO.',
    '<button type="button" class="btn btn-wa btn-sm" id="pindah-wa-btn">' + iconSvg('whatsapp') + '<span>Slip Pindah WA</span></button>'
  );

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Form Pindah Barang / Rak</h2></div>' +
    '<form id="form-pindah" class="form-grid">' +
    '<div class="field span-2"><label for="mv-bc">Scan Barcode / SKU (Opsional — Rekomendasi FEFO)</label>' +
    '<div class="scan-row"><input id="mv-bc" type="text" class="input mono" list="dl-mv-bc" placeholder="Scan / ketik barcode atau SKU produk…" autocapitalize="characters" enterkeyhint="next" autocomplete="off" />' +
    '<button type="button" class="btn" id="mv-cam-btn">Kamera</button></div>' +
    '<div id="mv-prod-preview" class="muted" style="font-size:12px;margin-top:4px"></div>' +
    '<div id="mv-fefo-chips" class="fefo-chip-row"></div></div>' +
    '<div class="field"><label for="mv-tgl">Tanggal</label><input id="mv-tgl" type="date" class="input" value="' + todayISO() + '" required /></div>' +
    '<div class="field"><label for="mv-dari">Lokasi Asal</label><div class="scan-row">' +
    '<input id="mv-dari" class="input mono" type="text" list="dl-mv-dari" placeholder="Scan atau ketik lokasi asal" autocomplete="off" enterkeyhint="next" required />' +
    '<button type="button" class="btn" id="mv-dari-camera" aria-label="Scan lokasi asal dengan kamera">Kamera</button></div></div>' +
    '<div class="field"><label for="mv-prod">Produk di Lokasi Asal</label><select id="mv-prod" class="input" disabled><option value="">Isi lokasi asal dulu</option></select></div>' +
    '<div class="field"><label for="mv-exp">Expiry Date</label><select id="mv-exp" class="input" disabled><option value="">Pilih produk dulu</option></select></div>' +
    '<div class="field"><label for="mv-ke">Lokasi Tujuan</label><div class="scan-row">' +
    '<input id="mv-ke" class="input mono" type="text" list="dl-mv-ke" placeholder="Scan atau ketik lokasi tujuan" autocomplete="off" enterkeyhint="next" required />' +
    '<button type="button" class="btn" id="mv-ke-camera" aria-label="Scan lokasi tujuan dengan kamera">Kamera</button></div></div>' +
    '<div class="field"><label for="mv-qty">Qty (PCS)</label>' +
    '<div class="scan-row"><input id="mv-qty" type="text" inputmode="decimal" class="input num" placeholder="0" /><button type="button" class="btn btn-sm" id="mv-all-btn" disabled>Semua</button></div>' +
    '<div id="mv-avail-hint" class="muted" style="font-size:12px;margin-top:4px"></div></div>' +
    '<div class="field"><button type="submit" class="btn btn-primary">Simpan Pindah</button></div>' +
    '</form>' +
    '<datalist id="dl-mv-bc">' + bcOpts + '</datalist>' +
    '<datalist id="dl-mv-dari">' + srcLocs.map(function (location) {
      return '<option value="' + esc(location) + '"></option>';
    }).join('') + '</datalist>' +
    '<datalist id="dl-mv-ke">' + Array.from(masterLocs).sort().map(function (location) {
      return '<option value="' + esc(location) + '"></option>';
    }).join('') + '</datalist>' +
    '</div>';

  var q = appState.searchState.pindah.trim().toUpperCase();
  var rows = (d.pindah || []).slice().reverse().filter(function (r) {
    if (!q) return true;
    return [r.tgl, r.dari, r.ke, r.barcode, r.sku, r.nama, r.exp, r.by].join(' ').toUpperCase().indexOf(q) >= 0;
  });
  var shown = rows.slice(0, 100);

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Riwayat Perpindahan Barang</h2><span class="muted" style="font-size:12px">' + shown.length + ' dari ' + rows.length + ' baris</span></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-pindah" type="search" class="input" placeholder="Cari lokasi, SKU, nama…" value="' + esc(appState.searchState.pindah) + '" /><span class="search-kbd">/</span></div>' +
    '<button type="button" class="btn" id="copy-pindah-btn">Salin ke Sheets</button>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Dari</th><th>Ke</th><th>Barcode</th><th>SKU</th><th>Nama Produk</th><th>Expiry Date</th><th class="right">Qty</th><th>Petugas</th><th class="right">Aksi</th></tr></thead><tbody>';

  if (shown.length === 0) {
    html += '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">Belum ada perpindahan barang tercatat.</td></tr>';
  } else {
    shown.forEach(function (r) {
      html += '<tr>' +
        '<td class="num">' + esc(r.tgl || '-') + '</td>' +
        '<td><span class="masuk-loc-pill">' + esc(r.dari) + '</span></td>' +
        '<td><span class="masuk-loc-pill">' + esc(r.ke) + '</span></td>' +
        '<td class="mono">' + esc(r.barcode || '-') + '</td>' +
        '<td class="mono">' + esc(r.sku) + '</td>' +
        '<td>' + esc(r.nama || '-') + '</td>' +
        '<td class="num">' + esc(r.exp || '-') + '</td>' +
        '<td class="right num">' + fmtNum(r.qty) + '</td>' +
        '<td>' + esc(r.by || '-') + '</td>' +
        '<td class="right" style="white-space:nowrap">' +
        '<button type="button" class="btn btn-sm" data-wa-pindah="' + esc(r.id) + '">WA</button> ' +
        '<button type="button" class="btn btn-sm btn-danger" data-del-pindah="' + esc(r.id) + '">Hapus</button></td>' +
        '</tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  var bcEl = byId('mv-bc');
  var prevEl = byId('mv-prod-preview');
  var fefoChipsEl = byId('mv-fefo-chips');
  var dariEl = byId('mv-dari');
  var prodEl = byId('mv-prod');
  var expEl = byId('mv-exp');
  var keEl = byId('mv-ke');
  var qtyEl = byId('mv-qty');
  var allBtn = byId('mv-all-btn');
  var availHint = byId('mv-avail-hint');
  var prodMap = Object.create(null);
  var expiryOptions = [];

  function updateQtyHint() {
    var selected = expiryOptions[expEl.selectedIndex];
    allBtn.disabled = !selected;
    availHint.textContent = selected ? 'Tersedia untuk pilihan ini: ' + fmtNum(selected.qty) + ' PCS' : '';
  }

  function updateSelectedAvail() {
    var it = prodMap[prodEl.value];
    expiryOptions = it ? getMovementExpiryOptions(d, it) : [];
    expEl.innerHTML = expiryOptions.length ? expiryOptions.map(function (option) {
      return '<option value="' + esc(option.exp) + '">' + esc(option.exp || 'Belum tercatat') +
        ' (' + fmtNum(option.qty) + ' PCS)</option>';
    }).join('') : '<option value="">Pilih produk dulu</option>';
    expEl.disabled = expiryOptions.length < 2;
    updateQtyHint();
  }

  function populateDariProducts(preferSku, preferBarcode) {
    var l = normLoc(dariEl.value);
    prodMap = Object.create(null);
    if (!l) {
      prodEl.innerHTML = '<option value="">Isi lokasi asal dulu</option>';
      prodEl.disabled = true;
      updateSelectedAvail();
      return;
    }
    var items = an.rows.filter(function (r) { return r.lok === l && r.qty > 0; });
    if (items.length === 0) {
      prodEl.innerHTML = '<option value="">Tidak ada stok di lokasi ini</option>';
      prodEl.disabled = true;
    } else {
      var opts = items.length === 1 ? '' : '<option value="">— PILIH PRODUK —</option>';
      var matchKey = '';
      items.forEach(function (it) {
        prodMap[it.key] = it;
        if (!matchKey && ((preferBarcode && normBarcode(it.barcode) === preferBarcode) || (preferSku && normSku(it.sku) === preferSku))) {
          matchKey = it.key;
        }
        opts += '<option value="' + esc(it.key) + '">' + esc((it.nama || it.sku) + ' · ' + it.sku + ' (Stok: ' + fmtNum(it.qty) + ')') + '</option>';
      });
      prodEl.innerHTML = opts;
      prodEl.disabled = false;
      if (matchKey) prodEl.value = matchKey;
    }
    updateSelectedAvail();
  }

  function lookupPindahBarcode(autoSelectTop) {
    var b = normBarcode(bcEl.value);
    if (!b) {
      prevEl.innerHTML = '';
      fefoChipsEl.innerHTML = '';
      return;
    }
    var mf = findMasterByBarcode(d.master, b) || findMasterBySku(d.master, b);
    var stkHit = !mf ? an.rows.find(function (r) { return r.qty > 0 && (normBarcode(r.barcode) === b || normSku(r.sku) === normSku(b)); }) : null;
    var skuTarget = mf ? normSku(mf.sku) : (stkHit ? normSku(stkHit.sku) : normSku(b));
    var bcTarget = mf ? normBarcode(mf.barcode || b) : (stkHit ? normBarcode(stkHit.barcode || b) : b);
    var namaTarget = (mf && mf.nama) || (stkHit && stkHit.nama) || '';

    var suggestions = buildFefoLocationSuggestions(skuTarget, bcTarget, d, an);
    prevEl.innerHTML = (namaTarget ? ('Produk: <strong>' + esc(namaTarget) + '</strong> · ') : '') + 'SKU <span class="mono">' + esc(skuTarget) + '</span>' +
      (suggestions.length === 0 ? ' · <span style="color:var(--warn-text)">Tidak ada stok positif di rak</span>' : '');

    fefoChipsEl.innerHTML = suggestions.slice(0, 6).map(function (m, idx) {
      var expTxt = m.exp ? (' · Exp ' + m.exp) : '';
      return '<button type="button" class="fefo-chip' + (idx === 0 ? ' top' : '') + '" data-mv-src="' + esc(m.lok) + '" data-mv-sku="' + esc(skuTarget) + '" data-mv-bc="' + esc(bcTarget) + '">' +
        (idx === 0 ? 'FEFO #1 · ' : '') + esc(m.lok) + esc(expTxt) + ' (' + fmtNum(m.qty) + ' PCS)</button>';
    }).join('');

    fefoChipsEl.querySelectorAll('[data-mv-src]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        dariEl.value = chip.getAttribute('data-mv-src');
        populateDariProducts(chip.getAttribute('data-mv-sku'), chip.getAttribute('data-mv-bc'));
        if (keEl.value) qtyEl.focus();
        else keEl.focus();
      });
    });

    if (autoSelectTop && suggestions.length > 0) {
      playBeep(true);
      dariEl.value = suggestions[0].lok;
      populateDariProducts(skuTarget, bcTarget);
      if (keEl.value) qtyEl.focus();
      else keEl.focus();
    } else if (autoSelectTop) {
      playBeep(false);
    }
  }

  bcEl.addEventListener('input', function () { lookupPindahBarcode(false); });
  bcEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      lookupPindahBarcode(true);
    }
  });

  byId('mv-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      bcEl.value = code;
      lookupPindahBarcode(true);
    });
  });

  function confirmOrigin() {
    dariEl.value = normLoc(dariEl.value);
    populateDariProducts('', '');
    if (prodEl.disabled) {
      showToast('Lokasi asal tidak ditemukan atau tidak punya stok positif', 'warn');
      dariEl.focus();
    } else if (prodEl.value) {
      keEl.focus();
    } else {
      prodEl.focus();
    }
  }

  function confirmDestination() {
    keEl.value = normLoc(keEl.value);
    if (!masterLocs.has(keEl.value)) {
      showToast('Lokasi tujuan harus ada di Master Lokasi', 'warn');
      keEl.focus();
    } else if (keEl.value === normLoc(dariEl.value)) {
      showToast('Lokasi tujuan tidak boleh sama dengan lokasi asal', 'warn');
      keEl.focus();
    } else {
      qtyEl.focus();
    }
  }

  [
    { input: dariEl, camera: 'mv-dari-camera', confirm: confirmOrigin },
    { input: keEl, camera: 'mv-ke-camera', confirm: confirmDestination }
  ].forEach(function (location) {
    location.input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      location.confirm();
    });
    byId(location.camera).addEventListener('click', function () {
      openCameraScanner(function (code) {
        if (!location.input.isConnected) return;
        location.input.value = code;
        location.confirm();
      }, normLoc);
    });
  });

  dariEl.addEventListener('input', function () {
    populateDariProducts('', '');
  });
  prodEl.addEventListener('change', updateSelectedAvail);
  expEl.addEventListener('change', updateQtyHint);

  allBtn.addEventListener('click', function () {
    var selected = expiryOptions[expEl.selectedIndex];
    if (selected) {
      qtyEl.value = String(selected.qty);
      qtyEl.focus();
    }
  });

  byId('form-pindah').addEventListener('submit', function (e) {
    e.preventDefault();
    var tgl = parseDate(byId('mv-tgl').value);
    var dari = normLoc(dariEl.value);
    var ke = normLoc(keEl.value);
    var item = prodMap[prodEl.value];
    var qty = parseQty(qtyEl.value);

    if (!tgl) { playBeep(false); showToast('Tanggal wajib diisi', 'warn'); return; }
    if (!dari || !item) { playBeep(false); showToast('Pilih lokasi asal dan produk', 'warn'); return; }
    if (!ke || !masterLocs.has(ke)) { playBeep(false); showToast('Lokasi tujuan harus ada di Master Lokasi', 'err'); return; }
    if (ke === dari) { playBeep(false); showToast('Lokasi tujuan tidak boleh sama dengan lokasi asal', 'warn'); return; }

    var dNow = curData();
    var activeItem = computeStockForMode(dNow)[stockKey(dari, item.sku, item.barcode)];
    var selected = activeItem && activeItem.qty > 0 && getMovementExpiryOptions(dNow, activeItem).find(function (option) {
      return option.exp === expEl.value;
    });
    if (!selected || !(qty > 0) || qty > selected.qty) {
      playBeep(false);
      showToast(selected ? 'Qty harus lebih dari 0 dan maksimal ' + fmtNum(selected.qty) + ' PCS untuk pilihan expiry ini' : 'Stok atau expiry di lokasi asal berubah. Pilih ulang produk.', 'warn');
      return;
    }
    dNow.pindah.push({
      id: uid(),
      tgl: tgl,
      dari: dari,
      ke: ke,
      barcode: item.barcode,
      sku: item.sku,
      nama: item.nama,
      exp: selected.exp,
      qty: qty,
      by: appState.W.user,
      n: 1
    });
    writeWarehouseData(appState.W.cur, dNow);
    playBeep(true);
    showToast('Perpindahan barang dicatat (' + dari + ' → ' + ke + ')', 'ok');
    renderApp();
  });

  byId('pindah-wa-btn').addEventListener('click', function () {
    openWhatsappSlipModal(
      'Laporan Perpindahan Barang — WhatsApp',
      'Ringkasan perpindahan rak hari ini siap dikirim ke WhatsApp.',
      buildPindahWhatsappSlip(curData(), null)
    );
  });

  root.querySelectorAll('[data-wa-pindah]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-wa-pindah');
      var dNow = curData();
      var target = (dNow.pindah || []).find(function (x) { return x.id === id; });
      if (!target) return;
      openWhatsappSlipModal(
        'Slip Perpindahan Barang — WhatsApp',
        'Detail perpindahan barang siap disalin atau dikirim via WhatsApp.',
        buildPindahWhatsappSlip(dNow, target)
      );
    });
  });

  byId('search-pindah').addEventListener('input', function (e) {
    appState.searchState.pindah = targetEl(e).value;
    renderApp();
    var s = byId('search-pindah');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });

  byId('copy-pindah-btn').addEventListener('click', function () {
    openCopyTSV('Salin Perpindahan Barang', ['Tanggal', 'Dari', 'Ke', 'Barcode', 'SKU', 'Nama Produk', 'Expiry Date', 'Qty', 'Petugas'], rows.map(function (r) {
      return [r.tgl, r.dari, r.ke, r.barcode, r.sku, r.nama, r.exp, r.qty, r.by];
    }));
  });

  root.querySelectorAll('[data-del-pindah]').forEach(function (b) {
    b.addEventListener('click', function () {
      removeTxSafely('pindah', b.getAttribute('data-del-pindah'));
    });
  });
}
