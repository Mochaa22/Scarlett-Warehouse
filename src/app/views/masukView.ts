import { getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData, getWhMeta, saveRegistry, scheduleSharedSyncPush, whPrefix, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { buildInboundWhatsappSlip, openWhatsappSlipModal, removeTxSafely } from '../services/transactionService.ts';
import { exportFilteredInboundExcel, syncMasukBatchQty } from '../services/xlsxService.ts';
import { SOUND_KEY, appState, renderApp, safeGet, safeSet } from '../state/store.ts';
import { openBulkTxModal } from '../ui/bulkTxModal.ts';
import { confirmDialog, iconSvg, openCopyTSV, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { classifyExpiry, esc, fmtNum, getPeriodFileSlug, getPeriodLabel, matchesDatePeriod, normBarcode, normLoc, normSku, parseExpDate, parseQty, todayISO, uid } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 2: BARANG MASUK (INPUT STOCKKEEPER & SCAN BERUNTUN) ===
let masukRole = 'stockkeeper';



export function renderMasuk(root, d) {
  var locOpts = d.lokasi.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
  var bcOpts = d.master.map(function (m) { return '<option value="' + esc(m.barcode) + '">' + esc(m.sku + ' — ' + m.nama) + '</option>'; }).join('');
  var expMonths = Number(d.expMonths || 7);

  var allMasuk = (d.masuk || []).slice().reverse();
  var isSkRole = getEffectiveRole() === 'stockkeeper';

  var headerActions = '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-primary btn-sm" id="open-bulk-masuk-btn">' + iconSvg('table') + '<span>Bulk Masuk</span></button>' +
    '<button type="button" class="btn btn-wa btn-sm" id="masuk-wa-btn">' + iconSvg('whatsapp') + '<span>Slip WA</span></button>' +
    '</div>';

  var html = pageHeaderHtml(
    'Barang Masuk',
    'Scan atau ketik barcode untuk mengisi SKU dan Nama Barang dari Master Barang.',
    headerActions
  );

  var q = appState.searchState.masuk.trim().toUpperCase();
  var editItem = appState.masukEditId ? (d.masuk || []).find(function (x) { return x.id === appState.masukEditId; }) : null;
  if (editItem && isSkRole && isMasukAncanthoDone(editItem)) editItem = null;
  if (appState.masukEditId && !editItem) appState.masukEditId = '';
  var defaultSk = editItem ? (editItem.by || '') : (appState.masukStockkeeperName || appState.W.user || '');
  var defaultBc = editItem ? (editItem.barcode || editItem.sku || '') : '';
  var defaultLok = editItem ? (editItem.lok || '') : ((appState.scanPref.lockLoc) ? appState.scanPref.lastLoc : '');
  var defaultExp = editItem ? (editItem.exp || '') : '';
  var defaultQty = editItem ? String(editItem.qty || '') : '';
  var latestRow = isSkRole ? allMasuk.find(function (r) { return !isMasukAncanthoDone(r); }) : (allMasuk[0] || null);
  html += '<div class="card' + (editItem ? ' masuk-edit-card' : '') + '">' +
    '<div class="card-header">' +
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<h2 class="card-title">' + (editItem ? 'Edit Barang Masuk Sebelumnya' : 'Input Stockkeeper') + '</h2>' +
    (editItem ? '<span class="badge badge-warn">Sedang Edit (' + esc(editItem.tgl || '-') + ')</span>' : '') +
    '</div>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    (!editItem && latestRow ? '<button type="button" class="btn btn-sm" id="in-edit-last-btn">Edit Input Terakhir</button>' : '') +
    '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;cursor:pointer"><input id="in-lock-loc" type="checkbox"' + (appState.scanPref.lockLoc ? ' checked' : '') + ' /> Kunci Lokasi</label>' +
    '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;cursor:pointer"><input id="in-sound-chk" type="checkbox"' + (appState.soundEnabled ? ' checked' : '') + ' /> Beep</label>' +
    '</div></div>' +
    '<form id="form-masuk" class="form-grid">' +
    '<div class="field"><label for="in-sk-name">PIC Stockkeeper</label><input id="in-sk-name" type="text" class="input" value="' + esc(defaultSk) + '" placeholder="Mis. Budi / Rina" required /></div>' +
    '<div class="field"><label for="in-tgl">Tanggal</label><input id="in-tgl" class="input" type="date" required value="' + esc(editItem ? editItem.tgl : todayISO()) + '" /></div>' +
    '<div class="field span-2"><label for="in-bc">Barcode</label><div class="scan-row"><input id="in-bc" type="text" class="input mono" list="dl-master-bc" value="' + esc(defaultBc) + '" placeholder="Scan / ketik barcode produk…" autocapitalize="characters" enterkeyhint="next" autocomplete="off" required /><button type="button" class="btn" id="in-cam-btn" title="Scan dengan kamera HP">Kamera</button></div></div>' +
    '<div class="field"><label for="in-sku">SKU</label><input id="in-sku" class="input mono" required value="' + esc(editItem ? editItem.sku : '') + '" /></div>' +
    '<div class="field"><label for="in-product">Nama Barang</label><input id="in-product" class="input" required value="' + esc(editItem ? editItem.nama : '') + '" /></div>' +
    '<div class="field"><label for="in-lok">Lokasi</label><input id="in-lok" type="text" class="input" list="dl-lokasi" value="' + esc(defaultLok) + '" autocapitalize="characters" enterkeyhint="next" placeholder="Contoh: RAK-A1" autocomplete="off" required /></div>' +
    '<div class="field"><label for="in-exp">Expiry Date</label><input id="in-exp" type="date" required class="input" value="' + esc(defaultExp) + '" /></div>' +
    '<div class="field"><label for="in-qty">Qty</label><input id="in-qty" type="text" inputmode="decimal" enterkeyhint="done" class="input num" value="' + esc(defaultQty) + '" placeholder="0" required /></div>' +
    '<div class="field span-2"><label for="in-ket">Keterangan (opsional)</label><input id="in-ket" class="input" maxlength="500" value="' + esc(editItem ? editItem.ket || '' : '') + '" /></div>' +
    '<div class="field"><div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="submit" class="btn btn-primary">' + (editItem ? 'Simpan Perubahan' : 'Simpan Barang Masuk') + '</button>' +
    (editItem ? '<button type="button" class="btn" id="in-cancel-edit-btn">Batal</button>' : '') +
    '</div></div>' +
    '</form>' +
    '<datalist id="dl-lokasi">' + locOpts + '</datalist>' +
    '<datalist id="dl-master-bc">' + bcOpts + '</datalist>' +
    '<div id="in-warn"></div>' +
    '<div id="in-exp-warn"></div>' +
    '</div>';

  var rowsSk = allMasuk.filter(function (r) {
    if (!matchesDatePeriod(r.tgl, appState.masukPeriod, appState.masukFrom, appState.masukTo)) return false;
    var done = isMasukAncanthoDone(r);
    if (appState.masukStatus === 'pending' && done) return false;
    if (appState.masukStatus === 'done' && !done) return false;
    if (!q) return true;
    return [r.tgl, r.ket, r.by, r.barcode, r.sku, r.nama, r.lok, r.exp, r.ancanthoBy, r.ancanthoKet].join(' ').toUpperCase().indexOf(q) >= 0;
  });
  var shownSk = rowsSk.slice(0, 100);
  var masukPeriodLabel = getPeriodLabel(appState.masukPeriod, appState.masukFrom, appState.masukTo);

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Riwayat Input Stockkeeper</h2><span class="muted" style="font-size:12px">Klik Edit jika ada salah input (' + shownSk.length + '/' + rowsSk.length + ' baris · ' + esc(masukPeriodLabel) + ')</span></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-masuk" type="search" class="input" placeholder="Cari stockkeeper, barcode, produk, lokasi…" value="' + esc(appState.searchState.masuk) + '" /><span class="search-kbd">/</span></div>' +
    '<select id="masuk-period-filt" class="input filter-select" aria-label="Filter Periode Barang Masuk">' +
    '<option value="all"' + (appState.masukPeriod === 'all' ? ' selected' : '') + '>Semua Waktu</option>' +
    '<option value="month"' + (appState.masukPeriod === 'month' ? ' selected' : '') + '>Bulan Ini</option>' +
    '<option value="today"' + (appState.masukPeriod === 'today' ? ' selected' : '') + '>Hari Ini</option>' +
    '<option value="week"' + (appState.masukPeriod === 'week' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
    '<option value="prev_month"' + (appState.masukPeriod === 'prev_month' ? ' selected' : '') + '>Bulan Lalu</option>' +
    '<option value="custom"' + (appState.masukPeriod === 'custom' ? ' selected' : '') + '>Rentang Tanggal</option>' +
    '</select>' +
    (appState.masukPeriod === 'custom'
      ? '<input id="masuk-from" type="date" class="input filter-date" value="' + esc(appState.masukFrom || '') + '" aria-label="Dari tanggal" />' +
        '<input id="masuk-to" type="date" class="input filter-date" value="' + esc(appState.masukTo || '') + '" aria-label="Sampai tanggal" />'
      : '') +
    '<select id="masuk-status-filt" class="input filter-select" aria-label="Filter Status Ancantho">' +
    '<option value="all"' + (appState.masukStatus === 'all' ? ' selected' : '') + '>Semua Status</option>' +
    '<option value="pending"' + (appState.masukStatus === 'pending' ? ' selected' : '') + '>Menunggu Admin</option>' +
    '<option value="done"' + (appState.masukStatus === 'done' ? ' selected' : '') + '>Sudah Done</option>' +
    '</select>' +
    '<button type="button" class="btn btn-primary btn-sm" id="masuk-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>' +
    '<button type="button" class="btn btn-sm" id="copy-masuk-btn">Salin ke Sheets</button>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Stockkeeper</th><th>Barcode / Produk</th><th>Lokasi</th><th>Expiry Date</th><th class="right">Qty Stockkeeper</th><th class="right">Stock Inbound</th><th>Status Match &amp; Ancantho</th><th>Keterangan</th><th class="right">Aksi</th></tr></thead><tbody>';

  if (shownSk.length === 0) {
    html += '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">Belum ada data input barang masuk.</td></tr>';
  } else {
    shownSk.forEach(function (r) {
      var isDone = isMasukAncanthoDone(r);
      var im = getMasukInboundMatch(r);
      var isEditingRow = editItem && editItem.id === r.id;
      var expBadge = '';
      if (r.exp) {
        var ei = classifyExpiry(r.exp, expMonths);
        expBadge = ' <span class="badge ' + ei.badgeCls + '">' + esc(ei.label) + '</span>';
      }
      html += '<tr' + (isEditingRow ? ' class="tr-highlight"' : '') + '>' +
        '<td class="num">' + esc(r.tgl || '-') + '</td>' +
        '<td><strong>' + esc(r.by || '-') + '</strong></td>' +
        '<td><div class="mono" style="font-size:12px">' + esc(r.barcode || r.sku || '-') + '</div><div style="font-size:12.5px">' + esc(r.nama || '-') + '</div></td>' +
        '<td><span class="masuk-loc-pill">' + esc(r.lok || '-') + '</span></td>' +
        '<td class="num">' + (r.exp ? (esc(r.exp) + expBadge) : '<span class="muted">-</span>') + '</td>' +
        '<td class="right num"><strong>+' + fmtNum(r.qty) + '</strong></td>' +
        '<td class="right num">' + (im.hasInbound ? ('<strong>' + fmtNum(im.inboundQty) + '</strong>') : '<span class="muted">-</span>') + '</td>' +
        '<td><div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">' +
        (im.hasInbound ? '<span class="badge ' + im.cls + '">' + esc(im.label) + '</span>' : '') +
        (isDone
          ? '<span class="badge badge-ok">✓ Done</span>'
          : '<span class="badge badge-warn">Menunggu Admin</span>') +
        '</div>' + (isDone && r.ancanthoBy ? '<div class="muted" style="font-size:11px;margin-top:2px">' + esc(r.ancanthoBy) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.ket || '') + '</td>' +
        '<td class="right" style="white-space:nowrap">' +
        ((isSkRole && isDone)
          ? '<span class="muted" style="font-size:11.5px">Terkunci</span>'
          : ('<button type="button" class="btn btn-sm" data-edit-masuk="' + esc(r.id) + '">Edit</button> ' +
            '<button type="button" class="btn btn-sm btn-danger" data-del-masuk="' + esc(r.id) + '">Hapus</button>')) +
        '</td></tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  var skNameEl = byId('in-sk-name');
  var bcEl = byId('in-bc');
  var productEl = byId('in-product');
  var skuEl = byId('in-sku');
  var lokEl = byId('in-lok');
  var expEl = byId('in-exp');
  var qtyEl = byId('in-qty');
  var warnEl = byId('in-warn');
  var expWarnEl = byId('in-exp-warn');
  var lockChk = byId('in-lock-loc');
  var soundChk = byId('in-sound-chk');

  skNameEl.addEventListener('input', function () {
    if (!editItem) appState.masukStockkeeperName = skNameEl.value;
  });
  lockChk.addEventListener('change', function () {
    appState.scanPref.lockLoc = lockChk.checked;
    appState.scanPref.lastLoc = normLoc(lokEl.value);
  });
  soundChk.addEventListener('change', function () {
    appState.soundEnabled = soundChk.checked;
    safeSet(SOUND_KEY, appState.soundEnabled);
  });
  function checkInputExpiry() {
    var ev = parseExpDate(expEl.value);
    if (!ev) { expWarnEl.innerHTML = ''; return null; }
    var info = classifyExpiry(ev, expMonths);
    if (info.isAlert) {
      expWarnEl.innerHTML = '<div class="inline-alert ' + (info.status === 'ok' ? 'ok' : (info.status === 'warn' ? 'warn' : 'err')) + '">' +
        '⚠️ <strong>DETEKSI EXPIRE &lt; ' + expMonths + ' BULAN:</strong> ' + esc(info.label) + ' (' + esc(ev) + '). Otomatis masuk pantauan <strong>Monitor Expire</strong>.' +
        '</div>';
    } else {
      expWarnEl.innerHTML = '<div class="inline-alert ok">✅ Masa expire aman (' + esc(info.label) + ').</div>';
    }
    return info;
  }

  function lookupBarcode() {
    var barcode = normBarcode(bcEl.value);
    var product = findMasterByBarcode(d.master, barcode) || findMasterBySku(d.master, barcode);
    skuEl.value = product ? normSku(product.sku) : '';
    productEl.value = product ? (product.nama || '') : '';
    warnEl.textContent = barcode && !product ? 'Barcode belum ada di Master Barang. Isi SKU dan Nama Barang secara manual.' : '';
    return product;
  }

  checkInputExpiry();
  expEl.addEventListener('input', checkInputExpiry);
  bcEl.addEventListener('input', lookupBarcode);

  function handleBarcodeScanComplete() {
    var product = lookupBarcode();
    playBeep(Boolean(product));
    (product ? lokEl : skuEl).focus();
  }

  byId('in-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      bcEl.value = code;
      handleBarcodeScanComplete();
    });
  });
  bcEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleBarcodeScanComplete();
    }
  });

  var editLastBtn = byId('in-edit-last-btn');
  if (editLastBtn && latestRow) {
    editLastBtn.addEventListener('click', function () {
      appState.masukEditId = latestRow.id;
      renderApp();
      setTimeout(function () {
        var qEl = byId('in-qty');
        if (qEl) { qEl.focus(); qEl.select(); }
      }, 20);
    });
  }

  var cancelEditBtn = byId('in-cancel-edit-btn');
  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', function () {
      appState.masukEditId = '';
      renderApp();
    });
  }

  byId('form-masuk').addEventListener('submit', function (e) {
    e.preventDefault();
    var skName = String(skNameEl.value || '').trim();
    var bc = normBarcode(bcEl.value);
    var lok = normLoc(lokEl.value);
    var exp = parseExpDate(expEl.value);
    var qty = parseQty(qtyEl.value);

    if (!skName) { playBeep(false); showToast('PIC Stockkeeper wajib diisi', 'warn'); skNameEl.focus(); return; }
    if (!bc) { playBeep(false); showToast('Barcode wajib diisi', 'warn'); bcEl.focus(); return; }
    if (!lok) { playBeep(false); showToast('Lokasi wajib diisi', 'warn'); lokEl.focus(); return; }
    if (!(qty > 0)) { playBeep(false); showToast('Qty harus lebih dari 0', 'warn'); qtyEl.focus(); return; }

    appState.masukStockkeeperName = skName;
    appState.W.user = skName;
    saveRegistry();
    if (appState.scanPref.lockLoc) appState.scanPref.lastLoc = lok;

    var dNow = curData();
    var sku = normSku(skuEl.value);
    var nama = productEl.value.trim();
    var tgl = byId('in-tgl').value;
    var ket = byId('in-ket').value.trim();
    if (!sku || !nama || !tgl || !exp) {
      showToast('Tanggal, SKU, Nama Barang, dan Expiry Date wajib diisi', 'warn');
      return;
    }

    if (editItem) {
      var idx = (dNow.masuk || []).findIndex(function (x) { return x.id === editItem.id; });
      if (idx >= 0) {
        var target = dNow.masuk[idx];
        Object.assign(target, { tgl: tgl, by: skName, barcode: bc, sku: sku, nama: nama, ket: ket });
        target.lok = lok;
        target.exp = exp;
        target.qty = qty;

        if (exp) {
          syncMasukBatchQty(dNow, target);
        } else {
          dNow.batches = (dNow.batches || []).filter(function (b) { return b.masukId !== target.id; });
        }
        writeWarehouseData(appState.W.cur, dNow);
        appState.masukEditId = '';
        playBeep(true);
        showToast('Perubahan barang masuk disimpan', 'ok');
        renderApp();
        return;
      }
      showToast('Baris barang masuk sudah tidak tersedia', 'warn');
      return;
    }

    var newId = uid();
    var createdRow = {
      id: newId,
      tgl: tgl,
      barcode: bc,
      sku: sku,
      nama: nama,
      lok: lok,
      qty: qty,
      inboundQty: null,
      batch: '',
      exp: exp,
      ket: ket,
      by: skName,
      n: 1,
      ancanthoDone: false,
      ancanthoBy: '',
      ancanthoKet: '',
      ancanthoAt: ''
    };
    dNow.masuk.push(createdRow);

    var expAlertHit = false;
    if (exp) {
      syncMasukBatchQty(dNow, createdRow);
      expAlertHit = classifyExpiry(exp, dNow.expMonths || 7).isAlert;
    }

    writeWarehouseData(appState.W.cur, dNow);
    if (expAlertHit) {
      playBeep(false);
      showToast('Tersimpan (+' + fmtNum(qty) + ' PCS) — PERHATIAN: Expire < ' + (dNow.expMonths || 7) + ' bulan!', 'warn');
    } else {
      playBeep(true);
      showToast('Barang masuk dicatat oleh ' + skName + ' (+' + fmtNum(qty) + ' PCS)', 'ok');
    }
    renderApp();
    setTimeout(function () {
      var nextBc = byId('in-bc');
      if (nextBc) nextBc.focus();
    }, 20);
  });

  root.querySelectorAll('[data-edit-masuk]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.masukEditId = b.getAttribute('data-edit-masuk');
      renderApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(function () {
        var qEl = byId('in-qty');
        if (qEl) { qEl.focus(); qEl.select(); }
      }, 30);
    });
  });

  root.querySelectorAll('[data-del-masuk]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-del-masuk');
      if (appState.masukEditId === id) appState.masukEditId = '';
      removeTxSafely('masuk', id);
    });
  });

  var bulkMasukBtn = byId('open-bulk-masuk-btn');
  if (bulkMasukBtn) {
    bulkMasukBtn.addEventListener('click', function () {
      openBulkTxModal('masuk');
    });
  }

  var waBtn = byId('masuk-wa-btn');
  if (waBtn) {
    waBtn.addEventListener('click', function () {
      var dNow = curData();
      openWhatsappSlipModal(
        'Slip Barang Masuk & Inbound — WhatsApp',
        'Ringkasan input Barang Masuk yang siap dikirim ke grup / Admin Ancantho.',
        buildInboundWhatsappSlip(dNow, computeWarehouseAnalysis(dNow))
      );
    });
  }

  var searchIn = byId('search-masuk');
  if (searchIn) {
    searchIn.addEventListener('input', function (e) {
      appState.searchState.masuk = targetEl(e).value;
      renderApp();
      var s = byId('search-masuk');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
  }

  var masukPeriodEl = byId('masuk-period-filt') as HTMLSelectElement;
  if (masukPeriodEl) {
    masukPeriodEl.addEventListener('change', function () {
      appState.masukPeriod = masukPeriodEl.value || 'all';
      renderApp();
    });
  }
  var masukStatusEl = byId('masuk-status-filt') as HTMLSelectElement;
  if (masukStatusEl) {
    masukStatusEl.addEventListener('change', function () {
      appState.masukStatus = masukStatusEl.value || 'all';
      renderApp();
    });
  }
  var masukFromEl = byId('masuk-from') as HTMLInputElement;
  if (masukFromEl) {
    masukFromEl.addEventListener('change', function () {
      appState.masukFrom = masukFromEl.value || '';
      renderApp();
    });
  }
  var masukToEl = byId('masuk-to') as HTMLInputElement;
  if (masukToEl) {
    masukToEl.addEventListener('change', function () {
      appState.masukTo = masukToEl.value || '';
      renderApp();
    });
  }

  var masukExportBtn = byId('masuk-export-xlsx-btn');
  if (masukExportBtn) {
    masukExportBtn.addEventListener('click', function () {
      exportFilteredInboundExcel(
        getWhMeta(appState.W.cur).nama,
        rowsSk,
        {
          label: masukPeriodLabel,
          slug: getPeriodFileSlug(appState.masukPeriod, appState.masukFrom, appState.masukTo)
        }
      );
    });
  }

  var copyBtn = byId('copy-masuk-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      openCopyTSV(
        'Salin Barang Masuk',
        ['PIC Stockkeeper', 'Tanggal', 'Barcode', 'SKU', 'Nama Barang', 'Lokasi', 'Expiry Date', 'Qty', 'Keterangan'],
        rowsSk.map(function (r) {
          return [r.by, r.tgl, r.barcode, r.sku, r.nama, r.lok, r.exp, r.qty, r.ket || ''];
        })
      );
    });
  }
}

let inboundRegisterColumns = [
  ['tgl', 'Tanggal'], ['supplier', 'Supplier'], ['driver', 'Driver'], ['noPlat', 'No Plat'],
  ['noDoc', 'No Doc'], ['barcode', 'Barcode'], ['sku', 'SKU'], ['nama', 'Nama Barang'],
  ['exp', 'Expired Date'], ['qty', 'Total Qty']
];

export function renderInboundRegister(root, warehouseId, master) {
  if (getEffectiveRole() === 'stockkeeper') return;
  var key = whPrefix(warehouseId) + 'inboundRegister';
  var rows = safeGet(key, []);
  var products = master.filter(function (item) { return item.nama && item.sku; });
  var section = root.querySelector('#inbound-register');
  section.innerHTML = '<summary>Input &amp; Riwayat Surat Jalan</summary>' +
    '<form id="inbound-register-form" class="form-grid" style="margin-top:12px">' +
    inboundRegisterColumns.filter(function (column) {
      return column[0] !== 'exp';
    }).map(function (column) {
      var field = column[0];
      if (field === 'supplier') {
        var suppliers = ['OPTO LUMBUNG SEJAHTERA', 'KALIDERES', 'MOTTO BERINGIN ABADI', 'SINAR ALFA OMEGA', 'GP1'];
        return '<div class="field"><label for="inbound-log-supplier">Supplier</label>' +
          '<select class="input" id="inbound-log-supplier" name="supplier" required><option value="">Pilih supplier</option>' +
          suppliers.map(function (supplier) {
            return '<option value="' + esc(supplier) + '">' + esc(supplier) + '</option>';
          }).join('') + '</select></div>';
      }
      var attributes = field === 'tgl' || field === 'exp' ? 'type="date"' :
        field === 'qty' ? 'type="number" min="1" step="1"' : 'type="text" maxlength="256"';
      if (field === 'tgl') attributes += ' value="' + esc(todayISO()) + '"';
      if (field === 'barcode' || field === 'sku') attributes += ' readonly';
      else attributes += ' required';
      if (field === 'nama') attributes += ' list="inbound-master-products" autocomplete="off" placeholder="Ketik dan pilih deskripsi barang…"';
      return '<div class="field"><label for="inbound-log-' + field + '">' + column[1] +
        '</label><input class="input" id="inbound-log-' + field + '" name="' + field + '" ' + attributes + ' /></div>';
    }).join('') +
    '<datalist id="inbound-master-products">' + products.map(function (product) {
      return '<option value="' + esc(inboundProductLabel(product)) + '"></option>';
    }).join('') + '</datalist>' +
    '<div class="field"><button class="btn btn-primary" type="submit">Simpan Surat Jalan</button> <button class="btn" type="button" id="cancel-inbound-edit" hidden>Batal Edit</button></div></form>' +
    '<div class="toolbar"><button type="button" class="btn" id="copy-inbound-register">Salin Register ke Sheets</button></div>' +
    '<div class="table-wrap"><table><thead><tr>' + inboundRegisterColumns.map(function (column) {
      return '<th>' + column[1] + '</th>';
    }).join('') + '<th>Aksi</th></tr></thead><tbody id="inbound-register-rows"></tbody></table></div>';

  function inboundProductLabel(product) {
    return product.nama + ' — ' + product.sku + (product.barcode ? ' · ' + product.barcode : '');
  }

  var form = section.querySelector('form');
  var description = form.elements.nama;
  var submitButton = form.querySelector('[type="submit"]');
  var cancelEdit = section.querySelector('#cancel-inbound-edit');
  var editIndex = null;
  function fillInboundProduct() {
    var product = products.find(function (item) { return inboundProductLabel(item) === description.value; });
    var original = rows[editIndex];
    if (!product && original && inboundProductLabel(original) === description.value) product = original;
    form.elements.sku.value = product ? normSku(product.sku) : '';
    form.elements.barcode.value = product ? normBarcode(product.barcode) : '';
    return product;
  }

  function paintRows() {
    section.querySelector('#inbound-register-rows').innerHTML = rows.length ?
      rows.slice().reverse().map(function (row, reversedIndex) {
        var index = rows.length - 1 - reversedIndex;
        return '<tr>' + inboundRegisterColumns.map(function (column) {
          return '<td>' + esc(row[column[0]]) + '</td>';
        }).join('') + '<td><button class="btn btn-sm" type="button" data-edit-surat-jalan="' + index +
          '">Edit</button> <button class="btn btn-sm btn-danger" type="button" data-delete-surat-jalan="' + index +
          '">Hapus</button></td></tr>';
      }).join('') : '<tr><td colspan="11" class="muted">Belum ada surat jalan.</td></tr>';
  }

  function refreshRegister() {
    renderApp();
    var register = root.querySelector('#inbound-register');
    if (!register) return null;
    register.open = true;
    return register.querySelector('form');
  }

  function getCurrentRows(index) {
    if (getEffectiveRole() === 'stockkeeper' || appState.W.cur !== warehouseId) return null;
    var currentRows = safeGet(key, []).slice();
    if (index !== null && (!currentRows[index] || JSON.stringify(currentRows[index]) !== JSON.stringify(rows[index]))) {
      showToast('Riwayat berubah di tab lain. Pilih ulang baris yang mau diubah.', 'warn');
      refreshRegister();
      return null;
    }
    return currentRows;
  }

  cancelEdit.addEventListener('click', function () {
    editIndex = null;
    form.reset();
    submitButton.textContent = 'Simpan Surat Jalan';
    cancelEdit.hidden = true;
  });

  section.querySelector('#inbound-register-rows').addEventListener('click', function (event) {
    var button = event.target.closest('[data-edit-surat-jalan], [data-delete-surat-jalan]');
    if (!button) return;
    var editing = button.hasAttribute('data-edit-surat-jalan');
    var index = Number(button.getAttribute(editing ? 'data-edit-surat-jalan' : 'data-delete-surat-jalan'));
    var currentRows = getCurrentRows(index);
    if (!currentRows) return;
    var row = currentRows[index];
    if (editing) {
      editIndex = index;
      var supplier = (form as any).elements.supplier as HTMLSelectElement;
      if (!Array.from(supplier.options).some(function (option) { return option.value === row.supplier; })) {
        supplier.add(new Option(row.supplier, row.supplier));
      }
      ['tgl', 'supplier', 'driver', 'noPlat', 'noDoc', 'qty'].forEach(function (field) {
        form.elements[field].value = row[field] ?? '';
      });
      description.value = inboundProductLabel(row);
      fillInboundProduct();
      submitButton.textContent = 'Simpan Perubahan';
      cancelEdit.hidden = false;
      form.scrollIntoView({ block: 'nearest' });
      form.elements.qty.focus();
      return;
    }
    confirmDialog('Hapus Baris Surat Jalan',
      '<p>Hapus <strong>' + esc(row.nama) + '</strong> dari surat jalan <strong>' + esc(row.noDoc) + '</strong>?</p>',
      function () {
        var latest = getCurrentRows(index);
        if (!latest) return;
        latest.splice(index, 1);
        if (!safeSet(key, latest)) return;
        safeSet(whPrefix(warehouseId) + 'updatedAt', Date.now());
        scheduleSharedSyncPush();
        refreshRegister();
        showToast('Baris Surat Jalan dihapus', 'ok');
      }, true);
  });

  description.addEventListener('input', fillInboundProduct);
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (getEffectiveRole() === 'stockkeeper' || appState.W.cur !== warehouseId) return;
    var product = fillInboundProduct();
    if (!product) {
      showToast('Pilih Nama Barang dari Master Barang', 'warn');
      description.focus();
      return;
    }
    var row: Record<string, any> = Object.fromEntries(new FormData(form).entries());
    ['supplier', 'driver', 'noPlat', 'noDoc'].forEach(function (field) {
      row[field] = String(row[field] || '').trim();
    });
    if (!row.supplier || !row.driver || !row.noPlat || !row.noDoc) {
      showToast('Lengkapi Supplier, Driver, No Plat, dan No Doc', 'warn');
      return;
    }
    row.nama = product.nama;
    row.qty = Number(row.qty);
    var nextRows = getCurrentRows(editIndex);
    if (!nextRows) return;
    row.id = editIndex === null ? uid() : (nextRows[editIndex].id || uid());
    if (editIndex === null) nextRows.push(row);
    else nextRows[editIndex] = { ...nextRows[editIndex], ...row };
    if (!safeSet(key, nextRows)) return;
    safeSet(whPrefix(warehouseId) + 'updatedAt', Date.now());
    scheduleSharedSyncPush();
    var updatedForm = refreshRegister();
    if (!updatedForm) return;
    ['tgl', 'supplier', 'driver', 'noPlat', 'noDoc'].forEach(function (field) {
      updatedForm.elements[field].value = row[field];
    });
    updatedForm.elements.nama.focus();
    showToast('Surat Jalan disimpan', 'ok');
  });
  section.querySelector('#copy-inbound-register').addEventListener('click', function () {
    openCopyTSV('Salin Register Surat Jalan', inboundRegisterColumns.map(function (column) {
      return column[1];
    }), rows.map(function (row) {
      return inboundRegisterColumns.map(function (column) { return row[column[0]]; });
    }));
  });
  paintRows();
}
