import { findMasterByBarcode } from '../core/stockEngine.ts';
import { curData, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { openCameraScanner, playBeep } from '../services/scannerService.ts';
import { removeTxSafely } from '../services/transactionService.ts';
import { parseDelimitedLines } from '../services/xlsxService.ts';
import { appState, renderApp } from '../state/store.ts';
import { closeTextModal, confirmDialog, openCopyTSV, openTextModal, pageHeaderHtml, showToast } from '../ui/feedback.ts';
import { classifyExpiry, esc, fmtNum, normBarcode, normLoc, normSku, parseDate, parseExpDate, parseQty, stockKey, todayISO, uid } from '../utils/format.ts';
import { byId, targetEl } from '../utils/dom.ts';

// === HALAMAN 3A: BARANG DEFECT & KARANTINA ===
export function renderDefect(root, d, an) {
  var pre = window.__defectPrefill || null;
  window.__defectPrefill = null;
  var locOpts = d.lokasi.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
  var bcOpts = d.master.map(function (m) { return '<option value="' + esc(m.barcode) + '">' + esc(m.sku + ' — ' + m.nama) + '</option>'; }).join('');
  var defectCats = ['KEMASAN RUSAK', 'BOCOR / REMBES', 'SEGEL RUSAK', 'SALAH LABEL / CETAK', 'KADALUWARSA / EXPIRE', 'RETUR KONSUMEN', 'LAINNYA'];

  var allDef = an.defectRows || [];
  var karantinaPcs = allDef.filter(function (x) { return (x.status || 'KARANTINA') === 'KARANTINA'; }).reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);
  var returPcs = allDef.filter(function (x) { return x.status === 'RETUR SUPPLIER'; }).reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);
  var repackPcs = allDef.filter(function (x) { return x.status === 'REPACK'; }).reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);
  var musnahPcs = allDef.filter(function (x) { return x.status === 'MUSNAH'; }).reduce(function (s, x) { return s + Number(x.qty || 0); }, 0);

  var html = pageHeaderHtml(
    'Barang Defect & Karantina',
    'Catat barang rusak, bocor, segel cacat, atau kadaluwarsa beserta tindak lanjut (Repack, Retur Supplier, atau Musnah).'
  );

  html += '<div class="kpi-grid">' +
    '<div class="kpi-card err"><div class="kpi-label">Karantina Aktif</div><div class="kpi-value num">' + fmtNum(karantinaPcs) + ' PCS</div><div class="kpi-sub">' + fmtNum(an.defectActive.length) + ' catatan aktif</div></div>' +
    '<div class="kpi-card warn"><div class="kpi-label">Retur Supplier</div><div class="kpi-value num">' + fmtNum(returPcs) + ' PCS</div><div class="kpi-sub">Dikembalikan ke pemasok</div></div>' +
    '<div class="kpi-card ok"><div class="kpi-label">Repack ke Stok Bagus</div><div class="kpi-value num">' + fmtNum(repackPcs) + ' PCS</div><div class="kpi-sub">Dipulihkan ke rak</div></div>' +
    '<div class="kpi-card"><div class="kpi-label">Musnah / Dispose</div><div class="kpi-value num">' + fmtNum(musnahPcs) + ' PCS</div><div class="kpi-sub">Sudah dimusnahkan</div></div>' +
    '</div>';

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Form Input Barang Defect</h2></div>' +
    '<form id="form-defect" class="form-grid">' +
    '<div class="field"><label for="def-tgl">Tanggal</label><input id="def-tgl" type="date" class="input" value="' + todayISO() + '" required /></div>' +
    '<div class="field"><label for="def-bc">Barcode</label><div class="scan-row"><input id="def-bc" type="text" class="input mono" list="dl-def-bc" value="' + esc(pre && pre.barcode ? pre.barcode : '') + '" placeholder="Scan / ketik barcode…" autocapitalize="characters" autocomplete="off" /><button type="button" class="btn" id="def-cam-btn">Kamera</button></div></div>' +
    '<div class="field"><label for="def-sku">SKU</label><input id="def-sku" type="text" class="input mono" value="' + esc(pre && pre.sku ? pre.sku : '') + '" autocapitalize="characters" placeholder="Otomatis / isi manual" /></div>' +
    '<div class="field"><label for="def-nama">Nama Produk</label><input id="def-nama" type="text" class="input" value="' + esc(pre && pre.nama ? pre.nama : '') + '" placeholder="Otomatis dari Master" /></div>' +
    '<div class="field"><label for="def-lok">Lokasi Asal / Karantina</label><input id="def-lok" type="text" class="input" list="dl-def-lok" value="' + esc(pre && pre.lok ? pre.lok : '') + '" autocapitalize="characters" placeholder="Contoh: RAK-A1 / RETUR" autocomplete="off" /></div>' +
    '<div class="field"><label for="def-qty">Qty Defect (PCS)</label><input id="def-qty" type="text" inputmode="decimal" class="input num" value="' + esc(pre && pre.qty ? pre.qty : '') + '" placeholder="0" /></div>' +
    '<div class="field"><label for="def-kat">Kategori Kerusakan</label><select id="def-kat" class="input">' +
    defectCats.map(function (c) {
      var sel = pre && pre.kategori === c ? ' selected' : '';
      return '<option value="' + esc(c) + '"' + sel + '>' + esc(c) + '</option>';
    }).join('') +
    '</select></div>' +
    '<div class="field"><label for="def-sumber">Pengaruh ke Stok Bagus</label><select id="def-sumber" class="input">' +
    '<option value="POTONG_STOK"' + (!pre || pre.potongStok !== false ? ' selected' : '') + '>Potong Stok Bagus dari Lokasi Ini</option>' +
    '<option value="NON_STOK"' + (pre && pre.potongStok === false ? ' selected' : '') + '>Temuan Masuk / Tidak Potong Stok</option>' +
    '</select></div>' +
    '<div class="field"><label for="def-batch">No. Batch (Opsional)</label><input id="def-batch" type="text" class="input mono" value="' + esc(pre && pre.batch ? pre.batch : '') + '" autocapitalize="characters" placeholder="LOT-..." /></div>' +
    '<div class="field"><label for="def-exp">Tgl Expire (Opsional)</label><input id="def-exp" type="date" class="input" value="' + esc(pre && pre.exp ? pre.exp : '') + '" /></div>' +
    '<div class="field"><label for="def-status">Status Awal</label><select id="def-status" class="input">' +
    '<option value="KARANTINA" selected>KARANTINA</option>' +
    '<option value="RETUR SUPPLIER">RETUR SUPPLIER</option>' +
    '<option value="MUSNAH">MUSNAH</option>' +
    '</select></div>' +
    '<div class="field"><label for="def-ket">Catatan / Keterangan</label><input id="def-ket" type="text" class="input" value="' + esc(pre && pre.ket ? pre.ket : '') + '" placeholder="Misal: tutup pecah / rembes" /></div>' +
    '<div class="field"><button type="submit" class="btn btn-primary">Simpan Defect</button></div>' +
    '</form>' +
    '<datalist id="dl-def-lok">' + locOpts + '</datalist>' +
    '<datalist id="dl-def-bc">' + bcOpts + '</datalist>' +
    '<div id="def-hint"></div>' +
    '</div>';

  var q = appState.searchState.defect.trim().toUpperCase();
  var rows = allDef.slice().reverse().filter(function (r) {
    if (appState.defectFilter !== 'ALL' && (r.status || 'KARANTINA') !== appState.defectFilter) return false;
    if (!q) return true;
    return [r.tgl, r.barcode, r.sku, r.nama, r.lok, r.kategori, r.status, r.batch, r.ket, r.by].join(' ').toUpperCase().indexOf(q) >= 0;
  });

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Daftar Barang Defect</h2><span class="muted" style="font-size:12px">' + rows.length + ' catatan</span></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-defect" type="search" class="input" placeholder="Cari SKU, nama, lokasi, kategori…" value="' + esc(appState.searchState.defect) + '" /><span class="search-kbd">/</span></div>' +
    '<div class="seg-group" role="tablist">' +
    '<button type="button" class="seg-btn' + (appState.defectFilter === 'KARANTINA' ? ' active' : '') + '" data-df="KARANTINA">Karantina</button>' +
    '<button type="button" class="seg-btn' + (appState.defectFilter === 'RETUR SUPPLIER' ? ' active' : '') + '" data-df="RETUR SUPPLIER">Retur</button>' +
    '<button type="button" class="seg-btn' + (appState.defectFilter === 'REPACK' ? ' active' : '') + '" data-df="REPACK">Repack</button>' +
    '<button type="button" class="seg-btn' + (appState.defectFilter === 'MUSNAH' ? ' active' : '') + '" data-df="MUSNAH">Musnah</button>' +
    '<button type="button" class="seg-btn' + (appState.defectFilter === 'ALL' ? ' active' : '') + '" data-df="ALL">Semua</button>' +
    '</div>' +
    '<button type="button" class="btn" id="copy-defect-btn">Salin ke Sheets</button>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Produk</th><th>Lokasi</th><th>Kategori</th><th>Batch / Exp</th><th class="right">Qty</th><th>Status</th><th>Keterangan</th><th class="right">Aksi</th></tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Belum ada catatan barang defect pada filter ini.</td></tr>';
  } else {
    rows.forEach(function (r) {
      var stCls = r.status === 'KARANTINA' ? 'badge-err' : (r.status === 'REPACK' ? 'badge-ok' : (r.status === 'RETUR SUPPLIER' ? 'badge-warn' : 'badge-neutral'));
      var actionBtns = '';
      if ((r.status || 'KARANTINA') === 'KARANTINA') {
        actionBtns += '<button type="button" class="btn btn-sm" data-def-repack="' + esc(r.id) + '" title="Kembalikan ke stok bagus">Repack</button> ';
        actionBtns += '<button type="button" class="btn btn-sm" data-def-status="RETUR SUPPLIER" data-def-id="' + esc(r.id) + '">Retur</button> ';
        actionBtns += '<button type="button" class="btn btn-sm" data-def-status="MUSNAH" data-def-id="' + esc(r.id) + '">Musnah</button> ';
      }
      actionBtns += '<button type="button" class="btn btn-sm btn-danger" data-del-defect="' + esc(r.id) + '">Hapus</button>';

      html += '<tr>' +
        '<td class="num">' + esc(r.tgl || '-') + '</td>' +
        '<td><strong>' + esc(r.nama || r.sku) + '</strong><div class="mono muted" style="font-size:11.5px">' + esc(r.sku) + (r.barcode ? ' · ' + esc(r.barcode) : '') + '</div></td>' +
        '<td>' + esc(r.lok || '-') + (r.potongStok ? ' <span class="badge badge-neutral" title="Mengurangi stok bagus">Potong Rak</span>' : '') + '</td>' +
        '<td><span class="badge badge-warn">' + esc(r.kategori || '-') + '</span></td>' +
        '<td class="num">' + esc(r.batch || '-') + (r.exp ? '<div class="muted" style="font-size:11.5px">Exp ' + esc(r.exp) + '</div>' : '') + '</td>' +
        '<td class="right num"><strong>' + fmtNum(r.qty) + '</strong></td>' +
        '<td><span class="badge ' + stCls + '">' + esc(r.status || 'KARANTINA') + '</span></td>' +
        '<td>' + esc(r.ket || '-') + '<div class="muted" style="font-size:11px">Oleh ' + esc(r.by || '-') + '</div></td>' +
        '<td class="right" style="white-space:nowrap">' + actionBtns + '</td>' +
        '</tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  var bcEl = byId('def-bc');
  var skuEl = byId('def-sku');
  var namaEl = byId('def-nama');
  var lokEl = byId('def-lok');
  var qtyEl = byId('def-qty');
  var sumberEl = byId('def-sumber');
  var hintEl = byId('def-hint');
  var linkedBatchId = pre && pre.batchId ? pre.batchId : '';

  function updateDefHint() {
    var b = normBarcode(bcEl.value);
    var s = normSku(skuEl.value);
    var l = normLoc(lokEl.value);
    if (!b && !s) { hintEl.innerHTML = ''; return; }
    var hits = an.rows.filter(function (r) {
      return r.qty > 0 && ((b && normBarcode(r.barcode) === b) || (s && normSku(r.sku) === s));
    });
    if (hits.length === 0) {
      hintEl.innerHTML = '<div class="inline-alert info">Tidak ada stok bagus aktif terdeteksi di rak. Jika ini temuan saat bongkar muat, pilih <strong>Temuan Masuk / Tidak Potong Stok</strong>.</div>';
      return;
    }
    var badges = hits.map(function (h) {
      return '<button type="button" class="badge ' + (h.lok === l ? 'badge-ok' : 'badge-neutral') + '" data-pick-lok="' + esc(h.lok) + '" style="cursor:pointer">' + esc(h.lok) + ': ' + fmtNum(h.qty) + ' PCS</button>';
    }).join(' ');
    hintEl.innerHTML = '<div class="inline-alert info">Stok bagus tersedia (klik untuk isi lokasi): ' + badges + '</div>';
    hintEl.querySelectorAll('[data-pick-lok]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lokEl.value = btn.getAttribute('data-pick-lok');
        updateDefHint();
      });
    });
  }

  function lookupDefBc() {
    var b = normBarcode(bcEl.value);
    if (!b) { updateDefHint(); return null; }
    var m = findMasterByBarcode(d.master, b);
    if (m) {
      skuEl.value = normSku(m.sku);
      namaEl.value = m.nama || '';
    }
    updateDefHint();
    return m;
  }

  bcEl.addEventListener('input', lookupDefBc);
  bcEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var m = lookupDefBc();
      playBeep(!!m);
      if (!lokEl.value) lokEl.focus(); else qtyEl.focus();
    }
  });
  lokEl.addEventListener('input', updateDefHint);

  byId('def-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      bcEl.value = code;
      lookupDefBc();
      if (!lokEl.value) lokEl.focus(); else qtyEl.focus();
    });
  });

  if (pre) updateDefHint();

  byId('form-defect').addEventListener('submit', function (e) {
    e.preventDefault();
    var tgl = parseDate(byId('def-tgl').value);
    var bc = normBarcode(bcEl.value);
    var sku = normSku(skuEl.value);
    var nama = String(namaEl.value || '').trim();
    var lok = normLoc(lokEl.value);
    var qty = parseQty(qtyEl.value);
    var kat = byId('def-kat').value;
    var potongStok = sumberEl.value === 'POTONG_STOK';
    var batch = String(byId('def-batch').value || '').trim().toUpperCase();
    var exp = parseExpDate(byId('def-exp').value);
    var status = byId('def-status').value;
    var ket = String(byId('def-ket').value || '').trim();

    if (!tgl) { playBeep(false); showToast('Tanggal defect tidak valid', 'warn'); return; }
    if (!sku && !bc) { playBeep(false); showToast('Barcode atau SKU wajib diisi', 'warn'); bcEl.focus(); return; }
    if (!lok) { playBeep(false); showToast('Lokasi wajib diisi', 'warn'); lokEl.focus(); return; }
    if (!(qty > 0)) { playBeep(false); showToast('Qty harus lebih dari 0', 'warn'); qtyEl.focus(); return; }

    var dNow = curData();
    if (!sku && bc) {
      var mf = findMasterByBarcode(dNow.master, bc);
      if (mf) { sku = normSku(mf.sku); if (!nama) nama = mf.nama; }
    }

    function saveDefectRecord() {
      var defId = uid();
      var outId = '';
      var dFresh = curData();
      dFresh.defect = dFresh.defect || [];
      if (potongStok) {
        outId = uid();
        dFresh.keluar.push({
          id: outId,
          tgl: tgl,
          barcode: bc,
          sku: sku,
          nama: nama,
          lok: lok,
          qty: qty,
          ket: 'DEFECT [' + kat + ']' + (ket ? ' - ' + ket : ''),
          by: appState.W.user,
          n: 1,
          defectRefId: defId
        });
      }
      if (linkedBatchId && Array.isArray(dFresh.batches)) {
        dFresh.batches.forEach(function (b) {
          if (b.id === linkedBatchId) {
            b.qty = Math.max(0, Number(b.qty || 0) - qty);
            if (b.qty <= 0) b.status = 'HABIS';
          }
        });
      }
      dFresh.defect.push({
        id: defId,
        tgl: tgl,
        barcode: bc,
        sku: sku,
        nama: nama,
        lok: lok,
        qty: qty,
        kategori: kat,
        sumber: potongStok ? 'STOK RAK' : 'TEMUAN MASUK',
        status: status,
        ket: ket,
        batch: batch,
        exp: exp,
        potongStok: potongStok,
        keluarId: outId,
        by: appState.W.user,
        n: 1
      });
      writeWarehouseData(appState.W.cur, dFresh);
      playBeep(true);
      showToast('Barang defect dicatat (' + fmtNum(qty) + ' PCS)', 'ok');
      renderApp();
    }

    if (potongStok) {
      var k = stockKey(lok, sku, bc);
      var avail = an.stockMap[k] ? Number(an.stockMap[k].qty || 0) : 0;
      var locSet = new Set((d.lokasi || []).map(normLoc));
      if (!locSet.has(lok) || qty > avail) {
        playBeep(false);
        confirmDialog(
          'Konfirmasi Potong Stok Rak',
          '<p style="margin:0">' +
          (!locSet.has(lok) ? 'Lokasi <strong>' + esc(lok) + '</strong> belum ada di Master Lokasi. ' : '') +
          (qty > avail ? 'Qty defect (' + fmtNum(qty) + ') melebihi stok bagus di ' + esc(lok) + ' (' + fmtNum(avail) + ' PCS). ' : '') +
          'Tetap catat defect dan potong stok?</p>',
          saveDefectRecord,
          true
        );
        return;
      }
    }
    saveDefectRecord();
  });

  byId('search-defect').addEventListener('input', function (e) {
    appState.searchState.defect = targetEl(e).value;
    renderApp();
    var s = byId('search-defect');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });

  root.querySelectorAll('[data-df]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.defectFilter = b.getAttribute('data-df');
      renderApp();
    });
  });

  root.querySelectorAll('[data-def-status]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-def-id');
      var nextStatus = b.getAttribute('data-def-status');
      confirmDialog(
        'Ubah Status Defect',
        '<p style="margin:0">Ubah status catatan defect ini menjadi <strong>' + esc(nextStatus) + '</strong>?</p>',
        function () {
          var dNow = curData();
          (dNow.defect || []).forEach(function (x) {
            if (x.id === id) x.status = nextStatus;
          });
          writeWarehouseData(appState.W.cur, dNow);
          showToast('Status defect diperbarui ke ' + nextStatus, 'ok');
          renderApp();
        },
        nextStatus === 'MUSNAH'
      );
    });
  });

  root.querySelectorAll('[data-def-repack]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-def-repack');
      var target = allDef.find(function (x) { return x.id === id; });
      if (!target) return;
      var dstLok = (d.lokasi && d.lokasi.indexOf(target.lok) >= 0) ? target.lok : (d.lokasi[0] || target.lok || 'STAGING');
      confirmDialog(
        'Repack & Kembalikan ke Stok Bagus',
        '<p style="margin:0">Produk <strong>' + esc(target.nama || target.sku) + '</strong> sebanyak <strong>' + fmtNum(target.qty) + ' PCS</strong> akan ditandai <strong>REPACK</strong> dan otomatis dimasukkan kembali ke stok bagus lokasi <strong>' + esc(dstLok) + '</strong>. Lanjutkan?</p>',
        function () {
          var dNow = curData();
          var inId = uid();
          dNow.masuk.push({
            id: inId,
            tgl: todayISO(),
            barcode: target.barcode,
            sku: target.sku,
            nama: target.nama,
            lok: dstLok,
            qty: target.qty,
            batch: target.batch || '',
            exp: target.exp || '',
            ket: 'REPACK DARI DEFECT (' + target.kategori + ')',
            by: appState.W.user,
            n: 1
          });
          (dNow.defect || []).forEach(function (x) {
            if (x.id === id) {
              x.status = 'REPACK';
              x.repackMasukId = inId;
            }
          });
          writeWarehouseData(appState.W.cur, dNow);
          showToast('Repack berhasil: +' + fmtNum(target.qty) + ' PCS masuk ke ' + dstLok, 'ok');
          renderApp();
        },
        false
      );
    });
  });

  root.querySelectorAll('[data-del-defect]').forEach(function (b) {
    b.addEventListener('click', function () {
      removeTxSafely('defect', b.getAttribute('data-del-defect'));
    });
  });

  byId('copy-defect-btn').addEventListener('click', function () {
    openCopyTSV('Salin Daftar Barang Defect', ['Tanggal', 'Barcode', 'SKU', 'Nama Produk', 'Lokasi', 'Kategori', 'Batch', 'Expire', 'Qty', 'Status', 'Sumber', 'Keterangan', 'Petugas'], rows.map(function (r) {
      return [r.tgl, r.barcode, r.sku, r.nama, r.lok, r.kategori, r.batch || '', r.exp || '', r.qty, r.status, r.sumber, r.ket, r.by];
    }));
  });
}

// === HALAMAN 3B: MONITOR EXPIRE (< 7 BULAN OTOMATIS TERDETEKSI) ===
export function renderExpire(root, d, an) {
  var expMonths = Number(d.expMonths || 7);
  var locOpts = d.lokasi.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
  var bcOpts = d.master.map(function (m) { return '<option value="' + esc(m.barcode) + '">' + esc(m.sku + ' — ' + m.nama) + '</option>'; }).join('');

  var critOnly = an.expSoonList.filter(function (b) { return b.expInfo.status === 'crit'; });
  var warnOnly = an.expSoonList.filter(function (b) { return b.expInfo.status === 'warn'; });
  var okOnly = an.batchRows.filter(function (b) { return b.expInfo.status === 'ok'; });

  var html = pageHeaderHtml(
    'Monitor Expire (< ' + expMonths + ' Bulan)',
    'Deteksi otomatis barang kadaluwarsa dan mendekati expire kurang dari ' + expMonths + ' bulan, diurutkan FEFO (First Expired First Out).'
  );

  html += '<div class="kpi-grid">' +
    '<div class="kpi-card err"><div class="kpi-label">Sudah Expired</div><div class="kpi-value num">' + fmtNum(an.expiredList.length) + ' batch</div><div class="kpi-sub">' + fmtNum(an.expiredList.reduce(function (s, b) { return s + b.qty; }, 0)) + ' PCS — Segera karantina</div></div>' +
    '<div class="kpi-card err"><div class="kpi-label">Kritis (&lt; 3 Bulan)</div><div class="kpi-value num">' + fmtNum(critOnly.length) + ' batch</div><div class="kpi-sub">' + fmtNum(critOnly.reduce(function (s, b) { return s + b.qty; }, 0)) + ' PCS — Prioritas keluar</div></div>' +
    '<div class="kpi-card warn"><div class="kpi-label">Siaga (&lt; ' + expMonths + ' Bulan)</div><div class="kpi-value num">' + fmtNum(warnOnly.length) + ' batch</div><div class="kpi-sub">' + fmtNum(warnOnly.reduce(function (s, b) { return s + b.qty; }, 0)) + ' PCS — Promo / FEFO</div></div>' +
    '<div class="kpi-card ok"><div class="kpi-label">Batch Aman (≥ ' + expMonths + ' Bulan)</div><div class="kpi-value num">' + fmtNum(okOnly.length) + ' batch</div><div class="kpi-sub">' + fmtNum(okOnly.reduce(function (s, b) { return s + b.qty; }, 0)) + ' PCS aktif terpantau</div></div>' +
    '</div>';

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Catat / Tambah Batch Expire</h2>' +
    '<button type="button" class="btn btn-sm" id="exp-paste-btn">Tempel Massal (Sheets)</button></div>' +
    '<form id="form-exp" class="form-grid">' +
    '<div class="field"><label for="exp-bc">Barcode</label><div class="scan-row"><input id="exp-bc" type="text" class="input mono" list="dl-exp-bc" placeholder="Scan / ketik barcode…" autocapitalize="characters" autocomplete="off" /><button type="button" class="btn" id="exp-cam-btn">Kamera</button></div></div>' +
    '<div class="field"><label for="exp-sku">SKU</label><input id="exp-sku" type="text" class="input mono" autocapitalize="characters" placeholder="Otomatis / manual" /></div>' +
    '<div class="field"><label for="exp-nama">Nama Produk</label><input id="exp-nama" type="text" class="input" placeholder="Otomatis dari Master" /></div>' +
    '<div class="field"><label for="exp-lok">Lokasi</label><input id="exp-lok" type="text" class="input" list="dl-exp-lok" autocapitalize="characters" placeholder="RAK-A1" autocomplete="off" /></div>' +
    '<div class="field"><label for="exp-batch">No. Batch / Lot</label><input id="exp-batch" type="text" class="input mono" autocapitalize="characters" placeholder="LOT-26A" /></div>' +
    '<div class="field"><label for="exp-date">Tanggal Expire</label><input id="exp-date" type="date" class="input" required /></div>' +
    '<div class="field"><label for="exp-qty">Qty Batch (PCS)</label><input id="exp-qty" type="text" inputmode="decimal" class="input num" placeholder="0" /></div>' +
    '<div class="field"><label for="exp-ket">Catatan</label><input id="exp-ket" type="text" class="input" placeholder="Opsional" /></div>' +
    '<div class="field"><button type="submit" class="btn btn-primary">Simpan Batch</button></div>' +
    '</form>' +
    '<datalist id="dl-exp-lok">' + locOpts + '</datalist>' +
    '<datalist id="dl-exp-bc">' + bcOpts + '</datalist>' +
    '<div id="exp-live-check"></div>' +
    '</div>';

  var q = appState.searchState.expire.trim().toUpperCase();
  var rows = an.batchRows.filter(function (b) {
    if (appState.expFilter === 'alert' && !b.expInfo.isAlert) return false;
    if (appState.expFilter === 'expired' && b.expInfo.status !== 'expired') return false;
    if (appState.expFilter === 'crit' && b.expInfo.status !== 'crit') return false;
    if (appState.expFilter === 'warn' && b.expInfo.status !== 'warn') return false;
    if (appState.expFilter === 'ok' && b.expInfo.status !== 'ok') return false;
    if (!q) return true;
    return [b.lok, b.barcode, b.sku, b.nama, b.batch, b.exp, b.ket].join(' ').toUpperCase().indexOf(q) >= 0;
  });

  html += '<div class="card"><div class="card-header"><h2 class="card-title">Daftar Batch (Urutan FEFO — Expire Terdekat di Atas)</h2><span class="muted" style="font-size:12px">' + rows.length + ' batch</span></div>' +
    '<div class="toolbar">' +
    '<div class="search-wrap"><input id="search-expire" type="search" class="input" placeholder="Cari lokasi, SKU, nama, batch…" value="' + esc(appState.searchState.expire) + '" /><span class="search-kbd">/</span></div>' +
    '<div class="seg-group" role="tablist">' +
    '<button type="button" class="seg-btn' + (appState.expFilter === 'alert' ? ' active' : '') + '" data-ef="alert">Terdeteksi &lt; ' + expMonths + ' Bln (' + an.expAlerts.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.expFilter === 'expired' ? ' active' : '') + '" data-ef="expired">Expired (' + an.expiredList.length + ')</button>' +
    '<button type="button" class="seg-btn' + (appState.expFilter === 'crit' ? ' active' : '') + '" data-ef="crit">&lt; 3 Bln</button>' +
    '<button type="button" class="seg-btn' + (appState.expFilter === 'ok' ? ' active' : '') + '" data-ef="ok">Aman</button>' +
    '<button type="button" class="seg-btn' + (appState.expFilter === 'all' ? ' active' : '') + '" data-ef="all">Semua</button>' +
    '</div>' +
    '<button type="button" class="btn" id="copy-exp-btn">Salin ke Sheets</button>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Tgl Expire</th><th>Status Deteksi</th><th>Lokasi</th><th>Batch</th><th>Produk</th><th class="right">Qty</th><th class="right">Tindakan Cepat</th></tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Tidak ada batch pada filter ini.</td></tr>';
  } else {
    rows.forEach(function (b) {
      html += '<tr>' +
        '<td class="num"><strong>' + esc(b.exp || '-') + '</strong></td>' +
        '<td><span class="badge ' + b.expInfo.badgeCls + '">' + esc(b.expInfo.label) + '</span></td>' +
        '<td>' + esc(b.lok || '-') + '</td>' +
        '<td class="mono">' + esc(b.batch || '-') + '</td>' +
        '<td><strong>' + esc(b.nama || b.sku) + '</strong><div class="mono muted" style="font-size:11.5px">' + esc(b.sku) + (b.barcode ? ' · ' + esc(b.barcode) : '') + '</div></td>' +
        '<td class="right num"><strong>' + fmtNum(b.qty) + '</strong></td>' +
        '<td class="right" style="white-space:nowrap">' +
        '<button type="button" class="btn btn-sm" data-exp-out="' + esc(b.id) + '" title="Keluarkan batch ini lewat Barang Keluar">Keluarkan</button> ' +
        '<button type="button" class="btn btn-sm" data-exp-def="' + esc(b.id) + '" title="Pindahkan ke Barang Defect">Ke Defect</button> ' +
        '<button type="button" class="btn btn-sm" data-exp-done="' + esc(b.id) + '" title="Tandai batch sudah habis">Habis</button> ' +
        '<button type="button" class="btn btn-sm btn-danger" data-exp-del="' + esc(b.id) + '">Hapus</button>' +
        '</td></tr>';
    });
  }
  html += '</tbody></table></div></div>';

  root.innerHTML = html;

  var bcEl = byId('exp-bc');
  var skuEl = byId('exp-sku');
  var namaEl = byId('exp-nama');
  var lokEl = byId('exp-lok');
  var dateEl = byId('exp-date');
  var qtyEl = byId('exp-qty');
  var liveCheckEl = byId('exp-live-check');

  function checkExpInput() {
    var ev = parseExpDate(dateEl.value);
    if (!ev) { liveCheckEl.innerHTML = ''; return; }
    var info = classifyExpiry(ev, expMonths);
    if (info.isAlert) {
      playBeep(false);
      liveCheckEl.innerHTML = '<div class="inline-alert ' + (info.status === 'warn' ? 'warn' : 'err') + '">⚠️ <strong>TERDETEKSI &lt; ' + expMonths + ' BULAN:</strong> ' + esc(info.label) + ' (' + esc(ev) + ').</div>';
    } else {
      liveCheckEl.innerHTML = '<div class="inline-alert ok">✅ Masa expire aman (' + esc(info.label) + ').</div>';
    }
  }

  dateEl.addEventListener('change', checkExpInput);
  dateEl.addEventListener('input', checkExpInput);

  function lookupExpBc() {
    var b = normBarcode(bcEl.value);
    if (!b) return null;
    var m = findMasterByBarcode(d.master, b);
    if (m) {
      skuEl.value = normSku(m.sku);
      namaEl.value = m.nama || '';
    }
    return m;
  }

  bcEl.addEventListener('input', lookupExpBc);
  bcEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var m = lookupExpBc();
      playBeep(!!m);
      lokEl.focus();
    }
  });

  byId('exp-cam-btn').addEventListener('click', function () {
    openCameraScanner(function (code) {
      bcEl.value = code;
      lookupExpBc();
      lokEl.focus();
    });
  });

  byId('form-exp').addEventListener('submit', function (e) {
    e.preventDefault();
    var bc = normBarcode(bcEl.value);
    var sku = normSku(skuEl.value);
    var nama = String(namaEl.value || '').trim();
    var lok = normLoc(lokEl.value);
    var batch = String(byId('exp-batch').value || '').trim().toUpperCase();
    var exp = parseExpDate(dateEl.value);
    var qty = parseQty(qtyEl.value);
    var ket = String(byId('exp-ket').value || '').trim();

    if (!sku && !bc) { playBeep(false); showToast('Barcode atau SKU wajib diisi', 'warn'); bcEl.focus(); return; }
    if (!exp) { playBeep(false); showToast('Tanggal expire wajib diisi', 'warn'); dateEl.focus(); return; }
    if (!(qty > 0)) { playBeep(false); showToast('Qty harus lebih dari 0', 'warn'); qtyEl.focus(); return; }

    var dNow = curData();
    if (!sku && bc) {
      var mf = findMasterByBarcode(dNow.master, bc);
      if (mf) { sku = normSku(mf.sku); if (!nama) nama = mf.nama; }
    }
    dNow.batches = dNow.batches || [];
    dNow.batches.push({
      id: uid(),
      tglMasuk: todayISO(),
      lok: lok,
      barcode: bc,
      sku: sku,
      nama: nama,
      batch: batch,
      exp: exp,
      qty: qty,
      status: 'AKTIF',
      ket: ket,
      by: appState.W.user
    });
    writeWarehouseData(appState.W.cur, dNow);
    var info = classifyExpiry(exp, expMonths);
    if (info.isAlert) {
      playBeep(false);
      showToast('Batch disimpan — Terdeteksi ' + info.label + '!', 'warn');
    } else {
      playBeep(true);
      showToast('Batch expire disimpan', 'ok');
    }
    renderApp();
  });

  byId('exp-paste-btn').addEventListener('click', function () {
    openTextModal({
      title: 'Tempel Massal Data Batch / Expire',
      desc: 'Format per baris (Tab / Koma): Lokasi, Barcode, SKU, Nama, Batch, Tgl Expire (YYYY-MM-DD / MM/YYYY), Qty',
      text: '',
      actionLabel: 'Tambahkan Batch',
      readonly: false,
      onAction: function () {
        var lines = parseDelimitedLines(byId('text-modal-area').value);
        var dNow = curData();
        dNow.batches = dNow.batches || [];
        var added = 0;
        lines.forEach(function (cols) {
          var lok = normLoc(cols[0]);
          var bc = normBarcode(cols[1]);
          var sku = normSku(cols[2]);
          var nama = String(cols[3] || '').trim();
          var batch = String(cols[4] || '').trim().toUpperCase();
          var exp = parseExpDate(cols[5]);
          var qty = parseQty(cols[6]);
          if (!sku && bc) {
            var mf = findMasterByBarcode(dNow.master, bc);
            if (mf) { sku = normSku(mf.sku); if (!nama) nama = mf.nama; }
          }
          if ((sku || bc) && exp) {
            dNow.batches.push({
              id: uid(),
              tglMasuk: todayISO(),
              lok: lok,
              barcode: bc,
              sku: sku,
              nama: nama,
              batch: batch,
              exp: exp,
              qty: qty > 0 ? qty : 1,
              status: 'AKTIF',
              ket: 'Tempel Massal',
              by: appState.W.user
            });
            added++;
          }
        });
        if (added === 0) { showToast('Tidak ada baris valid (pastikan Tgl Expire terbaca)', 'warn'); return; }
        writeWarehouseData(appState.W.cur, dNow);
        closeTextModal();
        showToast(added + ' batch expire ditambahkan', 'ok');
        renderApp();
      }
    });
  });

  byId('search-expire').addEventListener('input', function (e) {
    appState.searchState.expire = targetEl(e).value;
    renderApp();
    var s = byId('search-expire');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });

  root.querySelectorAll('[data-ef]').forEach(function (b) {
    b.addEventListener('click', function () {
      appState.expFilter = b.getAttribute('data-ef');
      renderApp();
    });
  });

  root.querySelectorAll('[data-exp-out]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-exp-out');
      var item = an.batchRows.find(function (x) { return x.id === id; });
      if (!item) return;
      window.__keluarPrefill = {
        lok: item.lok,
        sku: item.sku,
        barcode: item.barcode,
        qty: item.qty,
        exp: item.exp || '',
        ket: 'FEFO Batch ' + (item.batch || item.exp)
      };
      appState.keluarRole = 'stockkeeper';
      appState.keluarEditId = '';
      appState.currentTab = 'keluar';
      renderApp();
    });
  });

  root.querySelectorAll('[data-exp-def]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-exp-def');
      var item = an.batchRows.find(function (x) { return x.id === id; });
      if (!item) return;
      window.__defectPrefill = {
        batchId: item.id,
        barcode: item.barcode,
        sku: item.sku,
        nama: item.nama,
        lok: item.lok,
        qty: item.qty,
        batch: item.batch,
        exp: item.exp,
        kategori: 'KADALUWARSA / EXPIRE',
        potongStok: true,
        ket: 'Dipindahkan dari Monitor Expire (' + item.expInfo.label + ')'
      };
      appState.currentTab = 'defect';
      renderApp();
    });
  });

  root.querySelectorAll('[data-exp-done]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-exp-done');
      confirmDialog(
        'Tandai Batch Habis',
        '<p style="margin:0">Batch ini akan ditandai habis dan dihapus dari daftar peringatan expire aktif. Lanjutkan?</p>',
        function () {
          var dNow = curData();
          (dNow.batches || []).forEach(function (x) { if (x.id === id) x.status = 'HABIS'; });
          writeWarehouseData(appState.W.cur, dNow);
          showToast('Batch ditandai habis', 'ok');
          renderApp();
        },
        false
      );
    });
  });

  root.querySelectorAll('[data-exp-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-exp-del');
      confirmDialog(
        'Hapus Catatan Batch',
        '<p style="margin:0">Yakin ingin menghapus catatan batch expire ini?</p>',
        function () {
          var dNow = curData();
          dNow.batches = (dNow.batches || []).filter(function (x) { return x.id !== id; });
          writeWarehouseData(appState.W.cur, dNow);
          showToast('Catatan batch dihapus', 'ok');
          renderApp();
        },
        true
      );
    });
  });

  byId('copy-exp-btn').addEventListener('click', function () {
    openCopyTSV('Salin Monitor Expire', ['Tgl Expire', 'Status', 'Lokasi', 'Batch', 'Barcode', 'SKU', 'Nama Produk', 'Qty', 'Catatan'], rows.map(function (b) {
      return [b.exp, b.expInfo.label, b.lok, b.batch || '', b.barcode, b.sku, b.nama, b.qty, b.ket || ''];
    }));
  });
}
