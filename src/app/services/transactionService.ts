import { getMasukInboundMatch, isMasukAncanthoDone } from '../core/cycleCountEngine.ts';
import { curData, getWhMeta, readWarehouseData, writeWarehouseData } from '../core/warehouseRegistry.ts';
import { appState, renderApp } from '../state/store.ts';
import { confirmDialog, openTextModal, showToast } from '../ui/feedback.ts';
import { esc, fmtNum, todayISO } from '../utils/format.ts';

export function openWhatsappSlipModal(title?: string, desc?: string, messageText?: string) {
  openTextModal({
    title: title || 'Slip & Laporan WhatsApp',
    desc: desc || 'Periksa atau sesuaikan pesan sebelum menyalin atau mengirim via WhatsApp.',
    text: messageText,
    actionLabel: 'Salin Pesan',
    readonly: false,
    allowWhatsapp: true
  });
}

export function buildDailyWhatsappReport(d, an) {
  var today = todayISO();
  var whName = getWhMeta(appState.W.cur).nama;
  var st = an.stats;
  var masukTodayRows = (d.masuk || []).filter(function (r) { return r.tgl === today; });
  var keluarTodayRows = (d.keluar || []).filter(function (r) { return r.tgl === today; });
  var pindahTodayRows = (d.pindah || []).filter(function (r) { return r.tgl === today; });

  var lines = [
    '*LAPORAN HARIAN GUDANG — ' + whName.toUpperCase() + '*',
    'Tanggal: ' + today + ' | Petugas: ' + (appState.W.user || '-'),
    '',
    '*1. BARANG MASUK*',
    '- Masuk hari ini: +' + fmtNum(st.masukToday) + ' PCS (' + fmtNum(masukTodayRows.length) + ' input)',
    '- Menunggu Ancantho: ' + fmtNum(st.masukPending) + ' baris (' + fmtNum(st.masukPendingPcs) + ' PCS)',
    '',
    '*2. ANTREAN INBOUND (MATCHING ANCANTHO)*',
    '- Match: ' + fmtNum(st.inboundMatched) + ' | Selisih: ' + fmtNum(st.inboundMismatch) + ' | Belum Diisi: ' + fmtNum(st.inboundUnfilled),
    '',
    '*3. BARANG KELUAR*',
    '- Keluar hari ini: -' + fmtNum(st.keluarToday) + ' PCS (' + fmtNum(keluarTodayRows.length) + ' input)',
    '- Menunggu Ancantho: ' + fmtNum(st.keluarPending) + ' baris',
    '',
    '*4. PERPINDAHAN BARANG*',
    '- Hari ini: ' + fmtNum(st.pindahTodayCount) + ' mutasi (' + fmtNum(st.pindahTodayQty) + ' PCS)',
    '',
    '*5. RINGKASAN STOK*',
    '- Total Stok Bagus: ' + fmtNum(st.totalPcs) + ' PCS (' + fmtNum(st.skuAktif) + ' SKU di ' + fmtNum(st.lokasiTerisi) + ' lokasi)'
  ];

  if (pindahTodayRows.length > 0) {
    lines.push('', '*Detail Pindah Hari Ini (Maks 8):*');
    pindahTodayRows.slice(-8).forEach(function (r) {
      lines.push('• ' + (r.nama || r.sku) + ': ' + r.dari + ' -> ' + r.ke + ' (' + fmtNum(r.qty) + ' PCS)');
    });
  }
  return lines.join('\n');
}

export function buildInboundWhatsappSlip(d, an) {
  var whName = getWhMeta(appState.W.cur).nama;
  var pending = (d.masuk || []).filter(function (r) { return !isMasukAncanthoDone(r); });
  var lines = [
    '*SLIP SERAH TERIMA INBOUND — ' + whName.toUpperCase() + '*',
    'Tanggal: ' + todayISO(),
    'Match: ' + fmtNum(an.stats.inboundMatched) + ' | Selisih: ' + fmtNum(an.stats.inboundMismatch) + ' | Belum Diisi: ' + fmtNum(an.stats.inboundUnfilled),
    ''
  ];
  if (pending.length === 0) {
    lines.push('Semua antrean inbound sudah Done di sistem Ancantho.');
  } else {
    pending.slice(0, 20).forEach(function (r, idx) {
      var im = getMasukInboundMatch(r);
      var inbTxt = im.hasInbound ? fmtNum(im.inboundQty) : 'Belum isi';
      lines.push((idx + 1) + '. [' + (r.lok || '-') + '] ' + (r.nama || r.sku) + ' | SK: ' + fmtNum(r.qty) + ' | Inbound: ' + inbTxt + ' (' + im.label + ')' + (r.exp ? ' | Exp ' + r.exp : ''));
    });
    if (pending.length > 20) lines.push('... +' + (pending.length - 20) + ' baris antrean lainnya');
  }
  return lines.join('\n');
}

export function buildKeluarWhatsappSlip(d) {
  var whName = getWhMeta(appState.W.cur).nama;
  var today = todayISO();
  var rows = (d.keluar || []).filter(function (r) { return r.tgl === today || !isMasukAncanthoDone(r); });
  var lines = [
    '*SLIP BARANG KELUAR — ' + whName.toUpperCase() + '*',
    'Tanggal: ' + today,
    ''
  ];
  if (rows.length === 0) {
    lines.push('Belum ada transaksi barang keluar hari ini.');
  } else {
    rows.slice(-20).forEach(function (r, idx) {
      lines.push((idx + 1) + '. [' + (r.lok || '-') + '] ' + (r.nama || r.sku) + ' | -' + fmtNum(r.qty) + ' PCS | SK: ' + (r.by || '-') + ' | ' + (isMasukAncanthoDone(r) ? 'Done' : 'Menunggu Admin'));
    });
  }
  return lines.join('\n');
}

export function buildPindahWhatsappSlip(d: any, singleRow?: any) {
  var whName = getWhMeta(appState.W.cur).nama;
  var today = todayISO();
  if (singleRow) {
    return [
      '*SLIP PERPINDAHAN BARANG — ' + whName.toUpperCase() + '*',
      'Tanggal: ' + (singleRow.tgl || today),
      'Produk: ' + (singleRow.nama || singleRow.sku) + ' (' + (singleRow.barcode || singleRow.sku || '-') + ')',
      'Dari Lokasi: ' + singleRow.dari,
      'Ke Lokasi: ' + singleRow.ke,
      'Expiry Date: ' + (singleRow.exp || '-'),
      'Qty: ' + fmtNum(singleRow.qty) + ' PCS',
      'Petugas: ' + (singleRow.by || appState.W.user || '-')
    ].join('\n');
  }
  var rows = (d.pindah || []).filter(function (r) { return r.tgl === today; });
  var lines = [
    '*LAPORAN PERPINDAHAN BARANG — ' + whName.toUpperCase() + '*',
    'Tanggal: ' + today,
    ''
  ];
  if (rows.length === 0) {
    lines.push('Belum ada perpindahan barang tercatat hari ini.');
  } else {
    rows.slice(-20).forEach(function (r, idx) {
      lines.push((idx + 1) + '. ' + (r.nama || r.sku) + ' | ' + r.dari + ' -> ' + r.ke +
        (r.exp ? ' | Exp ' + r.exp : '') + ' | ' + fmtNum(r.qty) + ' PCS (' + (r.by || '-') + ')');
    });
  }
  return lines.join('\n');
}

// === HAPUS TRANSAKSI (TERMASUK TRANSFER GUDANG ATOMIK) ===
export function removeTxSafely(type, id) {
  var d = curData();
  var list = d[type] || [];
  var target = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) { target = list[i]; break; }
  }
  if (!target) return;

  if (target.pairId) {
    var partnerName = target.partnerWhId ? getWhMeta(target.partnerWhId).nama : 'gudang pasangan';
    confirmDialog(
      'Hapus Transfer Antar-Gudang',
      '<p style="margin:0">Transaksi ini terhubung dengan <strong>' + esc(partnerName) + '</strong>. Transfer tidak boleh dihapus sebelah saja. Menghapus transaksi ini akan menghapus kedua sisi agar total stok tetap seimbang.</p>',
      function () {
        var dNow = curData();
        dNow[type] = (dNow[type] || []).filter(function (x) { return x.pairId !== target.pairId; });
        writeWarehouseData(appState.W.cur, dNow);
        if (target.partnerWhId && appState.W.list.some(function (w) { return w.id === target.partnerWhId; })) {
          var pd = readWarehouseData(target.partnerWhId);
          var pType = type === 'keluar' ? 'masuk' : 'keluar';
          pd[pType] = (pd[pType] || []).filter(function (x) { return x.pairId !== target.pairId; });
          writeWarehouseData(target.partnerWhId, pd);
        }
        showToast('Pasangan transfer berhasil dihapus di kedua gudang', 'ok');
        renderApp();
      },
      true
    );
  } else {
    confirmDialog(
      'Hapus Baris Transaksi',
      '<p style="margin:0">Yakin ingin menghapus catatan <strong>' + esc(target.nama || target.sku) + '</strong> (' + fmtNum(target.qty) + ' PCS)?</p>',
      function () {
        var dNow = curData();
        dNow[type] = (dNow[type] || []).filter(function (x) { return x.id !== id; });
        if (type === 'masuk') {
          dNow.batches = (dNow.batches || []).filter(function (b) { return b.masukId !== id; });
        }
        if (type === 'keluar' && target.defectRefId) {
          dNow.defect = (dNow.defect || []).filter(function (x) { return x.id !== target.defectRefId; });
        }
        if (type === 'defect') {
          if (target.keluarId) {
            dNow.keluar = (dNow.keluar || []).filter(function (x) { return x.id !== target.keluarId; });
          }
          if (target.repackMasukId) {
            dNow.masuk = (dNow.masuk || []).filter(function (x) { return x.id !== target.repackMasukId; });
          }
        }
        writeWarehouseData(appState.W.cur, dNow);
        showToast('Catatan dihapus', 'ok');
        renderApp();
      },
      true
    );
  }
}
