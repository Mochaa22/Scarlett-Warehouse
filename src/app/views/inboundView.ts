import { getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { computeWarehouseAnalysis } from '../core/stockEngine.ts';
import { curData, getWhMeta, whPrefix, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { playBeep } from '../services/scannerService.ts';
import { buildInboundWhatsappSlip, openWhatsappSlipModal } from '../services/transactionService.ts';
import { exportFilteredSuratJalanExcel } from '../services/xlsxService.ts';
import { appState, renderApp, safeGet } from '../state/store.ts';
import { closeTextModal, confirmDialog, iconSvg, openCopyTSV, openTextModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { classifyExpiry, esc, fmtNum, getPeriodFileSlug, getPeriodLabel, matchesDatePeriod, normBarcode, normSku, parseQty, todayISO } from '../utils/format.ts';
import { renderInboundRegister } from './masukView.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 2A: ANTREAN INBOUND & MATCHING ANCANTHO ===
export function getAdminInboundMatches(rows, register) {
  function productKey(row) {
    return JSON.stringify([row.tgl, normSku(row.sku), normBarcode(row.barcode)]);
  }
  var totals = new Map();
  var documents = new Map();
  rows.forEach(function (row) {
    var key = productKey(row);
    totals.set(key, (totals.get(key) || 0) + Number(row.qty || 0));
  });
  register.forEach(function (row) {
    if (!row.tgl || !row.noDoc || !row.sku || !(Number(row.qty) > 0)) return;
    var key = productKey(row);
    if (!documents.has(key)) documents.set(key, new Map());
    var byDocument = documents.get(key);
    var docKey = JSON.stringify([row.supplier, row.noDoc]);
    var document = byDocument.get(docKey) || { noDoc: row.noDoc, qty: 0, expiries: new Set() };
    document.qty += Number(row.qty);
    if (row.exp) document.expiries.add(row.exp);
    byDocument.set(docKey, document);
  });
  return function (row): Record<string, any> {
    var key = productKey(row);
    var candidates = documents.get(key);
    if (!candidates || candidates.size !== 1) {
      return {
        ...getMasukInboundMatch(row),
        auto: false,
        noDoc: '',
        countedQty: Number(row.qty || 0),
        expiryMismatch: false,
        multipleDocuments: Boolean(candidates && candidates.size > 1)
      };
    }
    var document = candidates.values().next().value;
    var countedQty = totals.get(key);
    return {
      ...getMasukInboundMatch({ qty: countedQty, inboundQty: document.qty }),
      auto: true,
      noDoc: document.noDoc,
      countedQty: countedQty,
      expiryMismatch: Boolean(row.exp && document.expiries.size && !document.expiries.has(row.exp)),
      multipleDocuments: false
    };
  };
}

export function renderInbound(root, d, an) {
  var expMonths = Number(d.expMonths || 7);
  var allMasuk = (d.masuk || []).slice().reverse();
  var registerKey = whPrefix(appState.W.cur) + 'inboundRegister';
  var adminMatch = getAdminInboundMatches(allMasuk, safeGet(registerKey, []));
  var pendingRows = allMasuk.filter(function (r) { return !isMasukAncanthoDone(r); });
  var doneRows = allMasuk.filter(function (r) { return isMasukAncanthoDone(r); });

  var matchedRows = pendingRows.filter(function (r) { return adminMatch(r).matched; });
  var mismatchRows = pendingRows.filter(function (r) { var im = adminMatch(r); return im.hasInbound && !im.matched; });
  var unfilledRows = pendingRows.filter(function (r) { return !adminMatch(r).hasInbound; });
  var pendingPcs = pendingRows.reduce(function (s, r) { return s + Number(r.qty || 0); }, 0);

  var headerActions = '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-sm" id="inb-to-masuk-btn">+ Input Surat Jalan</button>' +
    '<button type="button" class="btn btn-wa btn-sm" id="inb-wa-btn">' + iconSvg('whatsapp') + '<span>Slip Surat Jalan WA</span></button>' +
    '</div>';

  var html = pageHeaderHtml(
    'Surat Jalan',
    'Admin mencocokkan (matching) Qty hitungan Stockkeeper dengan Stock Inbound real-time, lalu Submit Done satu per satu atau sekaligus untuk semua yang Match.',
    headerActions
  );

  html += '<details class="card" id="inbound-register"></details>';
  html += '<div class="kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">' +
    '<div class="kpi-card ' + (pendingRows.length > 0 ? 'warn' : 'ok') + ' clickable" data-inb-kpi-filt="pending"><div class="kpi-top"><div class="kpi-label">Menunggu Total</div><div class="kpi-tag">Antrean</div></div><div class="kpi-value num" id="inb-kpi-pending">' + fmtNum(pendingRows.length) + ' baris</div><div class="kpi-sub">Total ' + fmtNum(pendingPcs) + ' PCS belum masuk Ancantho</div></div>' +
    '<div class="kpi-card ok clickable" data-inb-kpi-filt="match"><div class="kpi-top"><div class="kpi-label">✓ Match Siap Submit</div><div class="kpi-tag">Cocok</div></div><div class="kpi-value num" id="inb-kpi-match">' + fmtNum(matchedRows.length) + ' baris</div><div class="kpi-sub">Siap di-submit Done sekaligus</div></div>' +
    '<div class="kpi-card ' + (mismatchRows.length > 0 ? 'warn' : 'ok') + ' clickable" data-inb-kpi-filt="mismatch"><div class="kpi-top"><div class="kpi-label">Selisih Qty</div><div class="kpi-tag">Cek Ulang</div></div><div class="kpi-value num" id="inb-kpi-diff">' + fmtNum(mismatchRows.length) + ' baris</div><div class="kpi-sub">Qty Stockkeeper vs Inbound berbeda</div></div>' +
    '<div class="kpi-card clickable" data-inb-kpi-filt="unfilled"><div class="kpi-top"><div class="kpi-label">Belum Diisi Inbound</div><div class="kpi-tag">Perlu Input</div></div><div class="kpi-value num" id="inb-kpi-unfilled">' + fmtNum(unfilledRows.length) + ' baris</div><div class="kpi-sub">Menunggu surat jalan atau qty manual</div></div>' +
    '</div>';

  var signedInUser = window.__sgpCloud && window.__sgpCloud.getUser && window.__sgpCloud.getUser();
  var activeAdminDefault = String((signedInUser && signedInUser.displayName) || appState.W.user || '').trim() || 'Admin Gudang';
  var registerAll = safeGet(registerKey, []);
  var qInb = String(appState.inboundSearch || '').trim().toUpperCase();
  var inbPeriodLabel = getPeriodLabel(appState.inboundPeriod, appState.inboundFrom, appState.inboundTo);

  var rowsAdmin = allMasuk.filter(function (r) {
    if (!matchesDatePeriod(r.tgl, appState.inboundPeriod, appState.inboundFrom, appState.inboundTo)) return false;
    var isDone = isMasukAncanthoDone(r);
    var im = adminMatch(r);
    if (appState.inboundFilter === 'pending' && isDone) return false;
    if (appState.inboundFilter === 'match' && (isDone || !im.matched)) return false;
    if (appState.inboundFilter === 'mismatch' && (isDone || !im.hasInbound || im.matched)) return false;
    if (appState.inboundFilter === 'unfilled' && (isDone || im.hasInbound)) return false;
    if (appState.inboundFilter === 'done' && !isDone) return false;
    if (!qInb) return true;
    return [r.tgl, r.supplier, r.driver, r.noPlat, im.noDoc || r.noDoc, r.barcode, r.sku, r.nama, r.lok, r.by, r.ancanthoBy, r.ancanthoKet].join(' ').toUpperCase().indexOf(qInb) >= 0;
  });
  var shownAdmin = rowsAdmin.slice(0, 120);

  html += '<div class="card">' +
    '<div class="field" style="margin-bottom:14px"><label>Filter Status Antrean Surat Jalan</label><div class="seg-group">' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'pending' ? ' active' : '') + '" data-inb-filt="pending">Semua Menunggu (' + pendingRows.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'match' ? ' active' : '') + '" data-inb-filt="match">✓ Match (' + matchedRows.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'mismatch' ? ' active' : '') + '" data-inb-filt="mismatch">Selisih (' + mismatchRows.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'unfilled' ? ' active' : '') + '" data-inb-filt="unfilled">Belum Diisi (' + unfilledRows.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'done' ? ' active' : '') + '" data-inb-filt="done">Sudah Done (' + doneRows.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.inboundFilter === 'all' ? ' active' : '') + '" data-inb-filt="all">Semua (' + allMasuk.length + ')</button>' +
    '</div></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-inbound" type="search" class="input" placeholder="Cari produk, barcode, supplier, no doc, lokasi, PIC…" value="' + esc(appState.inboundSearch || '') + '" /><span class="search-kbd">/</span></div>' +
    '<select id="inb-period-filt" class="input" style="max-width:170px" aria-label="Filter Periode Surat Jalan">' +
    '<option value="all"' + (appState.inboundPeriod === 'all' ? ' selected' : '') + '>Semua Waktu</option>' +
    '<option value="month"' + (appState.inboundPeriod === 'month' ? ' selected' : '') + '>Bulan Ini</option>' +
    '<option value="today"' + (appState.inboundPeriod === 'today' ? ' selected' : '') + '>Hari Ini</option>' +
    '<option value="week"' + (appState.inboundPeriod === 'week' ? ' selected' : '') + '>7 Hari Terakhir</option>' +
    '<option value="prev_month"' + (appState.inboundPeriod === 'prev_month' ? ' selected' : '') + '>Bulan Lalu</option>' +
    '<option value="custom"' + (appState.inboundPeriod === 'custom' ? ' selected' : '') + '>Rentang Tanggal</option>' +
    '</select>' +
    (appState.inboundPeriod === 'custom'
      ? '<input id="inb-from" type="date" class="input" style="max-width:155px" value="' + esc(appState.inboundFrom || '') + '" aria-label="Dari tanggal" />' +
        '<input id="inb-to" type="date" class="input" style="max-width:155px" value="' + esc(appState.inboundTo || '') + '" aria-label="Sampai tanggal" />'
      : '') +
    '<button type="button" class="btn btn-primary btn-sm" id="inbound-export-xlsx-btn">' + iconSvg('download') + '<span>Download Excel (.xlsx)</span></button>' +
    '</div>' +
    '<div class="toolbar">' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn" id="in-paste-inbound-btn">Tempel Stock Inbound</button>' +
    '<button type="button" class="btn btn-primary" id="inb-batch-done-btn"' + (matchedRows.length === 0 ? ' disabled' : '') + '>Submit Done Semua yang Match (' + matchedRows.length + ')</button>' +
    '<button type="button" class="btn btn-primary" id="inb-selected-done-btn" disabled>Bulk Submit Terpilih (0)</button>' +
    '<button type="button" class="btn" id="copy-inbound-btn">Salin ke Sheets</button>' +
    '</div></div>' +
    '<div class="table-wrap"><table><thead><tr>' +
    '<th style="width:44px;text-align:center"><input type="checkbox" id="inb-select-all" class="masuk-chk" title="Pilih semua baris menunggu" aria-label="Pilih semua baris surat jalan" /></th>' +
    '<th>Stockkeeper &amp; Tgl</th>' +
    '<th>Produk &amp; Expire</th>' +
    '<th>Lokasi Transfer</th>' +
    '<th class="right">Qty Stockkeeper</th>' +
    '<th style="min-width:105px">Qty Surat Jalan</th>' +
    '<th>Match</th>' +
    '<th style="min-width:135px">Admin Penginput</th>' +
    '<th style="min-width:175px">Keterangan Admin</th>' +
    '<th class="right">Aksi</th>' +
    '</tr></thead><tbody>';

  if (shownAdmin.length === 0) {
    html += '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">' +
      (appState.inboundFilter === 'pending' ? 'Semua hasil hitung Stockkeeper sudah ditandai Done di Ancantho.' : 'Belum ada data yang sesuai filter ini.') +
      '</td></tr>';
  } else {
    shownAdmin.forEach(function (r) {
      var isDone = isMasukAncanthoDone(r);
      var im = adminMatch(r);
      var expBadge = '';
      if (r.exp) {
        var ei = classifyExpiry(r.exp, expMonths);
        expBadge = ' <span class="badge ' + ei.badgeCls + '">' + esc(ei.label) + '</span>';
      }
      var rowAdminVal = r.ancanthoBy || '';
      var rowInbVal = im.hasInbound ? String(im.inboundQty) : '';
      html += '<tr>' +
        '<td style="text-align:center">' +
        (isDone
          ? '<input type="checkbox" class="masuk-chk" checked disabled title="Sudah Done" aria-label="Sudah Done" />'
          : '<input type="checkbox" class="masuk-chk" data-admin-chk="' + esc(r.id) + '" data-done="false" aria-label="Pilih baris surat jalan untuk Bulk Submit" />') +
        '</td>' +
        '<td><div><strong>' + esc(r.by || '-') + '</strong></div><div class="muted num" style="font-size:11.5px">' + esc(r.tgl || '-') + '</div>' +
        '<div class="muted">' + esc([r.supplier, r.driver, r.noPlat, r.noDoc].filter(Boolean).join(' · ')) + '</div></td>' +
        '<td><div class="mono" style="font-size:12px">' + esc(r.barcode || r.sku || '-') + '</div><div style="font-size:12.5px">' + esc(r.nama || '-') + '</div>' + (r.exp ? '<div class="num" style="font-size:11.5px;margin-top:2px">Exp: ' + esc(r.exp) + expBadge + '</div>' : '') + '</td>' +
        '<td><span class="masuk-loc-pill">' + esc(r.lok || '-') + '</span></td>' +
        '<td class="right num"><strong>+' + fmtNum(r.qty) + '</strong></td>' +
        (im.auto
          ? '<td class="num"><strong>' + fmtNum(im.inboundQty) + '</strong><div class="muted">' + esc(im.noDoc) + '</div>' +
            (im.expiryMismatch ? '<div class="muted">Expiry berbeda</div>' : '') + '</td>'
          : '<td><input type="text" inputmode="decimal" class="input num masuk-admin-inp" data-admin-inbound="' + esc(r.id) + '" data-sk-qty="' + esc(r.qty) + '" value="' + esc(rowInbVal) + '" placeholder="Isi qty…" />' +
            (im.multipleDocuments ? '<div class="muted">Beberapa surat jalan · cek manual</div>' : '') + '</td>') +
        '<td><span data-match-badge="' + esc(r.id) + '" class="badge ' + im.cls + '">' + esc(im.label) + '</span>' +
        (im.auto && im.countedQty !== Number(r.qty) ? '<div class="muted">Total Barang Masuk: ' + fmtNum(im.countedQty) + '</div>' : '') + '</td>' +
        '<td><input type="text" class="input masuk-admin-inp" data-admin-by="' + esc(r.id) + '" value="' + esc(rowAdminVal) + '" placeholder="' + esc(activeAdminDefault) + '" /></td>' +
        '<td><input type="text" class="input masuk-admin-inp" data-admin-ket="' + esc(r.id) + '" value="' + esc(r.ancanthoKet || '') + '" placeholder="Keterangan transfer Ancantho…" /></td>' +
        '<td class="right" style="white-space:nowrap">' +
        (isDone
          ? '<span class="badge badge-ok">✓ Done</span>' + (r.ancanthoAt ? '<div class="muted num" style="font-size:11px;margin:2px 0">' + esc(r.ancanthoAt) + '</div>' : '') + ' <button type="button" class="btn btn-sm" data-admin-undo="' + esc(r.id) + '">Batal</button>'
          : '<button type="button" class="btn btn-primary btn-sm" data-admin-submit="' + esc(r.id) + '">Submit Done</button>') +
        '</td></tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  renderInboundRegister(root, appState.W.cur, d.master);
  byId('inb-to-masuk-btn').addEventListener('click', function () {
    var register = root.querySelector('#inbound-register');
    register.open = true;
    register.scrollIntoView({ block: 'nearest' });
    register.querySelector('#inbound-log-nama').focus();
  });

  byId('inb-wa-btn').addEventListener('click', function () {
    var dNow = curData();
    openWhatsappSlipModal(
      'Slip Serah Terima Inbound — WhatsApp',
      'Daftar antrean inbound & status matching siap kirim via WhatsApp.',
      buildInboundWhatsappSlip(dNow, computeWarehouseAnalysis(dNow))
    );
  });

  root.querySelectorAll('[data-inb-filt], [data-inb-kpi-filt]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.inboundFilter = b.getAttribute('data-inb-filt') || b.getAttribute('data-inb-kpi-filt');
      renderApp();
    });
  });

  var pasteInbBtn = byId('in-paste-inbound-btn');
  if (pasteInbBtn) {
    pasteInbBtn.addEventListener('click', function () {
      openTextModal({
        title: 'Tempel Daftar Stock Inbound (Untuk Matching)',
        desc: 'Tempel dari Excel/Sheets dengan format 2 kolom: Barcode/SKU dan Qty Inbound (satu baris per produk) untuk mencocokkan antrean Menunggu.',
        text: '',
        actionLabel: 'Terapkan ke Antrean',
        readonly: false,
        onAction: function () {
          var raw = byId('text-modal-area').value;
          var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
          var qtyMap = Object.create(null);
          lines.forEach(function (ln) {
            var parts = ln.split(/[\t,;]+/).map(function (p) { return p.trim(); }).filter(Boolean);
            if (parts.length < 2) parts = ln.split(/\s+/);
            if (parts.length < 2) return;
            var code = normBarcode(parts[0]);
            var qVal = parseQty(parts[parts.length - 1]);
            if (code && qVal >= 0) qtyMap[code] = qVal;
          });
          var dNow = curData();
          var updated = 0;
          (dNow.masuk || []).forEach(function (r) {
            if (isMasukAncanthoDone(r)) return;
            var bc = normBarcode(r.barcode);
            var sk = normSku(r.sku);
            if (Object.prototype.hasOwnProperty.call(qtyMap, bc)) {
              r.inboundQty = qtyMap[bc];
              updated += 1;
            } else if (Object.prototype.hasOwnProperty.call(qtyMap, sk)) {
              r.inboundQty = qtyMap[sk];
              updated += 1;
            }
          });
          writeWarehouseData(appState.W.cur, dNow);
          closeTextModal();
          showToast(updated > 0 ? ('Stock Inbound diterapkan ke ' + updated + ' baris') : 'Tidak ada Barcode/SKU antrean yang cocok', updated > 0 ? 'ok' : 'warn');
          renderApp();
        }
      });
    });
  }

  var batchDoneBtn = byId('inb-batch-done-btn');
  var selectedDoneBtn = byId('inb-selected-done-btn');
  var selectAllChk = byId('inb-select-all') as HTMLInputElement;

  function submitInboundRows(selectedIds: Set<string> | null) {
    var dNow = curData();
    var currentMatch = getAdminInboundMatches(dNow.masuk || [], safeGet(registerKey, []));
    var targets = (dNow.masuk || []).filter(function (r) {
      if (isMasukAncanthoDone(r)) return false;
      if (selectedIds) return selectedIds.has(String(r.id));
      return currentMatch(r).matched;
    });
    if (targets.length === 0) {
      showToast(selectedIds ? 'Pilih minimal 1 baris Surat Jalan terlebih dahulu' : 'Belum ada antrean berstatus ✓ Match untuk di-submit', 'warn');
      return;
    }

    // Sinkronkan input inline yang sedang diketik user sebelum submit massal
    targets.forEach(function (r) {
      var idSel = CSS.escape(String(r.id));
      var byInp = root.querySelector('[data-admin-by="' + idSel + '"]') as HTMLInputElement | null;
      var ketInp = root.querySelector('[data-admin-ket="' + idSel + '"]') as HTMLInputElement | null;
      var inbInp = root.querySelector('[data-admin-inbound="' + idSel + '"]') as HTMLInputElement | null;
      if (byInp && byInp.value.trim()) r.ancanthoBy = byInp.value.trim();
      if (ketInp) r.ancanthoKet = ketInp.value.trim();
      if (inbInp) {
        var rawV = inbInp.value.trim();
        r.inboundQty = rawV === '' ? null : parseQty(rawV);
      }
    });

    var missingInboundCount = targets.filter(function (r) { return !currentMatch(r).hasInbound; }).length;
    var mismatchCount = targets.filter(function (r) {
      var m = currentMatch(r);
      return m.hasInbound && !m.matched;
    }).length;

    function commit() {
      var nowD = new Date();
      var nowStamp = todayISO() + ' ' + String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0');
      targets.forEach(function (r) {
        if (!currentMatch(r).hasInbound && (r.inboundQty === null || r.inboundQty === undefined)) {
          r.inboundQty = Number(r.qty || 0);
        }
        r.ancanthoDone = true;
        if (!r.ancanthoBy) r.ancanthoBy = activeAdminDefault;
        r.ancanthoAt = nowStamp;
      });
      appState.masukAdminName = activeAdminDefault;
      writeWarehouseData(appState.W.cur, dNow);
      playBeep(true);
      showToast('Bulk Submit berhasil: ' + targets.length + ' Surat Jalan ditandai Done', 'ok');
      renderApp();
    }

    if (missingInboundCount > 0 || mismatchCount > 0) {
      var msgParts: string[] = [];
      if (missingInboundCount > 0) msgParts.push('<strong>' + missingInboundCount + '</strong> baris belum diisi Qty Surat Jalan (akan disamakan dengan Qty Stockkeeper)');
      if (mismatchCount > 0) msgParts.push('<strong>' + mismatchCount + '</strong> baris memiliki selisih Qty');
      confirmDialog(
        'Konfirmasi Bulk Submit Surat Jalan',
        '<p style="margin:0">' + msgParts.join(' dan ') + ' dari <strong>' + targets.length + '</strong> baris terpilih.<br/>Lanjutkan Bulk Submit semua baris terpilih sebagai Done?</p>',
        commit,
        true
      );
    } else {
      commit();
    }
  }

  batchDoneBtn.addEventListener('click', function () { submitInboundRows(null); });
  selectedDoneBtn.addEventListener('click', function () {
    var ids = Array.from(root.querySelectorAll('[data-admin-chk]:checked'), function (checkbox: Element) {
      return checkbox.getAttribute('data-admin-chk') || '';
    }).filter(Boolean);
    submitInboundRows(new Set(ids));
  });

  function refreshSelectedDoneButton() {
    var allPendingChks = Array.from(root.querySelectorAll('[data-admin-chk]')) as HTMLInputElement[];
    var checkedChks = allPendingChks.filter(function (c) { return c.checked && !c.disabled; });
    var count = checkedChks.length;
    selectedDoneBtn.textContent = 'Bulk Submit Terpilih (' + count + ')';
    selectedDoneBtn.disabled = count === 0;
    if (selectAllChk) {
      selectAllChk.disabled = allPendingChks.length === 0;
      selectAllChk.checked = allPendingChks.length > 0 && count === allPendingChks.length;
      selectAllChk.indeterminate = count > 0 && count < allPendingChks.length;
    }
  }

  if (selectAllChk) {
    selectAllChk.addEventListener('change', function () {
      var checkAll = selectAllChk.checked;
      root.querySelectorAll('[data-admin-chk]').forEach(function (chk) {
        var el = chk as HTMLInputElement;
        if (!el.disabled) el.checked = checkAll;
      });
      refreshSelectedDoneButton();
    });
  }
  refreshSelectedDoneButton();

  function updateLiveMatchBadge(id, rawInb) {
    var badge = root.querySelector('[data-match-badge="' + id + '"]');
    var inbInp = root.querySelector('[data-admin-inbound="' + id + '"]');
    if (!badge || !inbInp) return;
    var skQty = Number(inbInp.getAttribute('data-sk-qty') || 0);
    var info = getMasukInboundMatch({ qty: skQty, inboundQty: rawInb === '' ? null : parseQty(rawInb) });
    badge.className = 'badge ' + info.cls;
    badge.textContent = info.label;
  }

  function saveAdminRow(id, nextDone, onlyUpdateFields) {
    var byInp = root.querySelector('[data-admin-by="' + id + '"]');
    var ketInp = root.querySelector('[data-admin-ket="' + id + '"]');
    var inbInp = root.querySelector('[data-admin-inbound="' + id + '"]');
    var chkEl = root.querySelector('[data-admin-chk="' + id + '"]');
    var adminWho = (byInp ? byInp.value.trim() : '') || activeAdminDefault;
    var ketVal = ketInp ? ketInp.value.trim() : '';
    var rawInb = inbInp ? inbInp.value.trim() : '';
    var parsedInb = rawInb === '' ? null : parseQty(rawInb);

    var dNow = curData();
    var target = (dNow.masuk || []).find(function (x) { return x.id === id; });
    if (!target) return;
    var autoMatch = getAdminInboundMatches(dNow.masuk || [], safeGet(registerKey, []))(target);
    var countedQty = autoMatch.auto ? autoMatch.countedQty : Number(target.qty || 0);
    if (autoMatch.auto) parsedInb = autoMatch.inboundQty;

    if (nextDone && !onlyUpdateFields) {
      if (parsedInb === null) {
        if (chkEl) chkEl.checked = false;
        playBeep(false);
        showToast('Isi Stock Inbound dulu untuk matching sebelum input ke Ancantho', 'warn');
        if (inbInp) inbInp.focus();
        return;
      }
    }

    function commitAdminSave() {
      if (!autoMatch.auto) target.inboundQty = parsedInb;
      target.ancanthoKet = ketVal;
      if (!onlyUpdateFields) {
        target.ancanthoDone = !!nextDone;
        if (nextDone) {
          appState.masukAdminName = adminWho;
          target.ancanthoBy = adminWho;
          var nowD = new Date();
          target.ancanthoAt = todayISO() + ' ' + String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0');
        } else {
          target.ancanthoAt = '';
        }
      } else if (byInp && byInp.value.trim()) {
        target.ancanthoBy = byInp.value.trim();
      }

      writeWarehouseData(appState.W.cur, dNow);
      if (!onlyUpdateFields) {
        playBeep(true);
        showToast(nextDone ? ('Submit Done ke Ancantho oleh ' + adminWho + ' (' + target.lok + ')') : 'Status dikembalikan ke Menunggu Ancantho', 'ok');
        renderApp();
      } else {
        var updatedMatch = getAdminInboundMatches(dNow.masuk || [], safeGet(registerKey, []));
        var updatedStats = { inboundMatched: 0, inboundMismatch: 0, inboundUnfilled: 0 };
        (dNow.masuk || []).forEach(function (row) {
          if (isMasukAncanthoDone(row)) return;
          var match = updatedMatch(row);
          if (match.matched) updatedStats.inboundMatched++;
          else if (match.hasInbound) updatedStats.inboundMismatch++;
          else updatedStats.inboundUnfilled++;
        });
        var kMatch = byId('inb-kpi-match');
        var kDiff = byId('inb-kpi-diff');
        var kUnfill = byId('inb-kpi-unfilled');
        if (kMatch) kMatch.textContent = fmtNum(updatedStats.inboundMatched) + ' baris';
        if (kDiff) kDiff.textContent = fmtNum(updatedStats.inboundMismatch) + ' baris';
        if (kUnfill) kUnfill.textContent = fmtNum(updatedStats.inboundUnfilled) + ' baris';
        if (batchDoneBtn) {
          batchDoneBtn.textContent = 'Submit Done Semua yang Match (' + updatedStats.inboundMatched + ')';
          batchDoneBtn.disabled = updatedStats.inboundMatched === 0;
        }
      }
    }

    if (nextDone && !onlyUpdateFields && parsedInb !== null && countedQty !== parsedInb) {
      var diffVal = countedQty - parsedInb;
      playBeep(false);
      if (chkEl) chkEl.checked = false;
      confirmDialog(
        'Konfirmasi Selisih Stock Inbound',
        '<p style="margin:0">Qty Stockkeeper (<strong>' + fmtNum(countedQty) + '</strong>) berbeda dengan Stock Inbound (<strong>' + fmtNum(parsedInb) + '</strong>), selisih <strong>' + (diffVal > 0 ? '+' : '') + fmtNum(diffVal) + ' PCS</strong>.<br/>Tetap lanjut Submit Done ke sistem Ancantho?</p>',
        commitAdminSave,
        true
      );
      return;
    }

    commitAdminSave();
  }

  root.querySelectorAll('[data-admin-inbound]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      updateLiveMatchBadge(inp.getAttribute('data-admin-inbound'), inp.value.trim());
    });
    inp.addEventListener('change', function () {
      saveAdminRow(inp.getAttribute('data-admin-inbound'), false, true);
    });
  });

  root.querySelectorAll('[data-admin-ket], [data-admin-by]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var id = inp.getAttribute('data-admin-ket') || inp.getAttribute('data-admin-by');
      saveAdminRow(id, false, true);
    });
  });

  root.querySelectorAll('[data-admin-chk]').forEach(function (chk) {
    chk.addEventListener('change', refreshSelectedDoneButton);
  });

  root.querySelectorAll('[data-admin-submit]').forEach(function (b) {
    b.addEventListener('click', function () {
      saveAdminRow(b.getAttribute('data-admin-submit'), true, false);
    });
  });

  root.querySelectorAll('[data-admin-undo]').forEach(function (b) {
    b.addEventListener('click', function () {
      saveAdminRow(b.getAttribute('data-admin-undo'), false, false);
    });
  });

  var searchInbEl = byId('search-inbound');
  if (searchInbEl) {
    searchInbEl.addEventListener('input', function (e) {
      appState.inboundSearch = targetEl(e).value;
      renderApp();
      var s = byId('search-inbound');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
  }
  var inbPeriodEl = byId('inb-period-filt') as HTMLSelectElement;
  if (inbPeriodEl) {
    inbPeriodEl.addEventListener('change', function () {
      appState.inboundPeriod = inbPeriodEl.value || 'all';
      renderApp();
    });
  }
  var inbFromEl = byId('inb-from') as HTMLInputElement;
  if (inbFromEl) {
    inbFromEl.addEventListener('change', function () {
      appState.inboundFrom = inbFromEl.value || '';
      renderApp();
    });
  }
  var inbToEl = byId('inb-to') as HTMLInputElement;
  if (inbToEl) {
    inbToEl.addEventListener('change', function () {
      appState.inboundTo = inbToEl.value || '';
      renderApp();
    });
  }

  var inboundExportBtn = byId('inbound-export-xlsx-btn');
  if (inboundExportBtn) {
    inboundExportBtn.addEventListener('click', function () {
      var filteredReg = (registerAll || []).slice().reverse().filter(function (ib) {
        if (!matchesDatePeriod(ib.tgl, appState.inboundPeriod, appState.inboundFrom, appState.inboundTo)) return false;
        if (!qInb) return true;
        return [ib.tgl, ib.supplier, ib.driver, ib.noPlat, ib.noDoc, ib.barcode, ib.sku, ib.nama].join(' ').toUpperCase().indexOf(qInb) >= 0;
      });
      exportFilteredSuratJalanExcel(
        getWhMeta(appState.W.cur).nama,
        rowsAdmin,
        filteredReg,
        adminMatch,
        {
          label: inbPeriodLabel,
          slug: getPeriodFileSlug(appState.inboundPeriod, appState.inboundFrom, appState.inboundTo)
        }
      );
    });
  }

  var copyInbBtn = byId('copy-inbound-btn');
  if (copyInbBtn) {
    copyInbBtn.addEventListener('click', function () {
      openCopyTSV(
        'Salin Antrean Surat Jalan',
        ['Tanggal', 'Supplier', 'Driver', 'No Plat', 'No Doc', 'Barcode', 'SKU', 'Nama Barang', 'Expired Date', 'Total Qty', 'Stockkeeper', 'Lokasi', 'Stock Inbound', 'Status Match', 'Status Ancantho', 'Admin Ancantho', 'Keterangan Admin', 'Waktu Done'],
        rowsAdmin.map(function (r) {
          var im = adminMatch(r);
          return [
            r.tgl,
            r.supplier || '',
            r.driver || '',
            r.noPlat || '',
            r.noDoc || '',
            r.barcode,
            r.sku,
            r.nama,
            r.exp || '',
            r.qty,
            r.by || '',
            r.lok,
            im.hasInbound ? im.inboundQty : '',
            im.label,
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
