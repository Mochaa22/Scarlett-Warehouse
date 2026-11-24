import { computeCycleSessionMetrics, getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, validateKeluarItem } from '../core/stockEngine.ts';
import { curData, getWhMeta, readWarehouseData, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { appState, renderApp } from '../state/store.ts';
import { showToast } from '../ui/feedback.ts';
import { getEffectiveRole, getSelectableWarehouses } from '../ui/rbac.ts';
import { buildMasterLookups, classifyExpiry, inferProductCategory, normBarcode, normLoc, normSku, parseDate, parseExpDate, parseQty, resolveProductCategory, todayISO, uid } from '../utils/format.ts';

// === IMPOR XLSX (SHEETJS) & MANUAL CSV/TSV ===
export function findSheet(wb, targetName) {
  var want = targetName.trim().toUpperCase();
  for (var i = 0; i < wb.SheetNames.length; i++) {
    if (wb.SheetNames[i].trim().toUpperCase() === want) {
      return wb.Sheets[wb.SheetNames[i]];
    }
  }
  return null;
}

export function sheetToAoA(sheet: any) {
  if (!sheet || typeof window.XLSX === 'undefined') return [];
  return window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
}

export function detectTxHeader(aoa: any[], isPindah?: boolean) {
  var limit = Math.min(8, aoa.length);
  for (var r = 0; r < limit; r++) {
    var row = aoa[r] || [];
    var cols: Record<string, number> = {};
    var score = 0;
    for (var c = 0; c < row.length; c++) {
      var h = String(row[c] || '').trim().toUpperCase();
      if (!h) continue;
      if (/EXP|KADALUWARSA|\bED\b/.test(h)) { if (cols.exp == null) cols.exp = c; }
      else if (/TANGGAL|TGL|DATE/.test(h) && cols.tgl == null) { cols.tgl = c; score++; }
      else if (/BARCODE|EAN|UPC/.test(h) && cols.barcode == null) { cols.barcode = c; score++; }
      else if (/\bSKU\b|KODE/.test(h) && cols.sku == null) { cols.sku = c; score++; }
      else if (/NAMA|PRODUK|ITEM|DESC/.test(h) && cols.nama == null) { cols.nama = c; score++; }
      else if (isPindah && /DARI|ASAL|FROM/.test(h) && cols.dari == null) { cols.dari = c; score++; }
      else if (isPindah && /\bKE\b|TUJUAN|TO\b/.test(h) && cols.ke == null) { cols.ke = c; score++; }
      else if (!isPindah && /LOKASI|LOK\b|RAK|LOC/.test(h) && cols.lok == null) { cols.lok = c; score++; }
      else if (/QTY|JUMLAH|JML|PCS|SISA/.test(h) && cols.qty == null) { cols.qty = c; score++; }
      else if (/BATCH|LOT/.test(h) && cols.batch == null) { cols.batch = c; }
      else if (/KET|CATATAN|NOTE|REMARK/.test(h) && cols.ket == null) { cols.ket = c; }
      else if (/PETUGAS|BY|USER|PIC|OPERATOR/.test(h) && cols.by == null) { cols.by = c; }
    }
    if (score >= 3) {
      return { startRow: r + 1, cols: cols };
    }
  }
  // Fallback posisi kolom: D tanggal(3), E barcode(4), F SKU(5), G nama(6), H lokasi(7), J qty(9)
  return {
    startRow: 2,
    cols: isPindah
      ? { tgl: 3, barcode: 4, sku: 5, nama: 6, dari: 7, ke: 8, qty: 9, ket: 10, by: 11 }
      : { tgl: 3, barcode: 4, sku: 5, nama: 6, lok: 7, qty: 9, ket: 10, by: 11 }
  };
}

export function importWorkbookToActive(file: File) {
  if (typeof window.XLSX === 'undefined') {
    showToast('Pustaka SheetJS belum termuat. Periksa koneksi internet atau gunakan impor tempel manual.', 'err');
    return;
  }
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var wb = window.XLSX.read(new Uint8Array(ev.target!.result as ArrayBuffer), { type: 'array' });
      var d = curData();
      var summary = [];

      // 1. Master Barang (C=2 barcode, D=3 SKU, E=4 nama, F=5 kategori opsional, mulai baris 3 idx 2)
      var sMaster = findSheet(wb, 'Master Barang');
      if (sMaster) {
        var aoaM = sheetToAoA(sMaster);
        var listM = [];
        for (var i = 2; i < aoaM.length; i++) {
          var row = aoaM[i] || [];
          var bc = normBarcode(row[2]);
          var sku = normSku(row[3]);
          var nama = String(row[4] || '').trim();
          var kat = String(row[5] || '').trim();
          if (!bc && !sku && !nama) continue;
          if (sku || bc) {
            var mObj: Record<string, any> = { barcode: bc, sku: sku, nama: nama };
            if (kat) mObj.kategori = kat;
            listM.push(mObj);
          }
        }
        d.master = listM;
        summary.push('Master Barang: ' + listM.length + ' baris');
      }

      // 2. Master Lokasi (kolom C idx 2, baris 3+)
      var sLok = findSheet(wb, 'Master Lokasi');
      if (sLok) {
        var aoaL = sheetToAoA(sLok);
        var setL = new Set();
        for (var iL = 2; iL < aoaL.length; iL++) {
          var valL = normLoc((aoaL[iL] || [])[2]);
          if (valL) setL.add(valL);
        }
        d.lokasi = Array.from(setL);
        summary.push('Master Lokasi: ' + d.lokasi.length + ' lokasi');
      }

      // 3. STOCK CONFIG (sel B2 = cutoff)
      var sCfg = findSheet(wb, 'STOCK CONFIG');
      if (sCfg) {
        var b2 = sCfg['B2'] ? sCfg['B2'].v : '';
        var parsedCut = parseDate(b2);
        if (parsedCut) {
          d.cutoff = parsedCut;
          summary.push('STOCK CONFIG (Cutoff): ' + parsedCut);
        }
      }

      // 4. OPENING_GP1_30SEP
      var sOpen = findSheet(wb, 'OPENING_GP1_30SEP');
      if (sOpen) {
        var aoaO = sheetToAoA(sOpen);
        var listO = [];
        for (var iO = 2; iO < aoaO.length; iO++) {
          var rO = aoaO[iO] || [];
          var lokO = normLoc(rO[3]);
          var bcO = normBarcode(rO[4]);
          var skuO = normSku(rO[5]);
          var namaO = String(rO[6] || '').trim();
          var qtyO = parseQty(rO[7]);
          if (!lokO && !skuO) continue;
          if (lokO && skuO) listO.push({ lok: lokO, barcode: bcO, sku: skuO, nama: namaO, qty: qtyO });
        }
        d.opening = listO;
        summary.push('OPENING_GP1_30SEP: ' + listO.length + ' baris');
      }

      // 5. ALL STOCK (D=3 lokasi, E=4 barcode, F=5 SKU, G=6 nama, H=7 sisa, baris 3+)
      var sAll = findSheet(wb, 'ALL STOCK');
      if (sAll) {
        var aoaA = sheetToAoA(sAll);
        var listA = [];
        for (var iA = 2; iA < aoaA.length; iA++) {
          var rA = aoaA[iA] || [];
          var lokA = normLoc(rA[3]);
          var bcA = normBarcode(rA[4]);
          var skuA = normSku(rA[5]);
          var namaA = String(rA[6] || '').trim();
          var qtyA = parseQty(rA[7]);
          if (!lokA && !skuA) continue;
          if (lokA && skuA) listA.push({ lok: lokA, barcode: bcA, sku: skuA, nama: namaA, qty: qtyA });
        }
        d.allstock = listA;
        summary.push('ALL STOCK: ' + listA.length + ' baris');
      }

      // 6. Barang Masuk
      var sIn = findSheet(wb, 'Barang Masuk');
      if (sIn) {
        var aoaIn = sheetToAoA(sIn);
        var detIn = detectTxHeader(aoaIn, false);
        var listIn = [];
        for (var rI = detIn.startRow; rI < aoaIn.length; rI++) {
          var rowI = aoaIn[rI] || [];
          var tglI = parseDate(rowI[detIn.cols.tgl]);
          var bcI = normBarcode(rowI[detIn.cols.barcode]);
          var skuI = normSku(rowI[detIn.cols.sku]);
          var namaI = String(rowI[detIn.cols.nama] || '').trim();
          var lokI = normLoc(rowI[detIn.cols.lok]);
          var qtyI = parseQty(rowI[detIn.cols.qty]);
          if (!tglI && !bcI && !skuI && !qtyI) continue;
          if (!skuI && bcI) {
            var mIn = findMasterByBarcode(d.master, bcI);
            if (mIn) { skuI = normSku(mIn.sku); if (!namaI) namaI = mIn.nama; }
          }
          var expI = detIn.cols.exp != null ? parseExpDate(rowI[detIn.cols.exp]) : '';
          var batchI = detIn.cols.batch != null ? String(rowI[detIn.cols.batch] || '').trim().toUpperCase() : '';
          var ketI = detIn.cols.ket != null ? String(rowI[detIn.cols.ket] || '').trim() : '';
          var byI = detIn.cols.by != null ? String(rowI[detIn.cols.by] || '').trim() : '';
          listIn.push({
            id: uid(),
            tgl: tglI,
            barcode: bcI,
            sku: skuI,
            nama: namaI,
            lok: lokI,
            qty: qtyI,
            batch: batchI,
            exp: expI,
            ket: ketI,
            by: byI,
            n: 0
          });
          if (expI && qtyI > 0) {
            d.batches = d.batches || [];
            d.batches.push({
              id: uid(),
              tglMasuk: tglI || todayISO(),
              lok: lokI,
              barcode: bcI,
              sku: skuI,
              nama: namaI,
              batch: batchI,
              exp: expI,
              qty: qtyI,
              status: 'AKTIF',
              ket: ketI || 'Impor Barang Masuk',
              by: byI || appState.W.user
            });
          }
        }
        d.masuk = listIn;
        summary.push('Barang Masuk: ' + listIn.length + ' baris');
      }

      // 7. Barang Keluar
      var sOut = findSheet(wb, 'Barang Keluar');
      if (sOut) {
        var aoaOut = sheetToAoA(sOut);
        var detOut = detectTxHeader(aoaOut, false);
        var listOut = [];
        for (var rK = detOut.startRow; rK < aoaOut.length; rK++) {
          var rowK = aoaOut[rK] || [];
          var tglK = parseDate(rowK[detOut.cols.tgl]);
          var bcK = normBarcode(rowK[detOut.cols.barcode]);
          var skuK = normSku(rowK[detOut.cols.sku]);
          var namaK = String(rowK[detOut.cols.nama] || '').trim();
          var lokK = normLoc(rowK[detOut.cols.lok]);
          var qtyK = parseQty(rowK[detOut.cols.qty]);
          if (!tglK && !bcK && !skuK && !qtyK) continue;
          if (!skuK && bcK) {
            var mOut = findMasterByBarcode(d.master, bcK);
            if (mOut) { skuK = normSku(mOut.sku); if (!namaK) namaK = mOut.nama; }
          }
          listOut.push({
            id: uid(),
            tgl: tglK,
            barcode: bcK,
            sku: skuK,
            nama: namaK,
            lok: lokK,
            qty: qtyK,
            ket: detOut.cols.ket != null ? String(rowK[detOut.cols.ket] || '').trim() : '',
            by: detOut.cols.by != null ? String(rowK[detOut.cols.by] || '').trim() : '',
            n: 0
          });
        }
        d.keluar = listOut;
        summary.push('Barang Keluar: ' + listOut.length + ' baris');
      }

      // 8. Perpindahan Lokasi
      var sMove = findSheet(wb, 'Perpindahan Lokasi');
      if (sMove) {
        var aoaMv = sheetToAoA(sMove);
        var detMv = detectTxHeader(aoaMv, true);
        var listMv = [];
        for (var rP = detMv.startRow; rP < aoaMv.length; rP++) {
          var rowP = aoaMv[rP] || [];
          var tglP = parseDate(rowP[detMv.cols.tgl]);
          var bcP = normBarcode(rowP[detMv.cols.barcode]);
          var skuP = normSku(rowP[detMv.cols.sku]);
          var namaP = String(rowP[detMv.cols.nama] || '').trim();
          var dariP = normLoc(rowP[detMv.cols.dari != null ? detMv.cols.dari : 7]);
          var keP = normLoc(rowP[detMv.cols.ke != null ? detMv.cols.ke : 8]);
          var qtyP = parseQty(rowP[detMv.cols.qty]);
          if (!tglP && !skuP && !qtyP) continue;
          listMv.push({
            id: uid(),
            tgl: tglP,
            dari: dariP,
            ke: keP,
            barcode: bcP,
            sku: skuP,
            nama: namaP,
            exp: detMv.cols.exp != null ? parseExpDate(rowP[detMv.cols.exp]) : '',
            qty: qtyP,
            by: detMv.cols.by != null ? String(rowP[detMv.cols.by] || '').trim() : '',
            n: 0
          });
        }
        d.pindah = listMv;
        summary.push('Perpindahan Lokasi: ' + listMv.length + ' baris');
      }

      // 9. Batch / Expire (opsional)
      var sExp = findSheet(wb, 'Expire') || findSheet(wb, 'Batch Expire');
      if (sExp) {
        var aoaExp = sheetToAoA(sExp);
        var detExp = detectTxHeader(aoaExp, false);
        var listExp = [];
        for (var rE = detExp.startRow; rE < aoaExp.length; rE++) {
          var rowE = aoaExp[rE] || [];
          var expDate = parseExpDate(detExp.cols.exp != null ? rowE[detExp.cols.exp] : rowE[detExp.cols.tgl]);
          var bcE = normBarcode(rowE[detExp.cols.barcode]);
          var skuE = normSku(rowE[detExp.cols.sku]);
          var namaE = String(rowE[detExp.cols.nama] || '').trim();
          var lokE = normLoc(rowE[detExp.cols.lok]);
          var qtyE = parseQty(rowE[detExp.cols.qty]);
          if (!expDate && !skuE && !bcE) continue;
          if (!skuE && bcE) {
            var mE = findMasterByBarcode(d.master, bcE);
            if (mE) { skuE = normSku(mE.sku); if (!namaE) namaE = mE.nama; }
          }
          if (expDate) {
            listExp.push({
              id: uid(),
              tglMasuk: todayISO(),
              lok: lokE,
              barcode: bcE,
              sku: skuE,
              nama: namaE,
              batch: detExp.cols.batch != null ? String(rowE[detExp.cols.batch] || '').trim().toUpperCase() : '',
              exp: expDate,
              qty: qtyE > 0 ? qtyE : 1,
              status: 'AKTIF',
              ket: detExp.cols.ket != null ? String(rowE[detExp.cols.ket] || '').trim() : '',
              by: detExp.cols.by != null ? String(rowE[detExp.cols.by] || '').trim() : ''
            });
          }
        }
        d.batches = listExp;
        summary.push('Batch Expire: ' + listExp.length + ' baris');
      }

      // 10. Barang Defect (opsional)
      var sDef = findSheet(wb, 'Defect') || findSheet(wb, 'Barang Defect');
      if (sDef) {
        var aoaDef = sheetToAoA(sDef);
        var detDef = detectTxHeader(aoaDef, false);
        var listDef = [];
        for (var rD = detDef.startRow; rD < aoaDef.length; rD++) {
          var rowD = aoaDef[rD] || [];
          var tglD = parseDate(rowD[detDef.cols.tgl]) || todayISO();
          var bcD = normBarcode(rowD[detDef.cols.barcode]);
          var skuD = normSku(rowD[detDef.cols.sku]);
          var namaD = String(rowD[detDef.cols.nama] || '').trim();
          var lokD = normLoc(rowD[detDef.cols.lok]);
          var qtyD = parseQty(rowD[detDef.cols.qty]);
          if (!bcD && !skuD && !qtyD) continue;
          if (!skuD && bcD) {
            var mD = findMasterByBarcode(d.master, bcD);
            if (mD) { skuD = normSku(mD.sku); if (!namaD) namaD = mD.nama; }
          }
          listDef.push({
            id: uid(),
            tgl: tglD,
            barcode: bcD,
            sku: skuD,
            nama: namaD,
            lok: lokD,
            qty: qtyD > 0 ? qtyD : 1,
            kategori: 'LAINNYA',
            sumber: 'IMPOR EXCEL',
            status: 'KARANTINA',
            ket: detDef.cols.ket != null ? String(rowD[detDef.cols.ket] || '').trim() : '',
            batch: detDef.cols.batch != null ? String(rowD[detDef.cols.batch] || '').trim().toUpperCase() : '',
            exp: detDef.cols.exp != null ? parseExpDate(rowD[detDef.cols.exp]) : '',
            potongStok: false,
            by: detDef.cols.by != null ? String(rowD[detDef.cols.by] || '').trim() : '',
            n: 0
          });
        }
        d.defect = listDef;
        summary.push('Barang Defect: ' + listDef.length + ' baris');
      }

      if (summary.length === 0) {
        showToast('Tidak ada sheet standar yang dikenali di file tersebut.', 'warn');
        return;
      }
      writeWarehouseData(appState.W.cur, d);
      window.__lastImportSummary = summary;
      showToast('Impor .xlsx selesai ke ' + getWhMeta(appState.W.cur).nama, 'ok');
      renderApp();
    } catch (err) {
      showToast('Gagal membaca file Excel: ' + (err.message || 'format tidak valid'), 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

export function parseDelimitedLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(Boolean)
    .map(function (line) {
      if (line.indexOf('\t') >= 0) return line.split('\t');
      if (line.indexOf(';') >= 0 && line.indexOf(',') < 0) return line.split(';');
      var out = [];
      var cur = '';
      var inQuotes = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if ((ch === ',' || ch === ';') && !inQuotes) {
          out.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    });
}

// === EKSPOR DATABASE MULTI-SHEET EXCEL (.XLSX) & HELPER BATCH MASUK ===
export function syncMasukBatchQty(dNow, row) {
  if (!row || !row.exp) return;
  dNow.batches = dNow.batches || [];
  var bIdx = dNow.batches.findIndex(function (b) { return b.masukId === row.id; });
  if (bIdx >= 0) {
    dNow.batches[bIdx].qty = row.qty;
    dNow.batches[bIdx].exp = row.exp;
    dNow.batches[bIdx].lok = row.lok;
    dNow.batches[bIdx].tglMasuk = row.tgl;
    dNow.batches[bIdx].barcode = row.barcode;
    dNow.batches[bIdx].sku = row.sku;
    dNow.batches[bIdx].nama = row.nama;
    dNow.batches[bIdx].by = row.by;
  } else {
    dNow.batches.push({
      id: uid(),
      masukId: row.id,
      tglMasuk: row.tgl || todayISO(),
      lok: row.lok,
      barcode: row.barcode,
      sku: row.sku,
      nama: row.nama,
      batch: row.batch || '',
      exp: row.exp,
      qty: row.qty,
      status: 'AKTIF',
      ket: row.ket || 'Dari Barang Masuk',
      by: row.by
    });
  }
}

export function normalizeExcelCell(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return isFinite(val) ? val : '';
  if (typeof val === 'boolean') return val ? 'YA' : 'TIDAK';
  return String(val);
}

export function makeNeatWorksheet(headers, rows) {
  var cleanRows = (rows || []).map(function (r) {
    return headers.map(function (_, idx) {
      return normalizeExcelCell(r[idx]);
    });
  });
  var aoa = [headers].concat(cleanRows);
  var ws = XLSX.utils.aoa_to_sheet(aoa);
  var widths = headers.map(function (h) { return String(h || '').length; });
  var scanLimit = Math.min(cleanRows.length, 3000);
  for (var i = 0; i < scanLimit; i++) {
    var row = cleanRows[i];
    for (var c = 0; c < headers.length; c++) {
      var len = String(row[c] == null ? '' : row[c]).length;
      if (len > widths[c]) widths[c] = len;
    }
  }
  ws['!cols'] = widths.map(function (w) {
    return { wch: Math.min(48, Math.max(11, w + 3)) };
  });
  ws['!rows'] = [{ hpt: 22 }];
  if (headers.length > 0 && aoa.length >= 1) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(0, aoa.length - 1), c: headers.length - 1 }
      })
    };
  }
  return ws;
}

export function appendNeatSheet(wb, usedNames, rawName, headers, rows) {
  var base = String(rawName || 'Sheet').replace(/[:\\/?*\[\]]/g, '-').trim();
  var name = (base || 'Sheet').slice(0, 31);
  var n = 2;
  while (usedNames[name]) {
    var suffix = ' ' + n;
    name = (base.slice(0, Math.max(1, 31 - suffix.length)) + suffix).slice(0, 31);
    n++;
  }
  usedNames[name] = true;
  XLSX.utils.book_append_sheet(wb, makeNeatWorksheet(headers, rows), name);
}

export function exportAllDatabaseExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('Pustaka Excel (SheetJS) belum termuat. Periksa koneksi lalu muat ulang halaman.', 'err');
    return;
  }
  var role = getEffectiveRole();
  var whList = (role === 'admin' || role === 'super_admin') ? appState.W.list.slice() : getSelectableWarehouses(role);
  if (!whList.length) whList = appState.W.list.slice();

  var ringkasanRows = [];
  var stokAktifRows = [];
  var masterRows = [];
  var lokasiRows = [];
  var stokAwalRows = [];
  var masukRows = [];
  var keluarRows = [];
  var pindahRows = [];
  var batchRows = [];
  var defectRows = [];
  var cycleRows = [];
  var inboundRows = [];

  whList.forEach(function (wMeta) {
    var whName = wMeta.nama || wMeta.id;
    var d = readWarehouseData(wMeta.id);
    var an = computeWarehouseAnalysis(d);
    var lookups = buildMasterLookups(d.master);
    var expMonths = Number(d.expMonths || 7);

    ringkasanRows.push([
      wMeta.id,
      whName,
      d.cutoff || '',
      d.mode === 'all' ? 'ALL STOCK + Baru (n:1)' : 'Mutasi Stok',
      Number(d.min || 0),
      Number(d.cover || 7),
      expMonths,
      Number(an.stats.skuAktif || 0),
      Number(an.stats.totalPcs || 0),
      (d.master || []).length,
      (d.lokasi || []).length,
      (d.opening || []).length + (d.allstock || []).length,
      (d.masuk || []).length,
      (d.keluar || []).length,
      (d.pindah || []).length,
      (d.batches || []).length,
      (d.defect || []).length,
      (d.cycleCounts || []).length,
      (d.inboundRegister || []).length
    ]);

    an.rows.slice().sort(function (a, b) {
      return String(a.lok || '').localeCompare(String(b.lok || '')) || String(a.sku || '').localeCompare(String(b.sku || ''));
    }).forEach(function (r) {
      var statusStok = r.qty < 0 ? 'Minus' : (r.qty === 0 ? 'Kosong' : (r.qty <= Number(d.min || 0) ? 'Menipis' : 'Aman'));
      var eb = an.skuExpMap[normSku(r.sku)];
      stokAktifRows.push([
        whName,
        r.lok || '',
        r.barcode || '',
        r.sku || '',
        r.nama || '',
        r.kategori || 'Lainnya',
        Number(r.qty || 0),
        statusStok,
        eb ? (eb.exp || '') : '',
        eb && eb.expInfo ? (eb.expInfo.label || '') : ''
      ]);
    });

    (d.master || []).forEach(function (m) {
      masterRows.push([
        whName,
        m.barcode || '',
        m.sku || '',
        m.nama || '',
        inferProductCategory(m.nama, m.kategori)
      ]);
    });

    (d.lokasi || []).forEach(function (lok) {
      lokasiRows.push([whName, normLoc(lok)]);
    });

    (d.opening || []).forEach(function (o) {
      stokAwalRows.push([whName, 'OPENING', o.lok || '', o.barcode || '', o.sku || '', o.nama || '', Number(o.qty || 0)]);
    });
    (d.allstock || []).forEach(function (a) {
      stokAwalRows.push([whName, 'ALL STOCK', a.lok || '', a.barcode || '', a.sku || '', a.nama || '', Number(a.qty || 0)]);
    });

    (d.masuk || []).forEach(function (r) {
      var isDone = isMasukAncanthoDone(r);
      var im = getMasukInboundMatch(r);
      masukRows.push([
        whName,
        r.tgl || '',
        r.by || '',
        r.barcode || '',
        r.sku || '',
        r.nama || '',
        r.lok || '',
        r.exp || '',
        r.batch || '',
        Number(r.qty || 0),
        im.hasInbound ? Number(im.inboundQty || 0) : '',
        im.hasInbound ? im.label : 'Belum Ada Inbound',
        isDone ? 'Done' : 'Menunggu Admin',
        r.ancanthoBy || '',
        r.ancanthoAt || '',
        r.ket || '',
        r.ancanthoKet || ''
      ]);
    });

    (d.keluar || []).forEach(function (r) {
      var isDone = isMasukAncanthoDone(r);
      var st = validateKeluarItem(r, d, an.stockMap, false);
      keluarRows.push([
        whName,
        r.tgl || '',
        r.by || '',
        r.barcode || '',
        r.sku || '',
        r.nama || '',
        r.lok || '',
        r.exp || '',
        Number(r.qty || 0),
        st.text || '',
        isDone ? 'Done Transfer' : 'Menunggu Admin',
        r.ancanthoBy || '',
        r.ancanthoAt || '',
        r.ket || '',
        r.ancanthoKet || ''
      ]);
    });

    (d.pindah || []).forEach(function (r) {
      pindahRows.push([
        whName,
        r.tgl || '',
        r.by || '',
        r.barcode || '',
        r.sku || '',
        r.nama || '',
        r.dari || '',
        r.ke || '',
        Number(r.qty || 0),
        r.exp || '',
        r.ket || ''
      ]);
    });

    (d.batches || []).forEach(function (b) {
      var ei = b.exp ? classifyExpiry(b.exp, expMonths) : null;
      batchRows.push([
        whName,
        b.tglMasuk || '',
        b.lok || '',
        b.barcode || '',
        b.sku || '',
        b.nama || '',
        b.batch || '',
        b.exp || '',
        Number(b.qty || 0),
        b.status || 'AKTIF',
        ei ? ei.label : '',
        b.by || '',
        b.ket || ''
      ]);
    });

    (d.defect || []).forEach(function (df) {
      defectRows.push([
        whName,
        df.tgl || '',
        df.lok || '',
        df.barcode || '',
        df.sku || '',
        df.nama || '',
        df.kategori || 'LAINNYA',
        df.sumber || '',
        Number(df.qty || 0),
        df.status || 'KARANTINA',
        df.by || '',
        df.batch || '',
        df.exp || '',
        df.ket || ''
      ]);
    });

    (d.cycleCounts || []).forEach(function (sess) {
      var sm = computeCycleSessionMetrics(sess, d.cycleCounts);
      var sessStatus = sm.pendingItems === 0 && sm.totalItems > 0 ? 'Selesai' : 'Berjalan';
      (sm.rows || []).forEach(function (it) {
        cycleRows.push([
          whName,
          sess.tgl || '',
          sess.id || '',
          sessStatus,
          it.sku || '',
          it.barcode || '',
          it.nama || resolveProductCategory(it.sku, it.barcode, '', lookups) || '',
          it.lok || '',
          Number(it.stokWms || 0),
          it.stokFisik === null ? '' : Number(it.stokFisik),
          it.selisihHariIni === null ? '' : Number(it.selisihHariIni),
          it.selisihSebelumnya === null ? '' : Number(it.selisihSebelumnya),
          it.selisihTotal === null ? '' : Number(it.selisihTotal),
          it.pic || sess.pic || '',
          it.ket || ''
        ]);
      });
    });

    (d.inboundRegister || []).forEach(function (ib) {
      inboundRows.push([
        whName,
        ib.tgl || '',
        ib.supplier || '',
        ib.driver || '',
        ib.noPlat || '',
        ib.noDoc || '',
        ib.barcode || '',
        ib.sku || '',
        ib.nama || '',
        ib.exp || '',
        Number(ib.qty || 0)
      ]);
    });
  });

  var wb = XLSX.utils.book_new();
  var usedNames = Object.create(null);

  appendNeatSheet(wb, usedNames, 'Ringkasan Gudang', [
    'ID Gudang', 'Nama Gudang', 'Tanggal Cutoff', 'Mode Stok', 'Batas Min (PCS)', 'Target Cover (Hari)',
    'Batas Expire (Bln)', 'SKU Aktif', 'Total Stok Aktif (PCS)', 'Master Barang', 'Master Lokasi',
    'Stok Awal', 'Barang Masuk', 'Barang Keluar', 'Perpindahan Lokasi', 'Batch & Expire',
    'Defect & Karantina', 'Sesi Cycle Count', 'Surat Jalan Inbound'
  ], ringkasanRows);

  appendNeatSheet(wb, usedNames, 'Stok Aktif', [
    'Nama Gudang', 'Lokasi', 'Barcode', 'SKU', 'Nama Produk', 'Kategori',
    'Stok Aktif (PCS)', 'Status Stok', 'Expire Terdekat', 'Info Expire'
  ], stokAktifRows);

  appendNeatSheet(wb, usedNames, 'Master Barang', [
    'Nama Gudang', 'Barcode', 'SKU', 'Nama Produk', 'Kategori'
  ], masterRows);

  appendNeatSheet(wb, usedNames, 'Master Lokasi', [
    'Nama Gudang', 'Kode Lokasi'
  ], lokasiRows);

  appendNeatSheet(wb, usedNames, 'Stok Awal', [
    'Nama Gudang', 'Sumber', 'Lokasi', 'Barcode', 'SKU', 'Nama Produk', 'Qty (PCS)'
  ], stokAwalRows);

  appendNeatSheet(wb, usedNames, 'Barang Masuk', [
    'Nama Gudang', 'Tanggal', 'PIC Stockkeeper', 'Barcode', 'SKU', 'Nama Barang', 'Lokasi',
    'Expiry Date', 'Batch', 'Qty Stockkeeper', 'Stock Inbound', 'Status Match',
    'Status Ancantho', 'Admin Ancantho', 'Waktu Done', 'Keterangan Stockkeeper', 'Keterangan Admin'
  ], masukRows);

  appendNeatSheet(wb, usedNames, 'Barang Keluar', [
    'Nama Gudang', 'Tanggal', 'PIC Stockkeeper', 'Barcode', 'SKU', 'Nama Barang', 'Lokasi',
    'Expiry Date', 'Qty Keluar', 'Status Validasi', 'Status Ancantho',
    'Admin Ancantho', 'Waktu Done', 'Keterangan', 'Keterangan Admin'
  ], keluarRows);

  appendNeatSheet(wb, usedNames, 'Perpindahan Lokasi', [
    'Nama Gudang', 'Tanggal', 'PIC', 'Barcode', 'SKU', 'Nama Barang',
    'Dari Lokasi', 'Ke Lokasi', 'Qty (PCS)', 'Expiry Date', 'Keterangan'
  ], pindahRows);

  appendNeatSheet(wb, usedNames, 'Batch & Expire', [
    'Nama Gudang', 'Tanggal Masuk', 'Lokasi', 'Barcode', 'SKU', 'Nama Produk',
    'Batch', 'Expiry Date', 'Qty (PCS)', 'Status', 'Info Expire', 'PIC', 'Keterangan'
  ], batchRows);

  appendNeatSheet(wb, usedNames, 'Defect & Karantina', [
    'Nama Gudang', 'Tanggal', 'Lokasi', 'Barcode', 'SKU', 'Nama Produk',
    'Jenis / Alasan', 'Sumber', 'Qty (PCS)', 'Status', 'PIC', 'Batch', 'Expiry Date', 'Keterangan'
  ], defectRows);

  appendNeatSheet(wb, usedNames, 'Cycle Count', [
    'Nama Gudang', 'Tanggal Sesi', 'ID Sesi', 'Status Sesi', 'SKU', 'Barcode',
    'Nama Produk', 'Lokasi', 'Stok WMS', 'Stok Fisik', 'Selisih Hari Ini',
    'Selisih Sebelumnya', 'Selisih Total', 'PIC Hitung', 'Catatan'
  ], cycleRows);

  appendNeatSheet(wb, usedNames, 'Surat Jalan Inbound', [
    'Nama Gudang', 'Tanggal', 'Supplier', 'Driver', 'No Plat', 'No Doc',
    'Barcode', 'SKU', 'Nama Barang', 'Expired Date', 'Total Qty'
  ], inboundRows);

  var filename = 'Scarlett-Warehouse-Database-' + todayISO() + '.xlsx';
  XLSX.writeFile(wb, filename);
  showToast('Database Excel (.xlsx) diunduh: ' + whList.length + ' gudang, 12 sheet rapi', 'ok');
}
