import { computeCycleAccuracyOverview, computeCycleSessionMetrics, getMasukInboundMatch, isMasukAncanthoDone } from './cycleCountEngine.ts';
import { buildMasterLookups, classifyExpiry, fmtNum, normBarcode, normLoc, normSku, parseDate, parseExpDate, resolveProductCategory, stockKey, todayISO } from '../utils/format.ts';

// === MESIN KALKULASI STOK & VALIDASI KELUAR ===
export function findMasterByBarcode(master, bc) {
  var nb = normBarcode(bc);
  if (!nb) return null;
  for (var i = 0; i < master.length; i++) {
    if (normBarcode(master[i].barcode) === nb) return master[i];
  }
  return null;
}

export function findMasterBySku(master, sku) {
  var ns = normSku(sku);
  if (!ns) return null;
  for (var i = 0; i < master.length; i++) {
    if (normSku(master[i].sku) === ns) return master[i];
  }
  return null;
}

export function computeStockForMode(d: any, forceMode?: string) {
  var mode = forceMode || d.mode || 'mut';
  var cutoff = d.cutoff || '';
  var map = Object.create(null);

  function addQty(lok, barcode, sku, nama, delta) {
    var l = normLoc(lok);
    var s = normSku(sku);
    var b = normBarcode(barcode);
    if (!l || !s) return;
    var k = stockKey(l, s, b);
    if (!map[k]) {
      map[k] = {
        key: k,
        lok: l,
        barcode: b,
        sku: s,
        nama: String(nama || '').trim(),
        qty: 0
      };
    } else {
      if (!map[k].barcode && b) map[k].barcode = b;
      if (!map[k].nama && nama) map[k].nama = String(nama).trim();
    }
    map[k].qty += Number(delta || 0);
  }

  if (mode === 'all') {
    (d.allstock || []).forEach(function (r) {
      addQty(r.lok, r.barcode, r.sku, r.nama, r.qty);
    });
    (d.masuk || []).forEach(function (r) {
      if (r.n === 1 && r.tgl && (!cutoff || r.tgl >= cutoff)) {
        addQty(r.lok, r.barcode, r.sku, r.nama, r.qty);
      }
    });
    (d.keluar || []).forEach(function (r) {
      if (r.n === 1 && r.tgl && (!cutoff || r.tgl >= cutoff)) {
        addQty(r.lok, r.barcode, r.sku, r.nama, -Math.abs(Number(r.qty || 0)));
      }
    });
    (d.pindah || []).forEach(function (r) {
      if (r.n === 1 && r.tgl && (!cutoff || r.tgl >= cutoff)) {
        var q = Math.abs(Number(r.qty || 0));
        addQty(r.dari, r.barcode, r.sku, r.nama, -q);
        addQty(r.ke, r.barcode, r.sku, r.nama, q);
      }
    });
  } else {
    (d.opening || []).forEach(function (r) {
      addQty(r.lok, r.barcode, r.sku, r.nama, r.qty);
    });
    (d.masuk || []).forEach(function (r) {
      if (r.tgl && (!cutoff || r.tgl >= cutoff)) {
        addQty(r.lok, r.barcode, r.sku, r.nama, r.qty);
      }
    });
    (d.keluar || []).forEach(function (r) {
      if (r.tgl && (!cutoff || r.tgl >= cutoff)) {
        addQty(r.lok, r.barcode, r.sku, r.nama, -Math.abs(Number(r.qty || 0)));
      }
    });
    (d.pindah || []).forEach(function (r) {
      if (r.tgl && (!cutoff || r.tgl >= cutoff)) {
        var q = Math.abs(Number(r.qty || 0));
        addQty(r.dari, r.barcode, r.sku, r.nama, -q);
        addQty(r.ke, r.barcode, r.sku, r.nama, q);
      }
    });
  }
  return map;
}

export function validateKeluarItem(row: any, d: any, stockMap: any, isDraftPreview?: boolean) {
  var tgl = parseDate(row.tgl);
  if (!tgl) {
    return { cls: 'warn', text: '⚠️ TANGGAL WAJIB DIISI / INVALID', ok: false };
  }
  if (d.cutoff && tgl < d.cutoff) {
    return { cls: 'neutral', text: '🕘 HISTORICAL — DI LUAR PERIODE AKTIF', ok: true, historical: true };
  }
  var sku = normSku(row.sku);
  if (!sku) {
    return { cls: 'warn', text: '⚠️ SKU TIDAK TERBACA', ok: false };
  }
  var qty = Number(row.qty || 0);
  if (!(qty > 0)) {
    return { cls: 'warn', text: '⚠️ QTY TIDAK VALID', ok: false };
  }
  var loc = normLoc(row.lok);
  var locSet = new Set((d.lokasi || []).map(normLoc));
  if (!loc || !locSet.has(loc)) {
    if (loc && loc.endsWith('.') && locSet.has(loc.slice(0, -1).trim())) {
      return { cls: 'err', text: '❌ TYPO LOKASI — CEK ' + loc.slice(0, -1).trim(), ok: false };
    }
    return { cls: 'warn', text: '⚠️ LOKASI BELUM ADA DI MASTER', ok: false };
  }
  var k = stockKey(loc, sku, row.barcode);
  var curQty = stockMap[k] ? Number(stockMap[k].qty || 0) : 0;
  var sisa = isDraftPreview ? (curQty - qty) : curQty;
  if (sisa < 0) {
    return { cls: 'err', text: '❌ STOK MINUS ' + fmtNum(Math.abs(sisa)) + ' PCS', ok: false };
  }
  return { cls: 'ok', text: '✅ SESUAI — SISA ' + fmtNum(sisa) + ' PCS', ok: true };
}

export function computeWarehouseAnalysis(d) {
  var stockMap = computeStockForMode(d);
  var rows = Object.keys(stockMap).map(function (k) { return stockMap[k]; });
  var locSet = new Set((d.lokasi || []).map(normLoc).filter(Boolean));
  var minThresh = Number(d.min || 0);
  var today = todayISO();
  var masterLookups = buildMasterLookups(d.master);

  var skuSet = new Set();
  var filledLocs = new Set();
  var totalPcs = 0;
  var lowList = [];
  var minusList = [];
  var skuMap = Object.create(null);

  rows.forEach(function (r) {
    r.kategori = resolveProductCategory(r.sku, r.barcode, r.nama, masterLookups);
    if (r.qty > 0) {
      skuSet.add(r.sku);
      filledLocs.add(r.lok);
      totalPcs += r.qty;
      if (r.qty <= minThresh) lowList.push(r);
    } else if (r.qty < 0) {
      minusList.push(r);
    }
    if (!skuMap[r.sku]) {
      skuMap[r.sku] = { sku: r.sku, barcode: r.barcode, nama: r.nama, kategori: r.kategori, qty: 0 };
    }
    skuMap[r.sku].qty += r.qty;
    if (!skuMap[r.sku].nama && r.nama) skuMap[r.sku].nama = r.nama;
  });

  var occupiedMasterLocations = 0;
  filledLocs.forEach(function (location) {
    if (locSet.has(location)) occupiedMasterLocations++;
  });

  var criticalThresh = Math.max(1, Math.floor(minThresh / 2));
  var lowCatMap = Object.create(null);
  lowList.forEach(function (r) {
    var cat = r.kategori || 'Lainnya';
    if (!lowCatMap[cat]) {
      lowCatMap[cat] = {
        kategori: cat,
        itemCount: 0,
        skuSet: new Set(),
        criticalCount: 0,
        totalQty: 0,
        minQty: r.qty,
        lowestItem: r,
        items: []
      };
    }
    var g = lowCatMap[cat];
    g.itemCount += 1;
    g.skuSet.add(r.sku);
    if (r.qty <= criticalThresh) g.criticalCount += 1;
    g.totalQty += r.qty;
    if (r.qty < g.minQty) {
      g.minQty = r.qty;
      g.lowestItem = r;
    }
    g.items.push(r);
  });
  var lowByCategory = Object.keys(lowCatMap).map(function (cat) {
    var g = lowCatMap[cat];
    g.items.sort(function (a, b) { return a.qty - b.qty; });
    return {
      kategori: g.kategori,
      itemCount: g.itemCount,
      skuCount: g.skuSet.size,
      criticalCount: g.criticalCount,
      totalQty: g.totalQty,
      minQty: g.minQty,
      lowestItem: g.lowestItem,
      items: g.items
    };
  }).sort(function (a, b) {
    if (a.minQty !== b.minQty) return a.minQty - b.minQty;
    if (b.criticalCount !== a.criticalCount) return b.criticalCount - a.criticalCount;
    if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount;
    if (a.totalQty !== b.totalQty) return a.totalQty - b.totalQty;
    return a.kategori.localeCompare(b.kategori);
  });

  var masukToday = 0;
  var keluarToday = 0;
  var histCount = 0;
  (d.masuk || []).forEach(function (r) {
    if (r.tgl === today) masukToday += Number(r.qty || 0);
    if (d.cutoff && r.tgl && r.tgl < d.cutoff) histCount++;
  });
  (d.keluar || []).forEach(function (r) {
    if (r.tgl === today) keluarToday += Number(r.qty || 0);
    if (d.cutoff && r.tgl && r.tgl < d.cutoff) histCount++;
  });
  (d.pindah || []).forEach(function (r) {
    if (d.cutoff && r.tgl && r.tgl < d.cutoff) histCount++;
  });

  var keluarBermasalah = [];
  (d.keluar || []).forEach(function (r) {
    var v = validateKeluarItem(r, d, stockMap, false);
    if (!v.ok) keluarBermasalah.push({ row: r, status: v });
  });

  var badLocTx = [];
  (d.masuk || []).forEach(function (r) {
    var l = normLoc(r.lok);
    if (!l || !locSet.has(l)) badLocTx.push({ jenis: 'Masuk', tgl: r.tgl, lok: r.lok || '(Kosong)', sku: r.sku, qty: r.qty });
  });
  (d.keluar || []).forEach(function (r) {
    var l = normLoc(r.lok);
    if (!l || !locSet.has(l)) badLocTx.push({ jenis: 'Keluar', tgl: r.tgl, lok: r.lok || '(Kosong)', sku: r.sku, qty: r.qty });
  });
  (d.pindah || []).forEach(function (r) {
    var d1 = normLoc(r.dari);
    var d2 = normLoc(r.ke);
    if (!d1 || !locSet.has(d1)) badLocTx.push({ jenis: 'Pindah (Dari)', tgl: r.tgl, lok: r.dari || '(Kosong)', sku: r.sku, qty: r.qty });
    if (!d2 || !locSet.has(d2)) badLocTx.push({ jenis: 'Pindah (Ke)', tgl: r.tgl, lok: r.ke || '(Kosong)', sku: r.sku, qty: r.qty });
  });

  var masterBcSet = new Set((d.master || []).map(function (m) { return normBarcode(m.barcode); }).filter(Boolean));
  var unknownMasukBc = [];
  (d.masuk || []).forEach(function (r) {
    var b = normBarcode(r.barcode);
    if (b && !masterBcSet.has(b)) unknownMasukBc.push(r);
  });

  var bcCount = Object.create(null);
  (d.master || []).forEach(function (m) {
    var b = normBarcode(m.barcode);
    if (!b) return;
    if (!bcCount[b]) bcCount[b] = [];
    bcCount[b].push(m);
  });
  var dupBarcodes = [];
  Object.keys(bcCount).forEach(function (b) {
    if (bcCount[b].length > 1) {
      dupBarcodes.push({ barcode: b, count: bcCount[b].length, items: bcCount[b] });
    }
  });

  var expMonths = Number(d.expMonths || 7);
  var batchRows = [];
  var expAlerts = [];
  var expiredList = [];
  var expSoonList = [];
  var expAlertPcs = 0;
  var skuExpMap = Object.create(null);

  (d.batches || []).forEach(function (b) {
    if (!b || b.status === 'HABIS' || !(Number(b.qty || 0) > 0)) return;
    var expIso = parseExpDate(b.exp);
    var info = classifyExpiry(expIso, expMonths);
    var item = Object.assign({}, b, {
      exp: expIso,
      qty: Number(b.qty || 0),
      expInfo: info
    });
    batchRows.push(item);
    if (info.isAlert) {
      expAlerts.push(item);
      expAlertPcs += item.qty;
      if (info.status === 'expired') expiredList.push(item);
      else expSoonList.push(item);
    }
    var s = normSku(b.sku);
    if (s && (!skuExpMap[s] || (expIso && (!skuExpMap[s].exp || expIso < skuExpMap[s].exp)))) {
      skuExpMap[s] = item;
    }
  });

  batchRows.sort(function (a, b) {
    if (!a.exp && !b.exp) return 0;
    if (!a.exp) return 1;
    if (!b.exp) return -1;
    return a.exp.localeCompare(b.exp);
  });
  expAlerts.sort(function (a, b) {
    return a.expInfo.daysLeft - b.expInfo.daysLeft;
  });

  var defectRows = (d.defect || []).slice();
  var defectActive = defectRows.filter(function (x) { return (x.status || 'KARANTINA') === 'KARANTINA'; });
  var defectActivePcs = defectActive.reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);

  var perluCek = keluarBermasalah.length + minusList.length + badLocTx.length + unknownMasukBc.length + dupBarcodes.length;

  var ccList = Array.isArray(d.cycleCounts) ? d.cycleCounts : [];
  var latestCc = ccList.slice().sort(function (a, b) { return String(b.tgl || '').localeCompare(String(a.tgl || '')); })[0] || null;
  var latestCcMetrics = latestCc ? computeCycleSessionMetrics(latestCc, ccList) : null;
  var ccTodaySession = ccList.find(function (s) { return s.tgl === today; }) || null;
  var ccTodayMetrics = ccTodaySession ? computeCycleSessionMetrics(ccTodaySession, ccList) : null;
  var masukPendingRows = (d.masuk || []).filter(function (r) { return !isMasukAncanthoDone(r); });
  var masukPending = masukPendingRows.length;
  var masukPendingPcs = 0;
  var inboundMatched = 0;
  var inboundMismatch = 0;
  var inboundUnfilled = 0;
  masukPendingRows.forEach(function (r) {
    masukPendingPcs += Number(r.qty || 0);
    var im = getMasukInboundMatch(r);
    if (im.matched) inboundMatched += 1;
    else if (im.hasInbound) inboundMismatch += 1;
    else inboundUnfilled += 1;
  });
  var keluarPending = (d.keluar || []).filter(function (r) { return !isMasukAncanthoDone(r); }).length;
  var pindahTodayRows = (d.pindah || []).filter(function (r) { return r.tgl === today; });
  var pindahTodayCount = pindahTodayRows.length;
  var pindahTodayQty = pindahTodayRows.reduce(function (s, r) { return s + Number(r.qty || 0); }, 0);

  return {
    stockMap: stockMap,
    rows: rows,
    skuMap: skuMap,
    lowList: lowList.sort(function (a, b) { return a.qty - b.qty; }),
    lowByCategory: lowByCategory,
    minusList: minusList.sort(function (a, b) { return a.qty - b.qty; }),
    keluarBermasalah: keluarBermasalah,
    badLocTx: badLocTx,
    unknownMasukBc: unknownMasukBc,
    dupBarcodes: dupBarcodes,
    histCount: histCount,
    batchRows: batchRows,
    expAlerts: expAlerts,
    expiredList: expiredList,
    expSoonList: expSoonList,
    expAlertPcs: expAlertPcs,
    skuExpMap: skuExpMap,
    defectRows: defectRows,
    defectActive: defectActive,
    defectActivePcs: defectActivePcs,
    cycleOverview: computeCycleAccuracyOverview(ccList),
    latestCycle: latestCc ? { session: latestCc, metrics: latestCcMetrics } : null,
    todayCycle: ccTodaySession ? { session: ccTodaySession, metrics: ccTodayMetrics } : null,
    stats: {
      skuAktif: skuSet.size,
      totalPcs: totalPcs,
      lokasiTerisi: filledLocs.size,
      totalLokasi: locSet.size,
      lokasiMasterTerisi: occupiedMasterLocations,
      masukToday: masukToday,
      masukPending: masukPending,
      masukPendingPcs: masukPendingPcs,
      inboundMatched: inboundMatched,
      inboundMismatch: inboundMismatch,
      inboundUnfilled: inboundUnfilled,
      keluarToday: keluarToday,
      keluarPending: keluarPending,
      pindahTodayCount: pindahTodayCount,
      pindahTodayQty: pindahTodayQty,
      lowCount: lowList.length,
      lowCategoryCount: lowByCategory.length,
      minusCount: minusList.length,
      perluCek: perluCek,
      expAlertCount: expAlerts.length,
      expiredCount: expiredList.length,
      expSoonCount: expSoonList.length,
      expAlertPcs: expAlertPcs,
      defectCount: defectActive.length,
      defectPcs: defectActivePcs,
      ccPendingToday: ccTodayMetrics ? ccTodayMetrics.pendingItems : (latestCcMetrics ? latestCcMetrics.pendingItems : 0),
      ccUnitAccuracy: latestCcMetrics ? latestCcMetrics.unitAccuracyPct : null,
      ccSkuAccuracy: latestCcMetrics ? latestCcMetrics.skuAccuracyPct : null,
      ccCountedLatest: latestCcMetrics ? latestCcMetrics.countedItems : 0,
      ccTotalLatest: latestCcMetrics ? latestCcMetrics.totalItems : 0
    }
  };
}

export function buildFefoLocationSuggestions(sku, barcode, d, an) {
  var wantSku = normSku(sku);
  var wantBc = normBarcode(barcode);
  if (!wantSku && !wantBc) return [];
  var stockMatches = (an.rows || []).filter(function (r) {
    if (!(r.qty > 0)) return false;
    if (wantBc && normBarcode(r.barcode) === wantBc) return true;
    if (wantSku === '5000054' && wantBc) return false;
    return wantSku && normSku(r.sku) === wantSku;
  });
  var enriched = stockMatches.map(function (r) {
    var locBatches = (an.batchRows || []).filter(function (b) {
      if (!(b.qty > 0)) return false;
      var matchProd = (wantBc && normBarcode(b.barcode) === wantBc) || (wantSku && normSku(b.sku) === wantSku);
      if (!matchProd) return false;
      return !b.lok || normLoc(b.lok) === normLoc(r.lok);
    }).sort(function (a, b) {
      if (!a.exp && !b.exp) return 0;
      if (!a.exp) return 1;
      if (!b.exp) return -1;
      return a.exp.localeCompare(b.exp);
    });
    var masukExpRows = (d.masuk || []).filter(function (m) {
      if (!m || !m.exp) return false;
      if (normLoc(m.lok) !== normLoc(r.lok)) return false;
      if (wantBc && normBarcode(m.barcode) === wantBc) return true;
      if (wantSku === '5000054' && wantBc) return false;
      return wantSku && normSku(m.sku) === wantSku;
    }).map(function (m) {
      return parseExpDate(m.exp);
    }).filter(Boolean).sort();
    var topBatch = locBatches[0] || null;
    var resolvedExp = (topBatch && topBatch.exp) || masukExpRows[0] || (wantSku && an.skuExpMap[wantSku] ? an.skuExpMap[wantSku].exp : '') || '';
    return {
      key: r.key,
      lok: r.lok,
      sku: r.sku,
      barcode: r.barcode,
      nama: r.nama,
      qty: Number(r.qty || 0),
      exp: resolvedExp,
      expInfo: (topBatch && topBatch.expInfo) ? topBatch.expInfo : (resolvedExp ? classifyExpiry(resolvedExp, Number(d.expMonths || 7)) : null)
    };
  });
  enriched.sort(function (a, b) {
    if (a.exp && b.exp && a.exp !== b.exp) return a.exp.localeCompare(b.exp);
    if (a.exp && !b.exp) return -1;
    if (!a.exp && b.exp) return 1;
    if (a.qty !== b.qty) return a.qty - b.qty;
    return a.lok.localeCompare(b.lok);
  });
  return enriched.map(function (item, idx) {
    return Object.assign({}, item, { isFefoTop: idx === 0 });
  });
}
