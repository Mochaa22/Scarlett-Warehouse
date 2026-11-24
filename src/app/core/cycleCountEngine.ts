import { fmtNum, normSku } from '../utils/format.ts';

// === MESIN CYCLE COUNT HARIAN & AKURASI ===
export const INDO_MONTHS_UPPER = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];

export function formatIndoDateUpper(iso) {
  var p = String(iso || '').split('-').map(Number);
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return String(iso || '').toUpperCase();
  return p[2] + ' ' + (INDO_MONTHS_UPPER[p[1] - 1] || '') + ' ' + p[0];
}

export function getPrevCycleVariance(cycleCounts, targetTgl, currentSessionId, sku, currentCreatedAt) {
  var wantSku = normSku(sku);
  if (!wantSku || !Array.isArray(cycleCounts)) return null;
  var ordered = cycleCounts.slice().sort(function (a, b) {
    var c = String(b.tgl || '').localeCompare(String(a.tgl || ''));
    if (c !== 0) return c;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  for (var i = 0; i < ordered.length; i++) {
    var s = ordered[i];
    if (!s || s.id === currentSessionId) continue;
    if (targetTgl && s.tgl && s.tgl > targetTgl) continue;
    if (targetTgl && s.tgl === targetTgl && currentCreatedAt && s.createdAt && s.createdAt >= currentCreatedAt) continue;
    var items = s.items || [];
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (normSku(it.sku) !== wantSku) continue;
      if (it.stokFisik !== null && it.stokFisik !== undefined && it.stokFisik !== '' && isFinite(Number(it.stokFisik))) {
        return Number(it.stokFisik) - Number(it.stokWms || 0);
      }
    }
  }
  return null;
}

export function computeCycleSessionMetrics(session, cycleCounts) {
  var items = (session && Array.isArray(session.items)) ? session.items : [];
  var countedItems = 0;
  var matchedItems = 0;
  var diffItems = 0;
  var todayDiffItems = 0;
  var totalWms = 0;
  var totalFisik = 0;
  var absDiffTotal = 0;
  var netTodayDiff = 0;
  var absTodayDiff = 0;

  var rows = items.map(function (it) {
    var hasFisik = it.stokFisik !== null && it.stokFisik !== undefined && it.stokFisik !== '' && isFinite(Number(it.stokFisik));
    var wms = Number(it.stokWms || 0);
    var fisik = hasFisik ? Number(it.stokFisik) : null;
    var selisihTotal = hasFisik ? (fisik - wms) : null;
    var hasPrevOverride = it.selisihSebelumnya !== null && it.selisihSebelumnya !== undefined && it.selisihSebelumnya !== '' && isFinite(Number(it.selisihSebelumnya));
    var selisihSebelumnya = hasPrevOverride ? Number(it.selisihSebelumnya) : getPrevCycleVariance(cycleCounts, session.tgl, session.id, it.sku, session.createdAt);
    var selisihHariIni = hasFisik ? (selisihSebelumnya !== null ? (selisihTotal - selisihSebelumnya) : selisihTotal) : null;
    var isExactMatch = hasFisik && selisihTotal === 0;

    if (hasFisik) {
      countedItems += 1;
      totalWms += wms;
      totalFisik += fisik;
      absDiffTotal += Math.abs(selisihTotal);
      if (isExactMatch) matchedItems += 1;
      else diffItems += 1;
      netTodayDiff += selisihHariIni;
      absTodayDiff += Math.abs(selisihHariIni);
      if (selisihHariIni !== 0) todayDiffItems += 1;
    }

    return Object.assign({}, it, {
      stokWms: wms,
      stokFisik: fisik,
      counted: hasFisik,
      selisihTotal: selisihTotal,
      selisihSebelumnya: selisihSebelumnya,
      selisihHariIni: selisihHariIni,
      isExactMatch: isExactMatch
    });
  });

  var totalItems = rows.length;
  var pendingItems = totalItems - countedItems;
  var skuAccuracyPct = countedItems > 0 ? (matchedItems / countedItems) * 100 : null;
  var unitAccuracyPct = countedItems > 0
    ? ((totalWms === 0 && totalFisik === 0) ? 100 : Math.max(0, (1 - absDiffTotal / Math.max(1, totalWms, totalFisik)) * 100))
    : null;
  var progressPct = totalItems > 0 ? (countedItems / totalItems) * 100 : 0;

  return {
    rows: rows,
    totalItems: totalItems,
    countedItems: countedItems,
    pendingItems: pendingItems,
    matchedItems: matchedItems,
    diffItems: diffItems,
    todayDiffItems: todayDiffItems,
    totalWms: totalWms,
    totalFisik: totalFisik,
    absDiffTotal: absDiffTotal,
    netTodayDiff: netTodayDiff,
    absTodayDiff: absTodayDiff,
    skuAccuracyPct: skuAccuracyPct,
    unitAccuracyPct: unitAccuracyPct,
    progressPct: progressPct
  };
}

export function computeCycleAccuracyOverview(cycleCounts) {
  var sessions = Array.isArray(cycleCounts) ? cycleCounts.slice() : [];
  sessions.sort(function (a, b) {
    return String(a.tgl || '').localeCompare(String(b.tgl || ''));
  });
  var trend = [];
  var petugasMap = Object.create(null);
  var skuDiffMap = Object.create(null);

  sessions.forEach(function (s) {
    var m = computeCycleSessionMetrics(s, cycleCounts);
    trend.push({
      id: s.id,
      tgl: s.tgl,
      status: s.status || 'AKTIF',
      totalItems: m.totalItems,
      countedItems: m.countedItems,
      matchedItems: m.matchedItems,
      diffItems: m.diffItems,
      todayDiffItems: m.todayDiffItems,
      skuAccuracyPct: m.skuAccuracyPct,
      unitAccuracyPct: m.unitAccuracyPct,
      absDiffTotal: m.absDiffTotal,
      netTodayDiff: m.netTodayDiff
    });

    m.rows.forEach(function (r) {
      if (!r.counted) return;
      var who = String(r.countedBy || r.assignedTo || 'Belum Tercatat').trim() || 'Belum Tercatat';
      if (!petugasMap[who]) {
        petugasMap[who] = { petugas: who, counted: 0, matched: 0, absDiff: 0, totalWms: 0, totalFisik: 0 };
      }
      var p = petugasMap[who];
      p.counted += 1;
      if (r.isExactMatch) p.matched += 1;
      p.absDiff += Math.abs(r.selisihTotal);
      p.totalWms += r.stokWms;
      p.totalFisik += r.stokFisik;

      var sk = normSku(r.sku);
      if (!skuDiffMap[sk]) {
        skuDiffMap[sk] = { sku: sk, nama: r.nama || '', sessions: 0, diffSessions: 0, absSumDiff: 0, lastDiff: 0, lastTgl: '' };
      }
      var sd = skuDiffMap[sk];
      sd.sessions += 1;
      if (!sd.nama && r.nama) sd.nama = r.nama;
      if (r.selisihTotal !== 0) {
        sd.diffSessions += 1;
        sd.absSumDiff += Math.abs(r.selisihTotal);
      }
      if (!sd.lastTgl || (s.tgl && s.tgl >= sd.lastTgl)) {
        sd.lastTgl = s.tgl || '';
        sd.lastDiff = r.selisihTotal;
      }
    });
  });

  var byPetugas = Object.keys(petugasMap).map(function (k) {
    var p = petugasMap[k];
    var skuAcc = p.counted > 0 ? (p.matched / p.counted) * 100 : 0;
    var unitAcc = p.counted > 0
      ? ((p.totalWms === 0 && p.totalFisik === 0) ? 100 : Math.max(0, (1 - p.absDiff / Math.max(1, p.totalWms, p.totalFisik)) * 100))
      : 0;
    return Object.assign({}, p, { skuAccuracyPct: skuAcc, unitAccuracyPct: unitAcc });
  }).sort(function (a, b) { return b.counted - a.counted; });

  var topDiffSkus = Object.keys(skuDiffMap).map(function (k) { return skuDiffMap[k]; })
    .filter(function (x) { return x.diffSessions > 0; })
    .sort(function (a, b) {
      if (b.diffSessions !== a.diffSessions) return b.diffSessions - a.diffSessions;
      return b.absSumDiff - a.absSumDiff;
    });

  return { trend: trend, byPetugas: byPetugas, topDiffSkus: topDiffSkus };
}

export function csvCell(v) {
  var s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCycleCountCSV(session, cycleCounts, whName) {
  var metrics = computeCycleSessionMetrics(session, cycleCounts);
  var title = 'STOK AKHIR ' + String(whName || 'ONLINE WAREHOUSE').toUpperCase() + ' ' + formatIndoDateUpper(session.tgl);
  var lines = [
    [title, '', '', '', '', ''].map(csvCell).join(','),
    ['SKU', 'NAMA PRODUK', 'STOK WMS', 'STOK FISIK', 'SELISIH HARI INI', 'SELISIH SEBELUMNYA'].map(csvCell).join(',')
  ];
  metrics.rows.forEach(function (r) {
    lines.push([
      r.sku,
      r.nama || '',
      r.stokWms,
      r.counted ? r.stokFisik : '',
      r.counted ? r.selisihHariIni : '',
      r.selisihSebelumnya !== null ? r.selisihSebelumnya : ''
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}

export function downloadCSVFile(filename, csvText) {
  try {
    var blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
    return true;
  } catch (e) {
    return false;
  }
}

export function isMasukAncanthoDone(r) {
  if (!r) return false;
  if (typeof r.ancanthoDone === 'boolean') return r.ancanthoDone;
  return r.n !== 1;
}

export function getMasukInboundMatch(r) {
  var qtySk = Number((r && r.qty) || 0);
  var hasInb = r && r.inboundQty !== null && r.inboundQty !== undefined && r.inboundQty !== '' && isFinite(Number(r.inboundQty));
  if (!hasInb) {
    return { hasInbound: false, inboundQty: null, diff: null, matched: false, label: 'Belum Diisi', cls: 'badge-neutral' };
  }
  var inb = Number(r.inboundQty);
  var diff = qtySk - inb;
  if (diff === 0) {
    return { hasInbound: true, inboundQty: inb, diff: 0, matched: true, label: '✓ Match', cls: 'badge-ok' };
  }
  return {
    hasInbound: true,
    inboundQty: inb,
    diff: diff,
    matched: false,
    label: 'Selisih ' + (diff > 0 ? '+' : '') + fmtNum(diff),
    cls: 'badge-warn'
  };
}
