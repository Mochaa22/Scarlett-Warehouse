import { findMasterByBarcode } from '../core/stockEngine.ts';
import { curData, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { appState, renderApp } from '../state/store.ts';
import { confirmDialog, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { esc, fmtNum, normBarcode, normLoc, normSku, parseDate, parseQty, todayISO, uid } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 6: OPNAME ===
let opnameSelectedLoc = '';
export function renderOpname(root, d, an) {
  var locs = Array.from<string>(new Set(d.lokasi.map(normLoc).concat(an.rows.map(function (r) { return r.lok; })))).sort();
  if (!opnameSelectedLoc && locs.length > 0) opnameSelectedLoc = locs[0];

  var html = pageHeaderHtml(
    'Stok Opname',
    'Masukkan hasil hitung fisik per lokasi untuk menghitung selisih otomatis dan menerapkan penyesuaian OPNAME.'
  );

  html += '<div class="card"><div class="form-grid">' +
    '<div class="field"><label for="op-lok">Pilih Lokasi Opname</label><select id="op-lok" class="input">' +
    (locs.length ? locs.map(function (l) { return '<option value="' + esc(l) + '"' + (l === opnameSelectedLoc ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') : '<option value="">(Belum ada lokasi)</option>') +
    '</select></div>' +
    '<div class="field"><label for="op-tgl">Tanggal Penyesuaian</label><input id="op-tgl" type="date" class="input" value="' + todayISO() + '" /></div>' +
    '<div class="field"><button type="button" class="btn btn-primary" id="op-apply-btn">Terapkan penyesuaian</button></div>' +
    '</div>' +
    '<div class="scanner-bar" style="margin-top:12px;margin-bottom:0">' +
    '<div class="scan-row"><input id="op-scan-inp" type="text" class="input mono" placeholder="Scan barcode produk di lokasi ini…" autocapitalize="characters" enterkeyhint="search" autocomplete="off" /><button type="button" class="btn" id="op-cam-btn">Kamera</button></div>' +
    '<label><input id="op-scan-inc" type="checkbox" /> Tambah +1 fisik otomatis saat scan</label>' +
    '</div></div>';

  var itemsAtLoc = an.rows.filter(function (r) { return r.lok === opnameSelectedLoc; }).sort(function (a, b) {
    return String(a.nama || a.sku).localeCompare(String(b.nama || b.sku));
  });

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Daftar Produk di ' + esc(opnameSelectedLoc || '-') + '</h2><span class="muted" style="font-size:12px">' + itemsAtLoc.length + ' baris stok</span></div>';
  if (itemsAtLoc.length === 0) {
    html += '<p class="muted" style="margin:0">Tidak ada stok tercatat di lokasi ini.</p>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Barcode</th><th>SKU</th><th>Nama Produk</th><th class="right">Stok Sistem</th><th class="right" style="width:140px">Qty Fisik</th><th class="right">Selisih</th></tr></thead><tbody>';
    itemsAtLoc.forEach(function (it, idx) {
      html += '<tr id="op-row-' + idx + '">' +
        '<td class="mono">' + esc(it.barcode || '-') + '</td>' +
        '<td class="mono">' + esc(it.sku) + '</td>' +
        '<td>' + esc(it.nama || '-') + '</td>' +
        '<td class="right num">' + fmtNum(it.qty) + '</td>' +
        '<td class="right"><input type="text" inputmode="decimal" class="input num op-fisik" data-idx="' + idx + '" value="' + it.qty + '" style="text-align:right;padding:5px 8px" /></td>' +
        '<td class="right num" id="op-diff-' + idx + '"><span class="badge badge-neutral">0</span></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  root.innerHTML = html;

  function updateOpDiff(idx, fisVal) {
    var sys = Number(itemsAtLoc[idx].qty || 0);
    var diff = fisVal - sys;
    var cell = byId('op-diff-' + idx);
    if (!cell) return;
    if (diff > 0) cell.innerHTML = '<span class="badge badge-ok">+' + fmtNum(diff) + '</span>';
    else if (diff < 0) cell.innerHTML = '<span class="badge badge-err">' + fmtNum(diff) + '</span>';
    else cell.innerHTML = '<span class="badge badge-neutral">0</span>';
  }

  function handleOpnameScan(rawCode) {
    var bc = normBarcode(rawCode);
    if (!bc) return;
    var mf = findMasterByBarcode(d.master, bc);
    var skuTarget = mf ? normSku(mf.sku) : normSku(bc);
    var hitIdx = -1;
    for (var i = 0; i < itemsAtLoc.length; i++) {
      var it = itemsAtLoc[i];
      if (normBarcode(it.barcode) === bc || (skuTarget !== '5000054' && normSku(it.sku) === skuTarget)) {
        hitIdx = i;
        break;
      }
    }
    if (hitIdx < 0) {
      playBeep(false);
      showToast('Produk tidak ditemukan di lokasi ' + opnameSelectedLoc, 'warn');
      return;
    }
    playBeep(true);
    var rowEl = byId('op-row-' + hitIdx);
    var inp = root.querySelector('.op-fisik[data-idx="' + hitIdx + '"]');
    if (rowEl) {
      rowEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      rowEl.classList.add('tr-highlight');
      setTimeout(function () { rowEl.classList.remove('tr-highlight'); }, 1200);
    }
    if (inp) {
      if (byId('op-scan-inc').checked) {
        var nextVal = parseQty(inp.value) + 1;
        inp.value = nextVal;
        updateOpDiff(hitIdx, nextVal);
        showToast((itemsAtLoc[hitIdx].nama || itemsAtLoc[hitIdx].sku) + ' → ' + fmtNum(nextVal), 'ok');
      } else {
        inp.focus();
        inp.select();
      }
    }
  }

  var opScanInp = byId('op-scan-inp');
  opScanInp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleOpnameScan(opScanInp.value);
      if (byId('op-scan-inc').checked) opScanInp.value = '';
      else opScanInp.select();
    }
  });
  byId('op-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      opScanInp.value = code;
      handleOpnameScan(code);
    });
  });

  byId('op-lok').addEventListener('change', function (e) {
    opnameSelectedLoc = targetEl(e).value;
    renderApp();
  });

  root.querySelectorAll('.op-fisik').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var idx = Number(inp.getAttribute('data-idx'));
      updateOpDiff(idx, parseQty(inp.value));
    });
  });

  byId('op-apply-btn').addEventListener('click', function () {
    var tgl = parseDate(byId('op-tgl').value);
    if (!tgl) { showToast('Tanggal opname tidak valid', 'warn'); return; }
    var adjustments = [];
    root.querySelectorAll('.op-fisik').forEach(function (inp) {
      var idx = Number(inp.getAttribute('data-idx'));
      var it = itemsAtLoc[idx];
      var fis = parseQty(inp.value);
      var diff = fis - Number(it.qty || 0);
      if (diff !== 0) {
        adjustments.push({ item: it, diff: diff });
      }
    });
    if (adjustments.length === 0) {
      showToast('Tidak ada selisih yang perlu disesuaikan', 'warn');
      return;
    }
    confirmDialog(
      'Terapkan Penyesuaian Opname',
      '<p style="margin:0">Akan dibuat <strong>' + adjustments.length + '</strong> transaksi penyesuaian bertanda <strong>OPNAME</strong> pada tanggal ' + esc(tgl) + '. Lanjutkan?</p>',
      function () {
        var dNow = curData();
        adjustments.forEach(function (adj) {
          var it = adj.item;
          if (adj.diff > 0) {
            dNow.masuk.push({
              id: uid(), tgl: tgl, barcode: it.barcode, sku: it.sku, nama: it.nama, lok: it.lok,
              qty: adj.diff, ket: 'OPNAME', by: appState.W.user, n: 1
            });
          } else {
            dNow.keluar.push({
              id: uid(), tgl: tgl, barcode: it.barcode, sku: it.sku, nama: it.nama, lok: it.lok,
              qty: Math.abs(adj.diff), ket: 'OPNAME', by: appState.W.user, n: 1
            });
          }
        });
        writeWarehouseData(appState.W.cur, dNow);
        showToast(adjustments.length + ' penyesuaian opname diterapkan', 'ok');
        renderApp();
      },
      false
    );
  });
}
