import { registerToastHandler } from '../state/store.ts';
import { computeWarehouseAnalysis, findMasterByBarcode, findMasterBySku } from '../core/stockEngine.ts';
import { curData } from '../core/warehouseRegistry.ts';
import { ICONS, THEME_KEY, appState, safeGet, safeSet } from '../state/store.ts';
import { esc, fmtNum, normBarcode, normSku } from '../utils/format.ts';
import { byId } from '../utils/dom.ts';

export function iconSvg(name: string, cls?: string) {
  var body = ICONS[name] || '';
  return '<svg class="' + (cls || 'svg-ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

export function openMobileDrawer() {
  var dr = byId('mobile-drawer');
  if (dr) dr.classList.add('open');
}

export function closeMobileDrawer() {
  var dr = byId('mobile-drawer');
  if (dr) dr.classList.remove('open');
}

export function showToast(msg: string, type?: string) {
  var wrap = byId('toast-wrap');
  if (!wrap) return;
  var el = document.createElement('div');
  el.className = 'toast-pill' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 3000);
}

export function applyTheme(mode) {
  var root = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    root.setAttribute('data-theme', mode);
  } else {
    root.removeAttribute('data-theme');
    mode = 'auto';
  }
  safeSet(THEME_KEY, mode);
  var lbl = byId('theme-label');
  var ico = byId('theme-icon');
  if (lbl) {
    lbl.textContent = mode === 'dark' ? 'Gelap' : (mode === 'light' ? 'Terang' : 'Otomatis');
  }
  if (ico) {
    ico.innerHTML = iconSvg(mode === 'dark' ? 'moon' : (mode === 'light' ? 'sun' : 'autoTheme'));
  }
}

export function cycleTheme() {
  var cur = safeGet(THEME_KEY, 'auto');
  var next = cur === 'auto' ? 'light' : (cur === 'light' ? 'dark' : 'auto');
  applyTheme(next);
  showToast('Tema diubah ke: ' + (next === 'dark' ? 'Gelap' : (next === 'light' ? 'Terang' : 'Otomatis Sistem')));
}


export function confirmDialog(title: string, msgHtml: string, onConfirm?: (() => void) | null, isDanger?: boolean) {
  var modal = byId('confirm-modal');
  byId('confirm-title').textContent = title || 'Konfirmasi';
  byId('confirm-message').innerHTML = msgHtml;
  var okBtn = byId('confirm-ok');
  okBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
  appState.confirmCb = onConfirm;
  modal.classList.add('open');
  okBtn.focus();
}

export function closeConfirm() {
  byId('confirm-modal').classList.remove('open');
  appState.confirmCb = null;
}


export function openTextModal(opts) {
  var modal = byId('text-modal');
  byId('text-modal-title').textContent = opts.title || 'Salin Data';
  byId('text-modal-desc').textContent = opts.desc || '';
  var area = byId('text-modal-area');
  area.value = opts.text || '';
  area.readOnly = opts.readonly !== false;
  var btn = byId('text-modal-action');
  btn.textContent = opts.actionLabel || 'Salin ke Papan Klip';
  appState.textModalActionCb = opts.onAction || function () {
    copyTextarea(area);
  };
  var waLink = byId('text-modal-wa');
  if (waLink) {
    if (opts.whatsappUrl || opts.allowWhatsapp) {
      var syncWaHref = function () {
        waLink.href = opts.whatsappUrl || ('https://wa.me/?text=' + encodeURIComponent(area.value || ''));
      };
      syncWaHref();
      waLink.style.display = 'inline-flex';
      area.oninput = opts.whatsappUrl ? null : syncWaHref;
    } else {
      waLink.style.display = 'none';
      waLink.href = '#';
      area.oninput = null;
    }
  }
  modal.classList.add('open');
  if (opts.readonly !== false) {
    area.focus();
    area.select();
  } else {
    area.focus();
  }
}

export function closeTextModal() {
  byId('text-modal').classList.remove('open');
  appState.textModalActionCb = null;
  var waLink = byId('text-modal-wa');
  if (waLink) {
    waLink.style.display = 'none';
    waLink.href = '#';
  }
  var area = byId('text-modal-area');
  if (area) area.oninput = null;
}

export function copyTextarea(area) {
  var val = area.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(val).then(function () {
      showToast('Berhasil disalin ke papan klip', 'ok');
    }).catch(function () {
      fallbackCopy(area);
    });
  } else {
    fallbackCopy(area);
  }
}

export function fallbackCopy(area) {
  area.select();
  area.setSelectionRange(0, area.value.length);
  try {
    document.execCommand('copy');
    showToast('Berhasil disalin ke papan klip', 'ok');
  } catch (e) {
    showToast('Pilih teks secara manual lalu tekan Ctrl+C', 'warn');
  }
}

export function toTSV(headers, rows) {
  var lines = [headers.join('\t')];
  rows.forEach(function (r) {
    lines.push(r.map(function (c) {
      return String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ');
    }).join('\t'));
  });
  return lines.join('\n');
}

export function openCopyTSV(title, headers, rows) {
  openTextModal({
    title: title,
    desc: 'Format TSV siap ditempel (Ctrl+V) langsung ke Google Sheets atau Excel (' + rows.length + ' baris).',
    text: toTSV(headers, rows),
    actionLabel: 'Salin TSV',
    readonly: true
  });
}

export function closeDetailModal() {
  var m = byId('detail-modal');
  if (m) m.classList.remove('open');
}

export function openSkuDetailModal(sku: string, optBarcode?: string) {
  var d = curData();
  var an = computeWarehouseAnalysis(d);
  var ns = normSku(sku);
  var nb = normBarcode(optBarcode);
  var masterMatch = (nb && findMasterByBarcode(d.master, nb)) || findMasterBySku(d.master, ns);
  var titleEl = byId('detail-modal-title');
  var bodyEl = byId('detail-modal-body');

  var stockRows = an.rows.filter(function (r) {
    if (ns === '5000054' && nb) return normSku(r.sku) === ns && normBarcode(r.barcode) === nb;
    return normSku(r.sku) === ns;
  });
  var totalStock = stockRows.reduce(function (s, r) { return s + r.qty; }, 0);
  var nama = (masterMatch && masterMatch.nama) || (stockRows[0] && stockRows[0].nama) || ns;

  var batches = an.batchRows.filter(function (b) { return normSku(b.sku) === ns; });
  var defects = an.defectRows.filter(function (x) { return normSku(x.sku) === ns; });

  var txs = [];
  (d.masuk || []).forEach(function (r) {
    if (normSku(r.sku) === ns) txs.push({ tgl: r.tgl, jenis: 'Masuk', cls: 'badge-ok', lok: r.lok, qty: '+' + fmtNum(r.qty), ket: r.ket || '-', by: r.by || '-' });
  });
  (d.keluar || []).forEach(function (r) {
    if (normSku(r.sku) === ns) txs.push({ tgl: r.tgl, jenis: 'Keluar', cls: 'badge-warn', lok: r.lok, qty: '-' + fmtNum(r.qty), ket: r.ket || '-', by: r.by || '-' });
  });
  (d.pindah || []).forEach(function (r) {
    if (normSku(r.sku) === ns) txs.push({ tgl: r.tgl, jenis: 'Pindah', cls: 'badge-info', lok: r.dari + ' → ' + r.ke, qty: fmtNum(r.qty), ket: 'Mutasi Rak', by: r.by || '-' });
  });
  txs.sort(function (a, b) { return String(b.tgl || '').localeCompare(String(a.tgl || '')); });

  titleEl.textContent = 'Kartu Stok: ' + nama + ' (' + ns + ')';
  var out = '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">' +
    '<span class="badge badge-info">Total Stok Bagus: ' + fmtNum(totalStock) + ' PCS</span>' +
    (stockRows.map(function (r) { return '<span class="badge ' + (r.qty < 0 ? 'badge-err' : (r.qty <= d.min ? 'badge-warn' : 'badge-ok')) + '">' + esc(r.lok) + ': ' + fmtNum(r.qty) + '</span>'; }).join('')) +
    '</div>';

  out += '<h4 style="margin:0 0 8px;font-size:13px">Batch & Tanggal Expire Aktif (' + batches.length + ')</h4>';
  if (batches.length === 0) {
    out += '<p class="muted" style="margin:0 0 14px;font-size:13px">Belum ada catatan batch expire untuk SKU ini.</p>';
  } else {
    out += '<div class="table-wrap" style="max-height:170px;margin-bottom:14px"><table><thead><tr><th>Lokasi</th><th>Batch</th><th>Tgl Expire</th><th>Status</th><th class="right">Qty</th></tr></thead><tbody>';
    batches.forEach(function (b) {
      out += '<tr><td>' + esc(b.lok || '-') + '</td><td class="mono">' + esc(b.batch || '-') + '</td><td class="num">' + esc(b.exp || '-') + '</td><td><span class="badge ' + b.expInfo.badgeCls + '">' + esc(b.expInfo.label) + '</span></td><td class="right num">' + fmtNum(b.qty) + '</td></tr>';
    });
    out += '</tbody></table></div>';
  }

  out += '<h4 style="margin:0 0 8px;font-size:13px">Catatan Barang Defect (' + defects.length + ')</h4>';
  if (defects.length === 0) {
    out += '<p class="muted" style="margin:0 0 14px;font-size:13px">Tidak ada riwayat defect untuk produk ini.</p>';
  } else {
    out += '<div class="table-wrap" style="max-height:160px;margin-bottom:14px"><table><thead><tr><th>Tanggal</th><th>Lokasi</th><th>Kategori</th><th>Status</th><th class="right">Qty</th><th>Keterangan</th></tr></thead><tbody>';
    defects.slice().reverse().forEach(function (df) {
      out += '<tr><td class="num">' + esc(df.tgl) + '</td><td>' + esc(df.lok || '-') + '</td><td>' + esc(df.kategori) + '</td><td><span class="badge ' + (df.status === 'KARANTINA' ? 'badge-err' : 'badge-neutral') + '">' + esc(df.status) + '</span></td><td class="right num">' + fmtNum(df.qty) + '</td><td>' + esc(df.ket || '-') + '</td></tr>';
    });
    out += '</tbody></table></div>';
  }

  out += '<h4 style="margin:0 0 8px;font-size:13px">Riwayat Pergerakan Terakhir (' + txs.length + ')</h4>';
  if (txs.length === 0) {
    out += '<p class="muted" style="margin:0;font-size:13px">Belum ada transaksi pergerakan tercatat.</p>';
  } else {
    out += '<div class="table-wrap" style="max-height:210px"><table><thead><tr><th>Tanggal</th><th>Jenis</th><th>Lokasi</th><th class="right">Qty</th><th>Keterangan</th><th>Petugas</th></tr></thead><tbody>';
    txs.slice(0, 25).forEach(function (t) {
      out += '<tr><td class="num">' + esc(t.tgl || '-') + '</td><td><span class="badge ' + t.cls + '">' + esc(t.jenis) + '</span></td><td>' + esc(t.lok) + '</td><td class="right num">' + esc(t.qty) + '</td><td>' + esc(t.ket) + '</td><td>' + esc(t.by) + '</td></tr>';
    });
    out += '</tbody></table></div>';
  }

  bodyEl.innerHTML = out;
  byId('detail-modal').classList.add('open');
}

export function pageHeaderHtml(title: string, desc?: string, actionsHtml?: string) {
  return '<div class="page-head"><div><h1 class="page-title">' + esc(title) + '</h1><p class="page-desc">' + esc(desc) + '</p></div>' +
    (actionsHtml ? '<div class="page-actions">' + actionsHtml + '</div>' : '') + '</div>';
}


registerToastHandler(showToast);
