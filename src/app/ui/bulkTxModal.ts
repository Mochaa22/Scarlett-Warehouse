import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku, validateKeluarItem } from '../core/stockEngine.ts';
import { curData, getWhMeta, saveRegistry, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { playBeep } from '../services/scannerService.ts';
import { appendNeatSheet, findSheet, parseDelimitedLines, sheetToAoA, syncMasukBatchQty } from '../services/xlsxService.ts';
import { appState, renderApp } from '../state/store.ts';
import { iconSvg, showToast } from './feedback.ts';
import { classifyExpiry, esc, fmtNum, normBarcode, normLoc, normSku, parseDate, parseExpDate, parseQty, stockKey, todayISO, uid } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

// === MODAL BULK BARANG MASUK & BULK BARANG KELUAR ===

export function closeBulkTxModal() {
  var modal = byId('bulk-tx-modal');
  if (modal) modal.classList.remove('open');
  appState.bulkTxSubmitCb = null;
}

export function openBulkTxModal(mode) {
  var isMasuk = mode === 'masuk';
  var d = curData();
  var an = computeWarehouseAnalysis(d);
  var whMeta = getWhMeta(appState.W.cur);
  var modal = byId('bulk-tx-modal');
  var titleEl = byId('bulk-tx-title');
  var bodyEl = byId('bulk-tx-body');
  var submitBtn = byId('bulk-tx-submit');
  if (!modal || !bodyEl || !submitBtn) return;

  titleEl.textContent = (isMasuk ? 'Bulk Barang Masuk — ' : 'Bulk Barang Keluar — ') + whMeta.nama;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Simpan Baris Valid';

  var defaultPic = isMasuk
    ? (appState.masukStockkeeperName || appState.W.user || '')
    : (appState.keluarStockkeeperName || appState.masukStockkeeperName || appState.W.user || '');
  var locOpts = (d.lokasi || []).map(function (l) {
    return '<option value="' + esc(l) + '">';
  }).join('');

  bodyEl.innerHTML =
    '<p class="muted" style="margin:0 0 12px;font-size:13px">' +
    (isMasuk
      ? 'Upload file Excel (<code>.xlsx</code>/<code>.csv</code>) atau tempel banyak baris dari Excel / Google Sheets untuk mencatat <strong>Barang Masuk</strong> sekaligus ke stok &amp; antrean Ancantho.'
      : 'Upload file Excel (<code>.xlsx</code>/<code>.csv</code>) atau tempel banyak baris dari Excel / Google Sheets untuk mencatat <strong>Barang Keluar</strong> sekaligus dengan pengecekan stok berjalan per lokasi.') +
    '</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
    '<button type="button" class="btn btn-sm" id="bulk-download-tpl">' + iconSvg('download') + '<span>Unduh Template Excel (.xlsx)</span></button>' +
    '<button type="button" class="btn btn-sm" id="bulk-upload-btn">' + iconSvg('master') + '<span>Upload File Excel / CSV</span></button>' +
    '<input type="file" id="bulk-file-input" accept=".xlsx,.xls,.csv,.txt" style="display:none" />' +
    '<button type="button" class="btn btn-sm" id="bulk-clear-btn">Bersihkan</button>' +
    '</div>' +
    '<div class="form-grid" style="margin-bottom:12px">' +
    '<div class="field"><label for="bulk-def-tgl">Default Tanggal</label><input id="bulk-def-tgl" type="date" class="input" value="' + esc(todayISO()) + '" /></div>' +
    '<div class="field"><label for="bulk-def-pic">Default PIC Stockkeeper</label><input id="bulk-def-pic" type="text" class="input" value="' + esc(defaultPic) + '" placeholder="Mis. Budi / Rina" /></div>' +
    '<div class="field"><label for="bulk-def-lok">Default Lokasi (opsional)</label><input id="bulk-def-lok" type="text" class="input" list="dl-bulk-lokasi" placeholder="Jika kolom lokasi kosong" autocomplete="off" /></div>' +
    (isMasuk
      ? '<div class="field"><label for="bulk-def-exp">Default Expiry Date (opsional)</label><input id="bulk-def-exp" type="date" class="input" /></div>'
      : '') +
    '</div>' +
    '<datalist id="dl-bulk-lokasi">' + locOpts + '</datalist>' +
    '<div class="field" style="margin-bottom:12px">' +
    '<label for="bulk-paste-area">Tempel Tabel (Format standar 9 kolom: <code>Tanggal | PIC | Barcode | SKU | Nama Barang | Lokasi | Expiry Date | Qty | Keterangan</code> atau ringkas <code>Barcode/SKU | Lokasi | Expiry | Qty | Ket</code>)</label>' +
    '<textarea id="bulk-paste-area" class="input mono" rows="6" placeholder="' + (isMasuk
      ? '2026-11-24\tBudi\t8997236030012\t5000011\tScarlett Romansa\tRAK-A1\t2027-08-31\t24\tInbound batch 1'
      : '2026-11-24\tSari\t8997236030012\t5000011\tScarlett Romansa\tRAK-A1\t2027-08-31\t12\tOrder marketplace') + '"></textarea>' +
    '</div>' +
    '<div id="bulk-preview-summary" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px"></div>' +
    '<div class="table-wrap" style="max-height:260px"><table><thead><tr>' +
    '<th>#</th><th>Tanggal</th><th>PIC</th><th>Barcode / SKU</th><th>Nama Produk</th><th>Lokasi</th><th>Expiry Date</th><th class="right">Qty</th><th>Validasi</th>' +
    '</tr></thead><tbody id="bulk-preview-rows">' +
    '<tr><td colspan="9" class="muted" style="text-align:center;padding:18px">Tempel data atau upload file Excel/CSV untuk melihat pratinjau validasi.</td></tr>' +
    '</tbody></table></div>';

  var pasteEl = byId('bulk-paste-area');
  var defTglEl = byId('bulk-def-tgl');
  var defPicEl = byId('bulk-def-pic');
  var defLokEl = byId('bulk-def-lok');
  var defExpEl = byId('bulk-def-exp');
  var summaryEl = byId('bulk-preview-summary');
  var tbodyEl = byId('bulk-preview-rows');
  var fileInp = byId('bulk-file-input');

  var parsedValidRows = [];

  function resolveBulkProduct(bcRaw, skuRaw, namaRaw) {
    var bc = normBarcode(bcRaw);
    var sku = normSku(skuRaw);
    var nama = String(namaRaw || '').trim();
    var mf = (bc && (findMasterByBarcode(d.master, bc) || findMasterBySku(d.master, bc))) ||
             (sku && (findMasterBySku(d.master, sku) || findMasterByBarcode(d.master, sku)));
    if (mf) {
      if (!bc) bc = normBarcode(mf.barcode);
      if (!sku) sku = normSku(mf.sku);
      if (!nama) nama = String(mf.nama || '').trim();
    } else {
      var stk = an.rows.find(function (r) {
        return (bc && (normBarcode(r.barcode) === bc || normSku(r.sku) === normSku(bc))) ||
               (sku && normSku(r.sku) === sku);
      });
      if (stk) {
        if (!bc) bc = normBarcode(stk.barcode);
        if (!sku) sku = normSku(stk.sku);
        if (!nama) nama = String(stk.nama || '').trim();
      }
    }
    if (!sku && bc) sku = normSku(bc);
    if (!bc && sku) bc = normBarcode(sku);
    return { barcode: bc, sku: sku, nama: nama };
  }

  function detectBulkColMap(headerRow): Record<string, number> | null {
    var cols: Record<string, number> = {};
    var hits = 0;
    for (var c = 0; c < headerRow.length; c++) {
      var h = String(headerRow[c] || '').trim().toUpperCase();
      if (!h) continue;
      if (/EXP|KADALUWARSA|\bED\b/.test(h)) { if (cols.exp == null) { cols.exp = c; hits++; } }
      else if (/TANGGAL|TGL|DATE/.test(h) && cols.tgl == null) { cols.tgl = c; hits++; }
      else if (/BARCODE|EAN|UPC/.test(h) && cols.barcode == null) { cols.barcode = c; hits++; }
      else if (/\bSKU\b|KODE/.test(h) && cols.sku == null) { cols.sku = c; hits++; }
      else if (/NAMA|PRODUK|ITEM|DESC/.test(h) && cols.nama == null) { cols.nama = c; hits++; }
      else if (/LOKASI|LOK\b|RAK|LOC/.test(h) && cols.lok == null) { cols.lok = c; hits++; }
      else if (/QTY|JUMLAH|JML|PCS/.test(h) && cols.qty == null) { cols.qty = c; hits++; }
      else if (/PIC|PETUGAS|STOCKKEEPER|OPERATOR|\bBY\b/.test(h) && cols.by == null) { cols.by = c; hits++; }
      else if (/KET|CATATAN|NOTE|REMARK/.test(h) && cols.ket == null) { cols.ket = c; }
    }
    return hits >= 2 ? cols : null;
  }

  function extractRowByHeuristic(colsArr) {
    var n = colsArr.length;
    if (n >= 8) {
      return {
        tgl: colsArr[0], by: colsArr[1], barcode: colsArr[2], sku: colsArr[3],
        nama: colsArr[4], lok: colsArr[5], exp: colsArr[6], qty: colsArr[7],
        ket: colsArr[8] || ''
      };
    }
    if (n === 7) {
      if (parseDate(colsArr[0])) {
        return { tgl: colsArr[0], by: colsArr[1], barcode: colsArr[2], sku: '', nama: '', lok: colsArr[3], exp: colsArr[4], qty: colsArr[5], ket: colsArr[6] };
      }
      return { tgl: '', by: colsArr[0], barcode: colsArr[1], sku: colsArr[2], nama: colsArr[3], lok: colsArr[4], exp: colsArr[5], qty: colsArr[6], ket: '' };
    }
    if (n === 6) {
      if (parseDate(colsArr[0])) {
        return { tgl: colsArr[0], by: '', barcode: colsArr[1], sku: colsArr[2], nama: colsArr[3], lok: colsArr[4], exp: '', qty: colsArr[5], ket: '' };
      }
      return { tgl: '', by: '', barcode: colsArr[0], sku: colsArr[1], nama: colsArr[2], lok: colsArr[3], exp: colsArr[4], qty: colsArr[5], ket: '' };
    }
    if (n === 5) {
      if (parseDate(colsArr[0])) {
        if (parseExpDate(colsArr[3])) {
          return { tgl: colsArr[0], by: '', barcode: colsArr[1], sku: '', nama: '', lok: colsArr[2], exp: colsArr[3], qty: colsArr[4], ket: '' };
        }
        return { tgl: colsArr[0], by: '', barcode: colsArr[1], sku: '', nama: '', lok: colsArr[2], exp: '', qty: colsArr[3], ket: colsArr[4] };
      }
      return { tgl: '', by: '', barcode: colsArr[0], sku: '', nama: '', lok: colsArr[1], exp: colsArr[2], qty: colsArr[3], ket: colsArr[4] };
    }
    if (n === 4) {
      if (parseDate(colsArr[0])) {
        return { tgl: colsArr[0], by: '', barcode: colsArr[1], sku: '', nama: '', lok: colsArr[2], exp: '', qty: colsArr[3], ket: '' };
      }
      if (parseExpDate(colsArr[2])) {
        return { tgl: '', by: '', barcode: colsArr[0], sku: '', nama: '', lok: colsArr[1], exp: colsArr[2], qty: colsArr[3], ket: '' };
      }
      return { tgl: '', by: '', barcode: colsArr[0], sku: '', nama: '', lok: colsArr[1], exp: '', qty: colsArr[2], ket: colsArr[3] };
    }
    return { tgl: '', by: '', barcode: colsArr[0] || '', sku: '', nama: '', lok: colsArr[1] || '', exp: '', qty: colsArr[2] || '', ket: '' };
  }

  function recomputeBulkPreview() {
    var grid = parseDelimitedLines(pasteEl.value);
    parsedValidRows = [];
    if (!grid.length) {
      summaryEl.innerHTML = '';
      tbodyEl.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:18px">Tempel data atau upload file Excel/CSV untuk melihat pratinjau validasi.</td></tr>';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Simpan Baris Valid';
      return;
    }

    var defTgl = parseDate(defTglEl.value) || todayISO();
    var defPic = String(defPicEl.value || '').trim();
    var defLok = normLoc(defLokEl.value);
    var defExp = defExpEl ? parseExpDate(defExpEl.value) : '';

    var colMap = detectBulkColMap(grid[0]);
    var startIdx = colMap ? 1 : 0;

    // Clone running stock map untuk simulasi stok berjalan pada Bulk Keluar
    var simStockMap = Object.create(null);
    if (!isMasuk) {
      Object.keys(an.stockMap).forEach(function (k) {
        simStockMap[k] = Object.assign({}, an.stockMap[k]);
      });
    }

    var previewList = [];
    var validCount = 0;
    var errCount = 0;

    for (var i = startIdx; i < grid.length; i++) {
      var colsArr = grid[i];
      if (!colsArr || !colsArr.some(function (c) { return String(c || '').trim() !== ''; })) continue;

      var raw: Record<string, any> = colMap ? {
        tgl: colMap.tgl != null ? colsArr[colMap.tgl] : '',
        by: colMap.by != null ? colsArr[colMap.by] : '',
        barcode: colMap.barcode != null ? colsArr[colMap.barcode] : '',
        sku: colMap.sku != null ? colsArr[colMap.sku] : '',
        nama: colMap.nama != null ? colsArr[colMap.nama] : '',
        lok: colMap.lok != null ? colsArr[colMap.lok] : '',
        exp: colMap.exp != null ? colsArr[colMap.exp] : '',
        qty: colMap.qty != null ? colsArr[colMap.qty] : '',
        ket: colMap.ket != null ? colsArr[colMap.ket] : ''
      } : extractRowByHeuristic(colsArr);

      var tgl = parseDate(raw.tgl) || defTgl;
      var by = String(raw.by || '').trim() || defPic;
      var resolved = resolveBulkProduct(raw.barcode, raw.sku, raw.nama);
      var lok = normLoc(raw.lok) || defLok;
      var exp = parseExpDate(raw.exp) || defExp;
      var qty = parseQty(raw.qty);
      var ket = String(raw.ket || '').trim();

      var issues = [];
      var warnNote = '';

      if (!tgl) issues.push('Tanggal tidak valid');
      if (!by) issues.push('PIC wajib diisi');
      if (!resolved.barcode && !resolved.sku) issues.push('Barcode / SKU kosong');
      if (!lok) issues.push('Lokasi wajib diisi');
      if (!(qty > 0)) issues.push('Qty harus > 0');

      if (isMasuk) {
        if (!resolved.nama) issues.push('Nama barang belum ditemukan di Master');
        if (!exp) issues.push('Expiry Date wajib diisi');
        else if (classifyExpiry(exp, Number(d.expMonths || 7)).isAlert) {
          warnNote = classifyExpiry(exp, Number(d.expMonths || 7)).label;
        }
      } else {
        if (!exp && lok && resolved.sku) {
          var matchBatch = (an.batchRows || []).filter(function (b) {
            return normLoc(b.lok) === lok && normSku(b.sku) === resolved.sku && b.qty > 0 && b.exp &&
              (!resolved.barcode || normBarcode(b.barcode) === resolved.barcode);
          }).sort(function (a, b) { return String(a.exp).localeCompare(String(b.exp)); })[0];
          if (matchBatch) exp = matchBatch.exp;
        }
        if (!issues.length) {
          var chk = validateKeluarItem({ tgl: tgl, lok: lok, sku: resolved.sku, barcode: resolved.barcode, qty: qty }, d, simStockMap, true);
          if (!chk.ok) {
            issues.push(chk.text.replace(/^[^\w]+/, '').trim());
          } else {
            var skKey = stockKey(lok, resolved.sku, resolved.barcode);
            if (simStockMap[skKey] && !chk.historical) {
              simStockMap[skKey].qty = Number(simStockMap[skKey].qty || 0) - qty;
            }
          }
        }
      }

      var ok = issues.length === 0;
      if (ok) {
        validCount++;
        parsedValidRows.push({
          tgl: tgl,
          by: by,
          barcode: resolved.barcode,
          sku: resolved.sku,
          nama: resolved.nama || resolved.sku,
          lok: lok,
          exp: exp,
          qty: qty,
          ket: ket
        });
      } else {
        errCount++;
      }

      previewList.push({
        idx: previewList.length + 1,
        tgl: tgl,
        by: by,
        barcode: resolved.barcode,
        sku: resolved.sku,
        nama: resolved.nama,
        lok: lok,
        exp: exp,
        qty: qty,
        ok: ok,
        issues: issues,
        warnNote: warnNote
      });
    }

    summaryEl.innerHTML =
      '<span class="badge badge-neutral">Total: ' + previewList.length + ' baris</span>' +
      '<span class="badge badge-ok">Siap Simpan: ' + validCount + '</span>' +
      (errCount > 0 ? '<span class="badge badge-err">Perlu Perbaiki: ' + errCount + '</span>' : '');

    if (!previewList.length) {
      tbodyEl.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:18px">Tidak ada baris data yang dapat dibaca.</td></tr>';
    } else {
      tbodyEl.innerHTML = previewList.slice(0, 150).map(function (r) {
        return '<tr>' +
          '<td class="num">' + r.idx + '</td>' +
          '<td class="num">' + esc(r.tgl || '-') + '</td>' +
          '<td>' + esc(r.by || '-') + '</td>' +
          '<td class="mono">' + esc(r.barcode || r.sku || '-') + (r.sku && r.barcode && r.sku !== r.barcode ? ' / ' + esc(r.sku) : '') + '</td>' +
          '<td>' + esc(r.nama || '-') + '</td>' +
          '<td>' + (r.lok ? '<span class="masuk-loc-pill">' + esc(r.lok) + '</span>' : '-') + '</td>' +
          '<td class="num">' + esc(r.exp || '-') + '</td>' +
          '<td class="right num"><strong>' + (r.qty > 0 ? ((isMasuk ? '+' : '-') + fmtNum(r.qty)) : '0') + '</strong></td>' +
          '<td>' + (r.ok
            ? ('<span class="badge badge-ok">✓ Siap</span>' + (r.warnNote ? ' <span class="badge badge-warn">' + esc(r.warnNote) + '</span>' : ''))
            : ('<span class="badge badge-err">' + esc(r.issues.join(' · ')) + '</span>')) + '</td>' +
          '</tr>';
      }).join('') + (previewList.length > 150
        ? '<tr><td colspan="9" class="muted" style="text-align:center">Menampilkan 150 dari ' + previewList.length + ' baris. Semua baris valid tetap akan disimpan.</td></tr>'
        : '');
    }

    submitBtn.disabled = validCount === 0;
    submitBtn.textContent = validCount > 0 ? ('Simpan ' + validCount + ' Baris Valid') : 'Simpan Baris Valid';
  }

  byId('bulk-download-tpl').addEventListener('click', function () {
    if (typeof XLSX === 'undefined') {
      showToast('Pustaka Excel (SheetJS) belum termuat.', 'err');
      return;
    }
    var sampleMaster = (d.master && d.master[0]) || { barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa' };
    var sampleLoc = (d.lokasi && d.lokasi[0]) || 'RAK-A1';
    if (!isMasuk) {
      var activeSample = an.rows.find(function (r) { return r.qty > 0; });
      if (activeSample) {
        sampleMaster = activeSample;
        sampleLoc = activeSample.lok || sampleLoc;
      }
    }
    var tplRows = [
      [todayISO(), defaultPic || 'Budi', sampleMaster.barcode || '', sampleMaster.sku || '', sampleMaster.nama || '', sampleLoc, '2027-08-31', 12, isMasuk ? 'Contoh bulk masuk' : 'Contoh bulk keluar']
    ];
    var wbTpl = XLSX.utils.book_new();
    var usedTpl = Object.create(null);
    appendNeatSheet(wbTpl, usedTpl, isMasuk ? 'Template Bulk Masuk' : 'Template Bulk Keluar', [
      'Tanggal', 'PIC Stockkeeper', 'Barcode', 'SKU', 'Nama Barang', 'Lokasi', 'Expiry Date', 'Qty', 'Keterangan'
    ], tplRows);
    XLSX.writeFile(wbTpl, isMasuk ? 'Template-Bulk-Barang-Masuk.xlsx' : 'Template-Bulk-Barang-Keluar.xlsx');
    showToast('Template Excel (.xlsx) diunduh', 'ok');
  });

  byId('bulk-upload-btn').addEventListener('click', function () {
    fileInp.value = '';
    fileInp.click();
  });

  fileInp.addEventListener('change', function () {
    var f = fileInp.files && fileInp.files[0];
    if (!f) return;
    var ext = String(f.name || '').toLowerCase();
    if (ext.endsWith('.csv') || ext.endsWith('.txt')) {
      var txtReader = new FileReader();
      txtReader.onload = function (ev) {
        pasteEl.value = String(ev.target.result || '');
        recomputeBulkPreview();
        showToast('File ' + f.name + ' dimuat ke pratinjau', 'ok');
      };
      txtReader.readAsText(f);
      return;
    }
    if (typeof XLSX === 'undefined') {
      showToast('Pustaka Excel (SheetJS) belum termuat. Gunakan upload CSV atau tempel tabel.', 'err');
      return;
    }
    var binReader = new FileReader();
    binReader.onload = function (ev) {
      try {
        var wb = XLSX.read(new Uint8Array(ev.target!.result as ArrayBuffer), { type: 'array' });
        var targetSheet = findSheet(wb, isMasuk ? 'Barang Masuk' : 'Barang Keluar') ||
          findSheet(wb, isMasuk ? 'Template Bulk Masuk' : 'Template Bulk Keluar') ||
          wb.Sheets[wb.SheetNames[0]];
        var aoa = sheetToAoA(targetSheet);
        var hIdx = -1;
        for (var r = 0; r < Math.min(8, aoa.length); r++) {
          if (detectBulkColMap(aoa[r] || [])) { hIdx = r; break; }
        }
        var lines = [];
        var colCheck = hIdx >= 0 ? detectBulkColMap(aoa[hIdx] || []) : null;
        for (var rIdx = Math.max(0, hIdx); rIdx < aoa.length; rIdx++) {
          var rowArr = aoa[rIdx] || [];
          if (!rowArr.some(function (cell) { return String(cell == null ? '' : cell).trim() !== ''; })) continue;
          lines.push(rowArr.map(function (cell, cIdx) {
            if (colCheck && rIdx > hIdx) {
              if (colCheck.tgl === cIdx) {
                var pd = parseDate(cell);
                if (pd) return pd;
              }
              if (colCheck.exp === cIdx) {
                var pe = parseExpDate(cell);
                if (pe) return pe;
              }
            }
            return String(cell == null ? '' : cell).replace(/[\t\r\n]+/g, ' ').trim();
          }).join('\t'));
        }
        pasteEl.value = lines.join('\n');
        recomputeBulkPreview();
        showToast('File Excel ' + f.name + ' berhasil dibaca', 'ok');
      } catch (err) {
        showToast('Gagal membaca file Excel: ' + (err.message || 'format tidak valid'), 'err');
      }
    };
    binReader.readAsArrayBuffer(f);
  });

  byId('bulk-clear-btn').addEventListener('click', function () {
    pasteEl.value = '';
    recomputeBulkPreview();
    pasteEl.focus();
  });

  pasteEl.addEventListener('input', recomputeBulkPreview);
  defTglEl.addEventListener('change', recomputeBulkPreview);
  defPicEl.addEventListener('input', recomputeBulkPreview);
  defLokEl.addEventListener('input', recomputeBulkPreview);
  if (defExpEl) defExpEl.addEventListener('change', recomputeBulkPreview);

  appState.bulkTxSubmitCb = function () {
    if (!parsedValidRows.length) {
      showToast('Belum ada baris valid untuk disimpan', 'warn');
      return;
    }
    var dNow = curData();
    var latestPic = '';
    parsedValidRows.forEach(function (item) {
      latestPic = item.by || latestPic;
      var rowId = uid();
      if (isMasuk) {
        var newMasuk = {
          id: rowId,
          tgl: item.tgl,
          barcode: item.barcode,
          sku: item.sku,
          nama: item.nama,
          lok: item.lok,
          qty: item.qty,
          inboundQty: null,
          batch: '',
          exp: item.exp,
          ket: item.ket || '',
          by: item.by,
          n: 1,
          ancanthoDone: false,
          ancanthoBy: '',
          ancanthoKet: '',
          ancanthoAt: ''
        };
        dNow.masuk.push(newMasuk);
        if (item.exp) syncMasukBatchQty(dNow, newMasuk);
      } else {
        dNow.keluar.push({
          id: rowId,
          tgl: item.tgl,
          barcode: item.barcode,
          sku: item.sku,
          nama: item.nama,
          lok: item.lok,
          qty: item.qty,
          exp: item.exp || '',
          ket: item.ket || '',
          by: item.by,
          n: 1,
          ancanthoDone: false,
          ancanthoBy: '',
          ancanthoKet: '',
          ancanthoAt: ''
        });
      }
    });

    if (latestPic) {
      if (isMasuk) appState.masukStockkeeperName = latestPic;
      else appState.keluarStockkeeperName = latestPic;
      appState.W.user = latestPic;
      saveRegistry();
    }
    writeWarehouseData(appState.W.cur, dNow);
    playBeep(true);
    showToast('Berhasil menyimpan ' + parsedValidRows.length + ' baris Bulk ' + (isMasuk ? 'Barang Masuk' : 'Barang Keluar'), 'ok');
    closeBulkTxModal();
    renderApp();
  };

  modal.classList.add('open');
  setTimeout(function () { pasteEl.focus(); }, 30);
}
