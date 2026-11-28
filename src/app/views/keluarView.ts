import { isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { buildFefoLocationSuggestions, computeStockForMode, computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku, validateKeluarItem } from '../core/stockEngine.ts';
import { curData, getWhMeta, saveRegistry, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { buildKeluarWhatsappSlip, openWhatsappSlipModal, removeTxSafely } from '../services/transactionService.ts';
import { exportFilteredOutboundExcel } from '../services/xlsxService.ts';
import { SOUND_KEY, appState, renderApp, safeSet } from '../state/store.ts';
import { openBulkTxModal } from '../ui/bulkTxModal.ts';
import { confirmDialog, iconSvg, openCopyTSV, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { getEffectiveRole } from '../ui/rbac.ts';
import { classifyExpiry, esc, fmtNum, getPeriodFileSlug, getPeriodLabel, matchesDatePeriod, normBarcode, normLoc, normSku, parseExpDate, parseQty, stockKey, todayISO, uid } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 3: BARANG KELUAR (STOCKKEEPER & ADMIN ANCANTHO) ===
export function renderKeluar(root, d, an) {
  var locSet = new Set(d.lokasi.map(normLoc));
  an.rows.forEach(function (r) { if (r.qty > 0) locSet.add(r.lok); });
  var sortedLocs = Array.from(locSet).sort();
  var locOpts = sortedLocs.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
  var bcOpts = d.master.map(function (m) { return '<option value="' + esc(m.barcode) + '">' + esc(m.sku + ' — ' + m.nama) + '</option>'; }).join('');
  var expMonths = Number(d.expMonths || 7);

  var allKeluar = (d.keluar || []).slice().reverse();
  var pendingCount = allKeluar.filter(function (r) { return !isMasukAncanthoDone(r); }).length;
  var doneCount = allKeluar.length - pendingCount;
  var isSkOut = getEffectiveRole() === 'stockkeeper';
  if (isSkOut) appState.keluarRole = 'stockkeeper';

  var roleSwitcher = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
    (isSkOut ? '' : (
      '<div class="seg-group" role="tablist" aria-label="Peran Barang Keluar">' +
      '<button type="button" class="seg-btn' + (appState.keluarRole === 'stockkeeper' ? ' active' : '') + '" data-keluar-role="stockkeeper">Stockkeeper (Input)</button>' +
      '<button type="button" class="seg-btn' + (appState.keluarRole === 'admin' ? ' active' : '') + '" data-keluar-role="admin">Admin Ancantho' + (pendingCount > 0 ? ' (' + pendingCount + ')' : '') + '</button>' +
      '</div>'
    )) +
    '<button type="button" class="btn btn-primary btn-sm" id="open-bulk-keluar-btn">' + iconSvg('table') + '<span>Bulk Keluar</span></button>' +
    '<button type="button" class="btn btn-wa btn-sm" id="keluar-wa-btn">' + iconSvg('whatsapp') + '<span>Slip WA</span></button>' +
    '</div>';

  var html = pageHeaderHtml(
    'Barang Keluar',
    appState.keluarRole === 'stockkeeper'
      ? 'Ketik lokasi, pilih barang yang tersedia, lalu isi jumlah yang mau dikeluarkan.'
      : 'Antrean Admin untuk memproses data keluar Stockkeeper ke sistem Ancantho sesuai lokasi, isi admin & keterangan, lalu Submit Done.',
    roleSwitcher
  );

  var q = appState.searchState.keluar.trim().toUpperCase();
  var keluarPeriodLabel = getPeriodLabel(appState.keluarPeriod, appState.keluarFrom, appState.keluarTo);
  var keluarToolbarControls =
    '<select id="keluar-period-filt" class="input filter-select" aria-label="Filter Periode Barang Keluar">' +
    '<option value="all"' + (appState.keluarPeriod === 'all' ? ' selected' : '') + '>Semua Waktu</option>' +
    '<option value="month"' + (appState.keluarPeriod === 'month' ? ' selected' : '') + '>Bulan Ini</option>' +
    '<option value="today"' + (appState.keluarPeriod === 'today' ? ' selected' : '') + '>Hari Ini</option>' +
    '<option value="week"' + (appState.keluarPeriod === 'week' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
    '<option value="prev_month"' + (appState.keluarPeriod === 'prev_month' ? ' selected' : '') + '>Bulan Lalu</option>' +
    '<option value="custom"' + (appState.keluarPeriod === 'custom' ? ' selected' : '') + '>Rentang Tanggal</option>' +
    '</select>' +
    (appState.keluarPeriod === 'custom'
      ? '<input id="keluar-from" type="date" class="input filter-date" value="' + esc(appState.keluarFrom || '') + '" aria-label="Dari tanggal" />' +
        '<input id="keluar-to" type="date" class="input filter-date" value="' + esc(appState.keluarTo || '') + '" aria-label="Sampai tanggal" />'
      : '') +
    '<button type="button" class="btn btn-primary btn-sm" id="keluar-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>';
  var activeFilteredKeluar: any[] = [];

  if (appState.keluarRole === 'stockkeeper') {
    var pre = window.__keluarPrefill || null;
    window.__keluarPrefill = null;

    var editItem = appState.keluarEditId ? (d.keluar || []).find(function (x) { return x.id === appState.keluarEditId; }) : null;
    if (editItem && isSkOut && isMasukAncanthoDone(editItem)) editItem = null;
    if (appState.keluarEditId && !editItem) appState.keluarEditId = '';

    var defaultSk = editItem ? (editItem.by || '') : (appState.keluarStockkeeperName || appState.masukStockkeeperName || appState.W.user || '');
    var defaultBc = editItem ? (editItem.barcode || editItem.sku || '') : (pre ? (pre.barcode || pre.sku || '') : '');
    var defaultLok = editItem ? (editItem.lok || '') : (pre && pre.lok ? normLoc(pre.lok) : (appState.scanPref.lockLoc ? appState.scanPref.lastLoc : ''));
    var defaultExp = editItem ? (editItem.exp || '') : (pre && pre.exp ? pre.exp : '');
    var defaultQty = editItem ? String(editItem.qty || '') : (pre && pre.qty ? String(pre.qty) : '');
    var latestRow = isSkOut ? allKeluar.find(function (r) { return !isMasukAncanthoDone(r); }) : (allKeluar[0] || null);
    var rapidOutRow = (!editItem && appState.lastRapidKeluarId)
      ? (d.keluar || []).find(function (x) { return x.id === appState.lastRapidKeluarId && !isMasukAncanthoDone(x); })
      : null;

    html += '<div class="card' + (editItem ? ' masuk-edit-card' : '') + '">' +
      '<div class="card-header">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<h2 class="card-title">' + (editItem ? 'Edit Barang Keluar Sebelumnya' : 'Input Stockkeeper') + '</h2>' +
      (editItem ? '<span class="badge badge-warn">Sedang Edit (' + esc(editItem.tgl || '-') + ')</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      (!editItem && latestRow ? '<button type="button" class="btn btn-sm" id="out-edit-last-btn">Edit Input Terakhir</button>' : '') +
      (!editItem ? '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;cursor:pointer"><input id="out-rapid-scan" type="checkbox"' + (appState.rapidScanKeluar ? ' checked' : '') + ' /> Scan Beruntun (+1)</label>' : '') +
      '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;cursor:pointer"><input id="out-lock-loc" type="checkbox"' + (appState.scanPref.lockLoc ? ' checked' : '') + ' /> Kunci Lokasi</label>' +
      '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;cursor:pointer"><input id="out-sound-chk" type="checkbox"' + (appState.soundEnabled ? ' checked' : '') + ' /> Beep</label>' +
      '</div></div>' +
      '<form id="form-keluar" class="form-grid">' +
      '<div class="field"><label for="out-sk-name">Nama Stockkeeper</label><input id="out-sk-name" type="text" class="input" value="' + esc(defaultSk) + '" placeholder="Mis. Sari / Budi" required /></div>' +
      '<div class="field"><label for="out-lok">Lokasi</label><input id="out-lok" type="text" class="input" list="dl-keluar-lokasi" value="' + esc(defaultLok) + '" autocapitalize="characters" enterkeyhint="next" placeholder="Contoh: RAK-A1" autocomplete="off" required /><div id="out-loc-chips" class="fefo-chip-row"></div></div>' +
      '<div class="field span-2"><label for="out-product">Barang di lokasi</label><select id="out-product" class="input" aria-describedby="out-product-status"></select>' +
      '<div id="out-product-status" class="muted" style="font-size:12px;margin-top:4px" aria-live="polite"></div></div>' +
      '<div class="field"><label for="out-sku">SKU</label><input id="out-sku" class="input mono" readonly /></div>' +
      '<div class="field span-2"><label for="out-bc">Barcode</label><div class="scan-row"><input id="out-bc" type="text" class="input mono" list="dl-keluar-bc" value="' + esc(defaultBc) + '" placeholder="Scan / ketik barcode produk…" autocapitalize="characters" enterkeyhint="next" autocomplete="off" /><button type="button" class="btn" id="out-cam-btn" title="Scan dengan kamera HP">Kamera</button></div><div id="out-prod-preview" class="muted" style="font-size:12px;margin-top:4px"></div></div>' +
      '<div class="field"><label for="out-exp">Expiry Date</label><input id="out-exp" type="date" class="input" value="' + esc(defaultExp) + '" /></div>' +
      '<div class="field"><label for="out-qty">Qty</label><input id="out-qty" type="text" inputmode="decimal" enterkeyhint="done" class="input num" value="' + esc(defaultQty) + '" placeholder="0" required /></div>' +
      '<div class="field"><div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="submit" class="btn btn-primary">' + (editItem ? 'Simpan Perubahan' : 'Simpan Barang Keluar') + '</button>' +
      (editItem ? '<button type="button" class="btn" id="out-cancel-edit-btn">Batal</button>' : '') +
      '</div></div>' +
      '</form>' +
      '<datalist id="dl-keluar-lokasi">' + locOpts + '</datalist>' +
      '<datalist id="dl-keluar-bc">' + bcOpts + '</datalist>' +
      (rapidOutRow ? (
        '<div class="rapid-strip">' +
        '<div class="rapid-strip-info"><strong>Scan Beruntun Aktif:</strong> ' + esc(rapidOutRow.nama || rapidOutRow.sku) + ' · <span class="masuk-loc-pill">' + esc(rapidOutRow.lok) + '</span> · Keluar saat ini <strong class="num">-' + fmtNum(rapidOutRow.qty) + ' PCS</strong></div>' +
        '<div class="rapid-strip-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" data-rapid-out="1">+1</button>' +
        '<button type="button" class="btn btn-sm" data-rapid-out="5">+5</button>' +
        '<button type="button" class="btn btn-sm" data-rapid-out="-1">Undo -1</button>' +
        '</div></div>'
      ) : '') +
      '<div id="out-live-status"></div>' +
      '</div>';

    var rowsSk = allKeluar.filter(function (r) {
      if (!matchesDatePeriod(r.tgl, appState.keluarPeriod, appState.keluarFrom, appState.keluarTo)) return false;
      if (!q) return true;
      return [r.tgl, r.by, r.barcode, r.sku, r.nama, r.lok, r.exp, r.ancanthoBy, r.ancanthoKet].join(' ').toUpperCase().indexOf(q) >= 0;
    });
    activeFilteredKeluar = rowsSk;
    var shownSk = rowsSk.slice(0, 100);

    html += '<div class="card"><div class="card-header"><h2 class="card-title">Riwayat Input Stockkeeper</h2><span class="muted" style="font-size:12px">Klik Edit jika ada salah input (' + shownSk.length + '/' + rowsSk.length + ' baris · ' + esc(keluarPeriodLabel) + ')</span></div>' +
      '<div class="toolbar">' +
      '<div class="search-wrap"><input id="search-keluar" type="search" class="input" placeholder="Cari stockkeeper, barcode, produk, lokasi…" value="' + esc(appState.searchState.keluar) + '" /><span class="search-kbd">/</span></div>' +
      keluarToolbarControls +
      '<button type="button" class="btn btn-sm" id="copy-keluar-btn">Salin ke Sheets</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Stockkeeper</th><th>Barcode / Produk</th><th>Lokasi</th><th>Expiry Date</th><th class="right">Qty</th><th>Status Validasi</th><th>Status Ancantho</th><th class="right">Aksi</th></tr></thead><tbody>';

    if (shownSk.length === 0) {
      html += '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Belum ada data input barang keluar.</td></tr>';
    } else {
      shownSk.forEach(function (r) {
        var st = validateKeluarItem(r, d, an.stockMap, false);
        var isDone = isMasukAncanthoDone(r);
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
          '<td class="right num"><strong>-' + fmtNum(r.qty) + '</strong></td>' +
          '<td><span class="badge badge-' + st.cls + '">' + esc(st.text) + '</span></td>' +
          '<td>' + (isDone
            ? '<span class="badge badge-ok">✓ Done Transfer</span>' + (r.ancanthoBy ? '<div class="muted" style="font-size:11px;margin-top:2px">' + esc(r.ancanthoBy) + '</div>' : '')
            : isSkOut
              ? '<span class="badge badge-warn">Menunggu Admin</span>'
              : '<button type="button" class="btn btn-primary btn-sm" data-keluar-done="' + esc(r.id) + '">Done Transfer</button>') + '</td>' +
          '<td class="right" style="white-space:nowrap">' +
          ((isSkOut && isDone)
            ? '<span class="muted" style="font-size:11.5px">Terkunci</span>'
            : ('<button type="button" class="btn btn-sm" data-edit-keluar="' + esc(r.id) + '">Edit</button> ' +
              '<button type="button" class="btn btn-sm btn-danger" data-del-keluar="' + esc(r.id) + '">Hapus</button>')) +
          '</td></tr>';
      });
    }
    html += '</tbody></table></div></div>';

    root.innerHTML = html;

    var skNameEl = byId('out-sk-name');
    var bcEl = byId('out-bc');
    var lokEl = byId('out-lok');
    var productEl = byId('out-product');
    var productStatusEl = byId('out-product-status');
    var skuEl = byId('out-sku');
    var locationProducts = [];
    var selectedProduct = null;
    var expEl = byId('out-exp');
    var qtyEl = byId('out-qty');
    var prodPrevEl = byId('out-prod-preview');
    var locChipsEl = byId('out-loc-chips');
    var liveEl = byId('out-live-status');
    var lockChk = byId('out-lock-loc');
    var soundChk = byId('out-sound-chk');

    skNameEl.addEventListener('input', function () {
      if (!editItem) appState.keluarStockkeeperName = skNameEl.value;
    });
    lockChk.addEventListener('change', function () {
      appState.scanPref.lockLoc = lockChk.checked;
      appState.scanPref.lastLoc = normLoc(lokEl.value);
    });
    soundChk.addEventListener('change', function () {
      appState.soundEnabled = soundChk.checked;
      safeSet(SOUND_KEY, appState.soundEnabled);
    });

    function buildEffectiveStockMap(data, stockMap) {
      var currentEdit = editItem && (data.keluar || []).find(function (row) { return row.id === editItem.id; });
      if (!currentEdit || !currentEdit.tgl || (data.cutoff && currentEdit.tgl < data.cutoff) ||
          (data.mode === 'all' && currentEdit.n !== 1)) return stockMap;
      var copy = Object.assign(Object.create(null), stockMap);
      var oldKey = stockKey(currentEdit.lok, currentEdit.sku, currentEdit.barcode);
      if (copy[oldKey]) {
        copy[oldKey] = Object.assign({}, copy[oldKey], {
          qty: Number(copy[oldKey].qty || 0) + Number(currentEdit.qty || 0)
        });
      } else if (currentEdit.lok && currentEdit.sku) {
        copy[oldKey] = {
          key: oldKey,
          lok: normLoc(currentEdit.lok),
          barcode: normBarcode(currentEdit.barcode),
          sku: normSku(currentEdit.sku),
          nama: currentEdit.nama || '',
          qty: Number(currentEdit.qty || 0)
        };
      }
      return copy;
    }

    function resolveProductByInput(rawCode) {
      if (selectedProduct) return selectedProduct;
      var b = normBarcode(rawCode);
      if (!b) return null;
      var mf = findMasterByBarcode(d.master, b) || findMasterBySku(d.master, b);
      if (mf) return { barcode: normBarcode(mf.barcode || b), sku: normSku(mf.sku), nama: String(mf.nama || '').trim(), fromMaster: true };
      var stk = an.rows.find(function (r) { return normBarcode(r.barcode) === b || normSku(r.sku) === normSku(b); });
      if (stk) return { barcode: normBarcode(stk.barcode || b), sku: normSku(stk.sku), nama: String(stk.nama || '').trim(), fromMaster: false };
      return { barcode: b, sku: normSku(b), nama: '', fromMaster: false };
    }

    var availableStock = Object.values(buildEffectiveStockMap(d, an.stockMap)) as Record<string, any>[];

    function syncLocationProducts(autoSelect) {
      var location = normLoc(lokEl.value);
      locationProducts = location ? availableStock.filter(function (row) {
        return row.lok === location && row.qty > 0;
      }).sort(function (first, second) {
        return (first.nama || first.sku).localeCompare(second.nama || second.sku) ||
          first.sku.localeCompare(second.sku) || first.barcode.localeCompare(second.barcode);
      }) : [];
      productEl.innerHTML = '<option value="">Pilih barang</option>' + locationProducts.map(function (row, index) {
        var barcode = row.barcode ? ' · Barcode ' + row.barcode : '';
        return '<option value="' + index + '">' + esc((row.nama || row.sku) +
          ' · SKU ' + row.sku + barcode + ' · ' + fmtNum(row.qty) + ' PCS') + '</option>';
      }).join('');
      productEl.disabled = !locationProducts.length;
      productStatusEl.textContent = !location ? 'Isi lokasi untuk melihat daftar barang.' :
        !locationProducts.length ? 'Tidak ada stok tersedia di lokasi ini.' : '';

      var product = resolveProductByInput(bcEl.value);
      var index = product ? locationProducts.findIndex(function (row) {
        return row.sku === product.sku && row.barcode === product.barcode;
      }) : -1;
      if (index < 0 && autoSelect && !product && locationProducts.length === 1) {
        selectLocationProduct(locationProducts[0]);
        index = 0;
      }
      productEl.value = index < 0 ? '' : String(index);
    }

    function selectLocationProduct(product) {
      selectedProduct = product || null;
      bcEl.value = product ? product.barcode : '';
      expEl.value = '';
      if (!product) return;
      var location = normLoc(lokEl.value);
      var batch = (an.batchRows || []).filter(function (row) {
        return normLoc(row.lok) === location && normSku(row.sku) === product.sku && row.qty > 0 && row.exp &&
          (!product.barcode || normBarcode(row.barcode) === product.barcode);
      }).sort(function (first, second) { return first.exp.localeCompare(second.exp); })[0];
      if (batch) expEl.value = batch.exp;
    }

    productEl.addEventListener('change', function () {
      selectLocationProduct(productEl.value === '' ? null : locationProducts[Number(productEl.value)]);
      updateLiveStatus();
    });

    var rapidOutChk = byId('out-rapid-scan');
    if (rapidOutChk) {
      rapidOutChk.addEventListener('change', function () {
        appState.rapidScanKeluar = rapidOutChk.checked;
        showToast(appState.rapidScanKeluar ? 'Mode Scan Beruntun (+1 otomatis) aktif' : 'Mode Scan Beruntun dimatikan');
      });
    }

    function updateLiveStatus() {
      var b = normBarcode(bcEl.value);
      var lok = normLoc(lokEl.value);
      var prod = resolveProductByInput(b);
      skuEl.value = prod ? prod.sku : '';
      var fefoHtml = '';

      if (prod) {
        prodPrevEl.innerHTML = (prod.nama ? 'Produk: <strong>' + esc(prod.nama) + '</strong> · ' : '') + 'SKU <span class="mono">' + esc(prod.sku) + '</span>';
        var fefoSuggestions = buildFefoLocationSuggestions(prod.sku, prod.barcode, d, an);
        if (fefoSuggestions.length > 0) {
          locChipsEl.innerHTML = fefoSuggestions.slice(0, 6).map(function (m, idx) {
            var expTag = m.exp ? (' · Exp ' + m.exp) : '';
            return '<button type="button" class="fefo-chip' + (idx === 0 ? ' top' : '') + '" data-pick-out-loc="' + esc(m.lok) + '" data-pick-out-exp="' + esc(m.exp || '') + '">' +
              (idx === 0 ? 'FEFO #1 · ' : '') + esc(m.lok) + esc(expTag) + ' (' + fmtNum(m.qty) + ')</button>';
          }).join('');
          locChipsEl.querySelectorAll('[data-pick-out-loc]').forEach(function (chip) {
            chip.addEventListener('click', function () {
              lokEl.value = chip.getAttribute('data-pick-out-loc');
              var chipExp = chip.getAttribute('data-pick-out-exp') || '';
              expEl.value = chipExp;
              syncLocationProducts(false);
              if (appState.scanPref.lockLoc) appState.scanPref.lastLoc = normLoc(lokEl.value);
              updateLiveStatus();
              qtyEl.focus();
            });
          });
        } else {
          locChipsEl.innerHTML = '';
        }
        var fefo = an.skuExpMap[normSku(prod.sku)];
        if (fefo && fefo.expInfo && fefo.expInfo.isAlert) {
          fefoHtml = '<div class="inline-alert ' + (fefo.expInfo.status === 'warn' ? 'warn' : 'err') + '" style="margin-top:8px">' +
            '⏰ <strong>Prioritas FEFO / Expire:</strong> Batch terdekat <strong>' + esc(fefo.batch || '-') + '</strong> Exp <strong>' + esc(fefo.exp) + '</strong> (' + esc(fefo.expInfo.label) + ', sisa ' + fmtNum(fefo.qty) + ' PCS' + (fefo.lok ? ' di ' + esc(fefo.lok) : '') + ').' +
            '</div>';
        }
      } else {
        prodPrevEl.innerHTML = '';
        locChipsEl.innerHTML = '';
      }

      var ev = parseExpDate(expEl.value);
      var expInfoHtml = '';
      if (ev) {
        var ei = classifyExpiry(ev, expMonths);
        if (ei.isAlert) {
          expInfoHtml = '<div class="inline-alert ' + (ei.status === 'warn' ? 'warn' : 'err') + '" style="margin-top:8px">⚠️ Expire &lt; ' + expMonths + ' bulan: <strong>' + esc(ei.label) + '</strong> (' + esc(ev) + ').</div>';
        }
      }

      if (!lok || !prod) {
        liveEl.innerHTML = fefoHtml + expInfoHtml;
        return;
      }

      var effMap = buildEffectiveStockMap(d, an.stockMap);
      var draft = {
        tgl: editItem ? (editItem.tgl || todayISO()) : todayISO(),
        lok: lok,
        sku: prod.sku,
        barcode: prod.barcode,
        qty: parseQty(qtyEl.value)
      };
      var st = validateKeluarItem(draft, d, effMap, true);
      liveEl.innerHTML = '<div class="inline-alert ' + (st.cls === 'neutral' ? 'info' : st.cls) + '">' + esc(st.text) + '</div>' + fefoHtml + expInfoHtml;
    }

    function executeRapidScanKeluar() {
      var skName = String(skNameEl.value || '').trim() || appState.keluarStockkeeperName || appState.masukStockkeeperName || appState.W.user || 'Stockkeeper';
      var prod = resolveProductByInput(bcEl.value);
      if (!prod || !prod.barcode) { playBeep(false); showToast('Scan / isi barcode dulu', 'warn'); return; }
      var suggestions = buildFefoLocationSuggestions(prod.sku, prod.barcode, d, an);
      var lok = normLoc(lokEl.value) || (suggestions[0] ? suggestions[0].lok : '') || (appState.scanPref.lockLoc ? normLoc(appState.scanPref.lastLoc) : '');
      if (!lok) {
        playBeep(false);
        showToast('Stok lokasi tidak ditemukan — pilih Lokasi secara manual', 'warn');
        lokEl.focus();
        return;
      }
      lokEl.value = lok;
      var exp = parseExpDate(expEl.value) || (suggestions[0] && suggestions[0].lok === lok ? suggestions[0].exp : '');
      if (exp) expEl.value = exp;
      var tgl = todayISO();
      var dNow = curData();
      var curAn = computeWarehouseAnalysis(dNow);
      var check = validateKeluarItem({ tgl: tgl, lok: lok, sku: prod.sku, barcode: prod.barcode, qty: 1 }, dNow, curAn.stockMap, true);
      if (!check.ok) {
        playBeep(false);
        showToast('Tidak dapat rapid +1: ' + check.text, 'err');
        updateLiveStatus();
        return;
      }
      appState.keluarStockkeeperName = skName;
      appState.W.user = skName;
      saveRegistry();

      var existing = null;
      for (var i = dNow.keluar.length - 1; i >= 0; i--) {
        var item = dNow.keluar[i];
        if (isMasukAncanthoDone(item)) continue;
        if (item.tgl !== tgl || normLoc(item.lok) !== lok) continue;
        var sameProd = normBarcode(item.barcode) === prod.barcode || (prod.sku !== '5000054' && normSku(item.sku) === prod.sku);
        if (!sameProd) continue;
        existing = item;
        break;
      }

      if (existing) {
        existing.qty = Number(existing.qty || 0) + 1;
        appState.lastRapidKeluarId = existing.id;
        writeWarehouseData(appState.W.cur, dNow);
        playBeep(true);
        showToast('-1 ' + (existing.nama || existing.sku) + ' dari ' + lok + ' (Keluar: ' + fmtNum(existing.qty) + ')', 'ok');
      } else {
        var newId = uid();
        dNow.keluar.push({
          id: newId,
          tgl: tgl,
          barcode: prod.barcode,
          sku: prod.sku,
          nama: prod.nama,
          lok: lok,
          qty: 1,
          exp: exp,
          ket: '',
          by: skName,
          n: 1,
          ancanthoDone: false,
          ancanthoBy: '',
          ancanthoKet: '',
          ancanthoAt: ''
        });
        appState.lastRapidKeluarId = newId;
        writeWarehouseData(appState.W.cur, dNow);
        playBeep(true);
        showToast('Keluar baru: ' + (prod.nama || prod.sku) + ' -1 dari ' + lok, 'ok');
      }
      renderApp();
      setTimeout(function () {
        var nextBc = byId('out-bc');
        if (nextBc) { nextBc.value = ''; nextBc.focus(); }
      }, 20);
    }

    function handleBarcodeScanComplete() {
      var prod = resolveProductByInput(bcEl.value);
      var suggestions = prod ? buildFefoLocationSuggestions(prod.sku, prod.barcode, d, an) : [];
      if (prod && !normLoc(lokEl.value) && suggestions.length > 0) {
        lokEl.value = suggestions[0].lok;
      }
      if (prod && !expEl.value) {
        if (suggestions[0] && suggestions[0].exp) expEl.value = suggestions[0].exp;
        else {
          var fefo = an.skuExpMap[normSku(prod.sku)];
          if (fefo && fefo.exp) expEl.value = fefo.exp;
        }
      }
      syncLocationProducts(false);
      if (appState.rapidScanKeluar && !editItem) {
        executeRapidScanKeluar();
        return;
      }
      updateLiveStatus();
      if (prod && prod.nama) playBeep(true); else playBeep(false);
      if (normLoc(lokEl.value)) qtyEl.focus();
      else lokEl.focus();
    }

    if (editItem || pre) {
      var prefilled = editItem || pre;
      selectedProduct = {
        lok: normLoc(prefilled.lok),
        barcode: normBarcode(prefilled.barcode),
        sku: normSku(prefilled.sku),
        nama: prefilled.nama || (resolveProductByInput(bcEl.value) || {}).nama || ''
      };
      bcEl.value = selectedProduct.barcode;
    }
    syncLocationProducts(true);
    updateLiveStatus();

    root.querySelectorAll('[data-rapid-out]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var delta = Number(btn.getAttribute('data-rapid-out') || 0);
        if (!appState.lastRapidKeluarId || !delta) return;
        var dNow = curData();
        var target = (dNow.keluar || []).find(function (x) { return x.id === appState.lastRapidKeluarId; });
        if (!target) return;
        var nextQty = Number(target.qty || 0) + delta;
        if (nextQty <= 0) {
          dNow.keluar = (dNow.keluar || []).filter(function (x) { return x.id !== target.id; });
          appState.lastRapidKeluarId = '';
          writeWarehouseData(appState.W.cur, dNow);
          showToast('Baris rapid scan keluar dibatalkan', 'ok');
        } else {
          if (delta > 0) {
            var curAn = computeWarehouseAnalysis(dNow);
            var chk = validateKeluarItem({ tgl: target.tgl, lok: target.lok, sku: target.sku, barcode: target.barcode, qty: delta }, dNow, curAn.stockMap, true);
            if (!chk.ok) {
              playBeep(false);
              showToast('Stok tidak cukup untuk +' + delta + ': ' + chk.text, 'err');
              return;
            }
          }
          target.qty = nextQty;
          writeWarehouseData(appState.W.cur, dNow);
          playBeep(true);
          showToast((delta > 0 ? '+' : '') + delta + ' -> ' + (target.nama || target.sku) + ': -' + fmtNum(nextQty) + ' PCS', 'ok');
        }
        renderApp();
        setTimeout(function () {
          var nextBc = byId('out-bc');
          if (nextBc) nextBc.focus();
        }, 20);
      });
    });

    byId('out-cam-btn').addEventListener('click', function () {
      openCameraScanner(function (code) {
        selectedProduct = null;
        bcEl.value = code;
        expEl.value = '';
        handleBarcodeScanComplete();
      });
    });

    bcEl.addEventListener('input', function () {
      selectedProduct = null;
      expEl.value = '';
      syncLocationProducts(false);
      updateLiveStatus();
    });
    lokEl.addEventListener('input', function () {
      if (selectedProduct && normLoc(lokEl.value) !== selectedProduct.lok) {
        selectLocationProduct(null);
      }
      syncLocationProducts(true);
      updateLiveStatus();
    });
    qtyEl.addEventListener('input', updateLiveStatus);
    expEl.addEventListener('change', updateLiveStatus);
    expEl.addEventListener('input', updateLiveStatus);

    bcEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleBarcodeScanComplete();
      }
    });
    lokEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!productEl.disabled && !resolveProductByInput(bcEl.value)) productEl.focus();
        else qtyEl.focus();
      }
    });
    qtyEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        byId('form-keluar').requestSubmit();
      }
    });

    var editLastBtn = byId('out-edit-last-btn');
    if (editLastBtn && latestRow) {
      editLastBtn.addEventListener('click', function () {
        appState.keluarEditId = latestRow.id;
        renderApp();
        setTimeout(function () {
          var qEl = byId('out-qty');
          if (qEl) { qEl.focus(); qEl.select(); }
        }, 20);
      });
    }

    var cancelEditBtn = byId('out-cancel-edit-btn');
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', function () {
        appState.keluarEditId = '';
        renderApp();
      });
    }

    byId('form-keluar').addEventListener('submit', function (e) {
      e.preventDefault();
      var skName = String(skNameEl.value || '').trim();
      var bc = normBarcode(bcEl.value);
      var lok = normLoc(lokEl.value);
      var exp = parseExpDate(expEl.value);
      var qty = parseQty(qtyEl.value);

      if (!skName) { playBeep(false); showToast('Nama Stockkeeper wajib diisi', 'warn'); skNameEl.focus(); return; }
      var prod = resolveProductByInput(bc);
      if (!prod || !prod.sku) {
        playBeep(false);
        showToast('Pilih barang di lokasi atau scan barcode', 'warn');
        (productEl.disabled ? bcEl : productEl).focus();
        return;
      }
      if (!lok) { playBeep(false); showToast('Lokasi wajib diisi', 'warn'); lokEl.focus(); return; }
      if (!(qty > 0)) { playBeep(false); showToast('Qty harus lebih dari 0', 'warn'); qtyEl.focus(); return; }

      appState.keluarStockkeeperName = skName;
      appState.W.user = skName;
      saveRegistry();
      if (appState.scanPref.lockLoc) appState.scanPref.lastLoc = lok;

      var dNow = curData();
      var realBc = prod.barcode;
      var sku = prod.sku;
      var nama = prod.nama;
      var tgl = editItem ? (editItem.tgl || todayISO()) : todayISO();

      var effMap = buildEffectiveStockMap(dNow, computeStockForMode(dNow));
      var check = validateKeluarItem({ tgl: tgl, lok: lok, sku: sku, barcode: realBc, qty: qty }, dNow, effMap, true);

      function commitOut() {
        var dSave = curData();
        if (editItem) {
          var idx = (dSave.keluar || []).findIndex(function (x) { return x.id === editItem.id; });
          if (idx >= 0) {
            var target = dSave.keluar[idx];
            target.by = skName;
            target.barcode = realBc;
            target.sku = sku;
            target.nama = nama;
            target.lok = lok;
            target.exp = exp;
            target.qty = qty;
            writeWarehouseData(appState.W.cur, dSave);
            appState.keluarEditId = '';
            playBeep(true);
            showToast('Perubahan barang keluar disimpan', 'ok');
            renderApp();
            return;
          }
        }

        var newOutId = uid();
        dSave.keluar.push({
          id: newOutId,
          tgl: tgl,
          barcode: realBc,
          sku: sku,
          nama: nama,
          lok: lok,
          qty: qty,
          exp: exp,
          ket: '',
          by: skName,
          n: 1,
          ancanthoDone: false,
          ancanthoBy: '',
          ancanthoKet: '',
          ancanthoAt: ''
        });
        appState.lastRapidKeluarId = newOutId;
        writeWarehouseData(appState.W.cur, dSave);
        playBeep(true);
        showToast('Barang keluar dicatat oleh ' + skName + ' (-' + fmtNum(qty) + ' PCS)', 'ok');
        renderApp();
        setTimeout(function () {
          var nextLoc = byId('out-lok');
          if (nextLoc) nextLoc.focus();
        }, 20);
      }

      if (!check.ok) {
        playBeep(false);
        confirmDialog(
          'Konfirmasi Simpan Barang Keluar',
          '<p style="margin:0">Validasi stok menunjukkan: <strong>' + esc(check.text) + '</strong>.<br/>Tetap simpan data barang keluar ini?</p>',
          commitOut,
          true
        );
      } else {
        commitOut();
      }
    });

    root.querySelectorAll('[data-keluar-done]').forEach(function (b) {
      b.addEventListener('click', function () {
        saveKeluarAdminRow(b.getAttribute('data-keluar-done'), true, false);
      });
    });

    root.querySelectorAll('[data-edit-keluar]').forEach(function (b) {
      b.addEventListener('click', function () {
        appState.keluarEditId = b.getAttribute('data-edit-keluar');
        renderApp();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(function () {
          var qEl = byId('out-qty');
          if (qEl) { qEl.focus(); qEl.select(); }
        }, 30);
      });
    });

    root.querySelectorAll('[data-del-keluar]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-del-keluar');
        if (appState.keluarEditId === id) appState.keluarEditId = '';
        if (appState.lastRapidKeluarId === id) appState.lastRapidKeluarId = '';
        removeTxSafely('keluar', id);
      });
    });
  } else {
    var activeAdminDefault = appState.keluarAdminName || appState.masukAdminName || appState.W.user || '';
    var pendingPcs = allKeluar.filter(function (r) { return !isMasukAncanthoDone(r); }).reduce(function (s, r) { return s + Number(r.qty || 0); }, 0);
    var donePcs = allKeluar.filter(function (r) { return isMasukAncanthoDone(r); }).reduce(function (s, r) { return s + Number(r.qty || 0); }, 0);

    html += '<div class="kpi-grid kpi-grid-2">' +
      '<div class="kpi-card ' + (pendingCount > 0 ? 'warn' : 'ok') + '"><div class="kpi-top"><div class="kpi-label">Menunggu Input ke Ancantho</div><div class="kpi-tag">Antrean Keluar</div></div><div class="kpi-value num">' + fmtNum(pendingCount) + ' baris</div><div class="kpi-sub">Total ' + fmtNum(pendingPcs) + ' PCS siap diproses sesuai lokasi Stockkeeper</div></div>' +
      '<div class="kpi-card ok"><div class="kpi-top"><div class="kpi-label">Sudah Done di Ancantho</div><div class="kpi-tag">Terverifikasi Admin</div></div><div class="kpi-value num">' + fmtNum(doneCount) + ' baris</div><div class="kpi-sub">Total ' + fmtNum(donePcs) + ' PCS sudah selesai diinput ke Ancantho</div></div>' +
      '</div>';

    var rowsAdmin = allKeluar.filter(function (r) {
      if (!matchesDatePeriod(r.tgl, appState.keluarPeriod, appState.keluarFrom, appState.keluarTo)) return false;
      var isDone = isMasukAncanthoDone(r);
      if (appState.keluarAdminFilter === 'pending' && isDone) return false;
      if (appState.keluarAdminFilter === 'done' && !isDone) return false;
      if (!q) return true;
      return [r.tgl, r.by, r.barcode, r.sku, r.nama, r.lok, r.exp, r.ancanthoBy, r.ancanthoKet].join(' ').toUpperCase().indexOf(q) >= 0;
    });
    activeFilteredKeluar = rowsAdmin;
    var shownAdmin = rowsAdmin.slice(0, 120);

    html += '<div class="card">' +
      '<div class="form-grid" style="margin-bottom:14px">' +
      '<div class="field span-2"><label for="out-admin-name">Nama Admin (Penginput Sistem Ancantho)</label><input id="out-admin-name" type="text" class="input" value="' + esc(activeAdminDefault) + '" placeholder="Mis. Siska / Admin Ancantho" /></div>' +
      '<div class="field span-2"><label>Filter Antrean Ancantho</label><div class="seg-group">' +
      '<button type="button" class="seg-btn' + (appState.keluarAdminFilter === 'pending' ? ' active' : '') + '" data-kadmin-filt="pending">Menunggu (' + pendingCount + ')</button>' +
      '<button type="button" class="seg-btn' + (appState.keluarAdminFilter === 'done' ? ' active' : '') + '" data-kadmin-filt="done">Sudah Done (' + doneCount + ')</button>' +
      '<button type="button" class="seg-btn' + (appState.keluarAdminFilter === 'all' ? ' active' : '') + '" data-kadmin-filt="all">Semua (' + allKeluar.length + ')</button>' +
      '</div></div></div>' +
      '<div class="toolbar">' +
      '<div class="search-wrap"><input id="search-keluar" type="search" class="input" placeholder="Cari stockkeeper, barcode, lokasi, admin, keterangan…" value="' + esc(appState.searchState.keluar) + '" /><span class="search-kbd">/</span></div>' +
      keluarToolbarControls +
      '<button type="button" class="btn btn-sm" id="copy-keluar-btn">Salin ke Sheets</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th style="width:44px;text-align:center">Done</th>' +
      '<th>Stockkeeper &amp; Tgl</th>' +
      '<th>Produk &amp; Expire</th>' +
      '<th>Lokasi Asal</th>' +
      '<th class="right">Qty</th>' +
      '<th style="min-width:140px">Admin Penginput</th>' +
      '<th style="min-width:190px">Keterangan Admin</th>' +
      '<th class="right">Aksi</th>' +
      '</tr></thead><tbody>';

    if (shownAdmin.length === 0) {
      html += '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">' +
        (appState.keluarAdminFilter === 'pending' ? 'Semua data barang keluar Stockkeeper sudah ditandai Done di Ancantho.' : 'Belum ada data yang sesuai filter.') +
        '</td></tr>';
    } else {
      shownAdmin.forEach(function (r) {
        var isDone = isMasukAncanthoDone(r);
        var st = validateKeluarItem(r, d, an.stockMap, false);
        var expBadge = '';
        if (r.exp) {
          var ei = classifyExpiry(r.exp, expMonths);
          expBadge = ' <span class="badge ' + ei.badgeCls + '">' + esc(ei.label) + '</span>';
        }
        var rowAdminVal = r.ancanthoBy || '';
        html += '<tr>' +
          '<td style="text-align:center"><input type="checkbox" class="masuk-chk" data-kadmin-chk="' + esc(r.id) + '"' + (isDone ? ' checked' : '') + ' aria-label="Tandai done keluar di Ancantho" /></td>' +
          '<td><div><strong>' + esc(r.by || '-') + '</strong></div><div class="muted num" style="font-size:11.5px">' + esc(r.tgl || '-') + '</div></td>' +
          '<td><div class="mono" style="font-size:12px">' + esc(r.barcode || r.sku || '-') + '</div><div style="font-size:12.5px">' + esc(r.nama || '-') + '</div>' + (r.exp ? '<div class="num" style="font-size:11.5px;margin-top:2px">Exp: ' + esc(r.exp) + expBadge + '</div>' : '') + '<div style="margin-top:3px"><span class="badge badge-' + st.cls + '">' + esc(st.text) + '</span></div></td>' +
          '<td><span class="masuk-loc-pill">' + esc(r.lok || '-') + '</span></td>' +
          '<td class="right num"><strong>-' + fmtNum(r.qty) + '</strong></td>' +
          '<td><input type="text" class="input masuk-admin-inp" data-kadmin-by="' + esc(r.id) + '" value="' + esc(rowAdminVal) + '" placeholder="' + esc(activeAdminDefault || 'Nama Admin') + '" /></td>' +
          '<td><input type="text" class="input masuk-admin-inp" data-kadmin-ket="' + esc(r.id) + '" value="' + esc(r.ancanthoKet || '') + '" placeholder="Keterangan proses Ancantho…" /></td>' +
          '<td class="right" style="white-space:nowrap">' +
          (isDone
            ? '<span class="badge badge-ok">✓ Done</span>' + (r.ancanthoAt ? '<div class="muted num" style="font-size:11px;margin:2px 0">' + esc(r.ancanthoAt) + '</div>' : '') + ' <button type="button" class="btn btn-sm" data-kadmin-undo="' + esc(r.id) + '">Batal</button>'
            : '<button type="button" class="btn btn-primary btn-sm" data-kadmin-submit="' + esc(r.id) + '">Submit Done</button>') +
          '</td></tr>';
      });
    }
    html += '</tbody></table></div></div>';

    root.innerHTML = html;

    var adminNameEl = byId('out-admin-name');
    adminNameEl.addEventListener('input', function () {
      appState.keluarAdminName = adminNameEl.value;
      var ph = appState.keluarAdminName.trim() || appState.masukAdminName.trim() || appState.W.user || 'Nama Admin';
      root.querySelectorAll('[data-kadmin-by]').forEach(function (el) {
        el.setAttribute('placeholder', ph);
      });
    });

    root.querySelectorAll('[data-kadmin-filt]').forEach(function (b) {
      b.addEventListener('click', function () {
        appState.keluarAdminFilter = b.getAttribute('data-kadmin-filt');
        renderApp();
      });
    });

    root.querySelectorAll('[data-kadmin-ket], [data-kadmin-by]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = inp.getAttribute('data-kadmin-ket') || inp.getAttribute('data-kadmin-by');
        saveKeluarAdminRow(id, false, true);
      });
    });

    root.querySelectorAll('[data-kadmin-chk]').forEach(function (chk) {
      chk.addEventListener('change', function () {
        saveKeluarAdminRow(chk.getAttribute('data-kadmin-chk'), chk.checked, false);
      });
    });

    root.querySelectorAll('[data-kadmin-submit]').forEach(function (b) {
      b.addEventListener('click', function () {
        saveKeluarAdminRow(b.getAttribute('data-kadmin-submit'), true, false);
      });
    });

    root.querySelectorAll('[data-kadmin-undo]').forEach(function (b) {
      b.addEventListener('click', function () {
        saveKeluarAdminRow(b.getAttribute('data-kadmin-undo'), false, false);
      });
    });
  }

  function saveKeluarAdminRow(id, nextDone, onlyUpdateFields) {
    if (getEffectiveRole() === 'stockkeeper') return;

    var safeId = CSS.escape(String(id || ''));
    var byInp = root.querySelector('[data-kadmin-by="' + safeId + '"]');
    var ketInp = root.querySelector('[data-kadmin-ket="' + safeId + '"]');
    var adminField = byId('out-admin-name');
    var cloudUser = window.__sgpCloud && window.__sgpCloud.getUser && window.__sgpCloud.getUser();
    var rowAdmin = byInp ? byInp.value.trim() : '';
    var adminWho = rowAdmin || (adminField ? adminField.value.trim() : '') ||
      (cloudUser && (cloudUser.displayName || cloudUser.email)) || appState.keluarAdminName || appState.masukAdminName || appState.W.user;

    if (nextDone && !adminWho) {
      showToast('Isi nama Admin penginput Ancantho terlebih dahulu', 'warn');
      if (byInp) byInp.focus();
      else if (adminField) adminField.focus();
      return;
    }

    var dNow = curData();
    var target = (dNow.keluar || []).find(function (x) { return x.id === id; });
    if (!target || (nextDone && isMasukAncanthoDone(target))) return;

    if (ketInp) target.ancanthoKet = ketInp.value.trim();
    if (onlyUpdateFields) {
      if (rowAdmin) target.ancanthoBy = rowAdmin;
    } else {
      target.ancanthoDone = nextDone;
      if (nextDone) {
        appState.keluarAdminName = adminWho;
        target.ancanthoBy = adminWho;
        var now = new Date();
        target.ancanthoAt = todayISO() + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      } else {
        target.ancanthoAt = '';
      }
    }

    writeWarehouseData(appState.W.cur, dNow);
    if (!onlyUpdateFields) {
      playBeep(true);
      showToast(nextDone ? ('Barang keluar ditandai Done Transfer oleh ' + adminWho) : 'Status dikembalikan ke Menunggu Ancantho', 'ok');
      renderApp();
    }
  }

  root.querySelectorAll('[data-keluar-role]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.keluarRole = b.getAttribute('data-keluar-role');
      renderApp();
    });
  });

  var bulkKeluarBtn = byId('open-bulk-keluar-btn');
  if (bulkKeluarBtn) {
    bulkKeluarBtn.addEventListener('click', function () {
      openBulkTxModal('keluar');
    });
  }

  var keluarWaBtn = byId('keluar-wa-btn');
  if (keluarWaBtn) {
    keluarWaBtn.addEventListener('click', function () {
      openWhatsappSlipModal(
        'Slip Barang Keluar — WhatsApp',
        'Ringkasan barang keluar hari ini & antrean Ancantho siap kirim via WhatsApp.',
        buildKeluarWhatsappSlip(curData())
      );
    });
  }

  var searchOut = byId('search-keluar');
  if (searchOut) {
    searchOut.addEventListener('input', function (e) {
      appState.searchState.keluar = targetEl(e).value;
      renderApp();
      var s = byId('search-keluar');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
  }

  var keluarPeriodEl = byId('keluar-period-filt') as HTMLSelectElement;
  if (keluarPeriodEl) {
    keluarPeriodEl.addEventListener('change', function () {
      appState.keluarPeriod = keluarPeriodEl.value || 'all';
      renderApp();
    });
  }
  var keluarFromEl = byId('keluar-from') as HTMLInputElement;
  if (keluarFromEl) {
    keluarFromEl.addEventListener('change', function () {
      appState.keluarFrom = keluarFromEl.value || '';
      renderApp();
    });
  }
  var keluarToEl = byId('keluar-to') as HTMLInputElement;
  if (keluarToEl) {
    keluarToEl.addEventListener('change', function () {
      appState.keluarTo = keluarToEl.value || '';
      renderApp();
    });
  }

  var keluarExportBtn = byId('keluar-export-xlsx-btn');
  if (keluarExportBtn) {
    keluarExportBtn.addEventListener('click', function () {
      exportFilteredOutboundExcel(
        getWhMeta(appState.W.cur).nama,
        d,
        an,
        activeFilteredKeluar,
        {
          label: keluarPeriodLabel,
          slug: getPeriodFileSlug(appState.keluarPeriod, appState.keluarFrom, appState.keluarTo)
        }
      );
    });
  }

  var copyBtn = byId('copy-keluar-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      openCopyTSV(
        'Salin Barang Keluar & Status Ancantho',
        ['Tanggal', 'Stockkeeper', 'Barcode', 'SKU', 'Nama Produk', 'Lokasi', 'Expiry Date', 'Qty', 'Status Validasi', 'Status Ancantho', 'Admin Ancantho', 'Keterangan Admin', 'Waktu Done'],
        activeFilteredKeluar.map(function (r) {
          var st = validateKeluarItem(r, d, an.stockMap, false);
          return [
            r.tgl,
            r.by || '',
            r.barcode,
            r.sku,
            r.nama,
            r.lok,
            r.exp || '',
            r.qty,
            st.text,
            isMasukAncanthoDone(r) ? 'DONE' : 'MENUNGGU',
            r.ancanthoBy || '',
            r.ancanthoKet || '',
            r.ancanthoAt || ''
          ];
        })
      );
    });
  }
}
