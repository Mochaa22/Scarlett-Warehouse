export function uid() {
  return 'tx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addDaysISO(baseIso, delta) {
  var p = baseIso.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addMonthsISO(baseIso, months) {
  var p = baseIso.split('-').map(Number);
  var target = new Date(p[0], p[1] - 1 + Number(months || 0), 1);
  var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  var day = Math.min(p[2], lastDay);
  return target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

export function daysBetweenISO(fromIso, toIso) {
  var a = fromIso.split('-').map(Number);
  var b = toIso.split('-').map(Number);
  var t1 = Date.UTC(a[0], a[1] - 1, a[2]);
  var t2 = Date.UTC(b[0], b[1] - 1, b[2]);
  return Math.round((t2 - t1) / 86400000);
}

export function formatSisaWaktu(daysLeft) {
  if (daysLeft < 0) return 'Lewat ' + Math.abs(daysLeft) + ' hr';
  if (daysLeft === 0) return 'Hari ini';
  if (daysLeft < 30) return daysLeft + ' hr';
  var bln = Math.floor(daysLeft / 30);
  var sisaHr = daysLeft % 30;
  return sisaHr > 0 ? (bln + ' bln ' + sisaHr + ' hr') : (bln + ' bln');
}

export function defaultCutoffISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}

export function fmtNum(n) {
  var v = Number(n || 0);
  return v.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

// === NORMALISASI & PARSER ===
export function normBarcode(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  if (s === '8997236031231NEW') return '8997236031231';
  return s;
}

export function normLoc(v) {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' ');
}

export function normSku(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

export function parseQty(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v).trim().replace(/\s+/g, '');
  if (!s) return 0;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d+,\d+$/.test(s)) {
    s = s.replace(',', '.');
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  var n = Number(s);
  return isFinite(n) ? n : 0;
}

export const MONTH_MAP = {
  JAN: 1, JANUARI: 1, JANUARY: 1,
  FEB: 2, PEB: 2, FEBRUARI: 2, FEBRUARY: 2,
  MAR: 3, MARET: 3, MARCH: 3,
  APR: 4, APRIL: 4,
  MEI: 5, MAY: 5,
  JUN: 6, JUNI: 6, JUNE: 6,
  JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGS: 8, AUG: 8, AGUSTUS: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OCT: 10, OKTOBER: 10, OCTOBER: 10,
  NOV: 11, NOP: 11, NOVEMBER: 11,
  DES: 12, DEC: 12, DESEMBER: 12, DECEMBER: 12
};

export function validYMD(y, m, d) {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

export function parseDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    return validYMD(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number' && isFinite(v) && v > 1000 && v < 2958465) {
    var utc = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return validYMD(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  }
  var s = String(v).trim();
  if (!s) return '';
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    var serial = Number(s);
    if (serial > 1000 && serial < 2958465) {
      var utc2 = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
      return validYMD(utc2.getUTCFullYear(), utc2.getUTCMonth() + 1, utc2.getUTCDate());
    }
  }
  var m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m1) return validYMD(+m1[1], +m1[2], +m1[3]);
  var m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m2) {
    var yr = +m2[3];
    if (yr < 100) yr += 2000;
    return validYMD(yr, +m2[2], +m2[1]);
  }
  var m3 = s.toUpperCase().replace(/[,]/g, ' ').match(/^(\d{1,2})[\s\-]+([A-Z]+)[\s\-]+(\d{2,4})$/);
  if (m3 && MONTH_MAP[m3[2]]) {
    var yr3 = +m3[3];
    if (yr3 < 100) yr3 += 2000;
    return validYMD(yr3, MONTH_MAP[m3[2]], +m3[1]);
  }
  return '';
}

export function parseExpDate(v) {
  var exact = parseDate(v);
  if (exact) return exact;
  if (v == null || v === '') return '';
  var s = String(v).trim().toUpperCase();
  var mYM = s.match(/^(\d{4})[-\/](\d{1,2})$/);
  if (mYM) {
    var yr1 = +mYM[1], mo1 = +mYM[2];
    if (yr1 >= 1990 && yr1 <= 2100 && mo1 >= 1 && mo1 <= 12) {
      var last1 = new Date(yr1, mo1, 0).getDate();
      return validYMD(yr1, mo1, last1);
    }
  }
  var mMY = s.match(/^(\d{1,2})[-\/](\d{2,4})$/);
  if (mMY) {
    var mo2 = +mMY[1], yr2 = +mMY[2];
    if (yr2 < 100) yr2 += 2000;
    if (yr2 >= 1990 && yr2 <= 2100 && mo2 >= 1 && mo2 <= 12) {
      var last2 = new Date(yr2, mo2, 0).getDate();
      return validYMD(yr2, mo2, last2);
    }
  }
  var mMon = s.replace(/[,]/g, ' ').match(/^([A-Z]+)[\s\-]+(\d{2,4})$/);
  if (mMon && MONTH_MAP[mMon[1]]) {
    var mo3 = MONTH_MAP[mMon[1]], yr3 = +mMon[2];
    if (yr3 < 100) yr3 += 2000;
    if (yr3 >= 1990 && yr3 <= 2100) {
      var last3 = new Date(yr3, mo3, 0).getDate();
      return validYMD(yr3, mo3, last3);
    }
  }
  return '';
}

export function classifyExpiry(expIso, expMonths) {
  var months = Number(expMonths || 7);
  if (!expIso) return { status: 'none', isAlert: false, daysLeft: 99999, badgeCls: 'badge-neutral', label: 'Tanpa Expire' };
  var today = todayISO();
  var daysLeft = daysBetweenISO(today, expIso);
  var warnCutoff = addMonthsISO(today, months);
  var critCutoff = addMonthsISO(today, Math.min(3, months));
  if (expIso <= today) {
    return {
      status: 'expired',
      isAlert: true,
      daysLeft: daysLeft,
      badgeCls: 'badge-err',
      label: daysLeft === 0 ? 'EXPIRE HARI INI' : ('EXPIRED (' + Math.abs(daysLeft) + ' hr lalu)')
    };
  }
  if (expIso < critCutoff) {
    return {
      status: 'crit',
      isAlert: true,
      daysLeft: daysLeft,
      badgeCls: 'badge-err',
      label: 'Kritis (< 3 Bln) · ' + formatSisaWaktu(daysLeft)
    };
  }
  if (expIso < warnCutoff) {
    return {
      status: 'warn',
      isAlert: true,
      daysLeft: daysLeft,
      badgeCls: 'badge-warn',
      label: '< ' + months + ' Bln · ' + formatSisaWaktu(daysLeft)
    };
  }
  return {
    status: 'ok',
    isAlert: false,
    daysLeft: daysLeft,
    badgeCls: 'badge-ok',
    label: 'Aman · ' + formatSisaWaktu(daysLeft)
  };
}

export function stockKey(lok, sku, barcode) {
  var l = normLoc(lok);
  var s = normSku(sku);
  var b = normBarcode(barcode);
  if (s === '5000054') return l + '|' + s + '|' + b;
  return l + '|' + s;
}

export function inferProductCategory(nama: any, explicitKategori?: any) {
  var exp = String(explicitKategori || '').trim().replace(/\s+/g, ' ');
  if (exp) return exp;
  var s = String(nama || '').toUpperCase();
  if (!s) return 'Lainnya';
  if (/SHOWER\s*SCRUB|BODY\s*WASH|SABUN/.test(s)) return 'Shower Scrub';
  if (/BODY\s*SCRUB|\bLULUR\b|\bSCRUB\b/.test(s)) return 'Body Scrub';
  if (/BODY\s*LOTION|\bLOTION\b/.test(s)) return 'Body Lotion';
  if (/BODY\s*CREAM/.test(s)) return 'Body Cream';
  if (/PARFUM|PERFUME|EAU\s*DE|FRAGRANCE|BODY\s*MIST/.test(s)) return 'Parfum';
  if (/TONER|ESSENCE|FACE\s*MIST|\bMIST\b/.test(s)) return 'Toner & Essence';
  if (/FACIAL\s*WASH|CLEANSER|MICELLAR/.test(s)) return 'Facial Wash';
  if (/SUNSCREEN|SUNBLOCK|SUN\s*GEL|\bSPF\b/.test(s)) return 'Sunscreen';
  if (/LIP\s*(?:SERUM|BALM|TINT|CREAM|OIL|MASK)/.test(s)) return 'Lip Care';
  if (/SHAMPOO|CONDITIONER|HAIR\s*(?:TONIC|SERUM|OIL|MASK)/.test(s)) return 'Hair Care';
  if (/MASKER|\bMASK\b/.test(s)) return 'Masker';
  if (/\bSERUM\b|BOOSTER/.test(s)) return 'Serum';
  if (/DAY\s*CREAM|NIGHT\s*CREAM|MOISTURIZER|GEL\s*CREAM|\bCREAM\b/.test(s)) return 'Face Cream';
  return 'Lainnya';
}

export function buildMasterLookups(master) {
  var bySku = Object.create(null);
  var byBc = Object.create(null);
  (master || []).forEach(function (m) {
    if (!m) return;
    var bc = normBarcode(m.barcode);
    var sku = normSku(m.sku);
    if (bc && !byBc[bc]) byBc[bc] = m;
    if (sku && !bySku[sku]) bySku[sku] = m;
  });
  return { bySku: bySku, byBc: byBc };
}

export function resolveProductCategory(sku: any, barcode: any, nama: any, lookups?: any) {
  var m = null;
  if (lookups) {
    var bc = normBarcode(barcode);
    var s = normSku(sku);
    if (bc && lookups.byBc[bc]) m = lookups.byBc[bc];
    else if (s && lookups.bySku[s]) m = lookups.bySku[s];
  }
  return inferProductCategory(nama || (m && m.nama), m && m.kategori);
}

export function matchesDatePeriod(dateVal: any, period: string, fromDate?: string, toDate?: string): boolean {
  if (!period || period === 'all') return true;
  var tgl = parseDate(dateVal);
  if (!tgl) return false;
  var today = todayISO();
  if (period === 'today') return tgl === today;
  if (period === 'week') {
    var start7 = addDaysISO(today, -6);
    return tgl >= start7 && tgl <= today;
  }
  if (period === 'month') {
    return tgl.slice(0, 7) === today.slice(0, 7);
  }
  if (period === 'prev_month') {
    var parts = today.split('-').map(Number);
    var pm = new Date(parts[0], parts[1] - 2, 1);
    var prevYm = pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0');
    return tgl.slice(0, 7) === prevYm;
  }
  if (period === 'custom') {
    var f = parseDate(fromDate);
    var t = parseDate(toDate);
    if (f && tgl < f) return false;
    if (t && tgl > t) return false;
    return true;
  }
  return true;
}

export function getPeriodLabel(period: string, fromDate?: string, toDate?: string): string {
  if (period === 'today') return 'Hari Ini (' + todayISO() + ')';
  if (period === 'week') return '7 Hari Terakhir';
  if (period === 'month') return 'Bulan Ini (' + todayISO().slice(0, 7) + ')';
  if (period === 'prev_month') {
    var parts = todayISO().split('-').map(Number);
    var pm = new Date(parts[0], parts[1] - 2, 1);
    return 'Bulan Lalu (' + pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0') + ')';
  }
  if (period === 'custom') {
    var f = parseDate(fromDate) || '...';
    var t = parseDate(toDate) || '...';
    return 'Periode ' + f + ' s.d. ' + t;
  }
  return 'Semua Tanggal';
}

export function getPeriodFileSlug(period: string, fromDate?: string, toDate?: string): string {
  if (period === 'today') return todayISO();
  if (period === 'week') return '7hari-' + todayISO();
  if (period === 'month') return todayISO().slice(0, 7);
  if (period === 'prev_month') {
    var parts = todayISO().split('-').map(Number);
    var pm = new Date(parts[0], parts[1] - 2, 1);
    return pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0');
  }
  if (period === 'custom') {
    var f = parseDate(fromDate) || 'awal';
    var t = parseDate(toDate) || todayISO();
    return f + '_sd_' + t;
  }
  return todayISO();
}

