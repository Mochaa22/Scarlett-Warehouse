import { addDaysISO, addMonthsISO, todayISO, uid } from '../utils/format.ts';

// === GUARD SEEDER: HANYA AKTIF DI MODE DEVELOPMENT (LOCALHOST) ===
export function isLocalDevEnvironment(): boolean {
  const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  if (!isDev || typeof window === 'undefined') return false;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// === DATA CONTOH (DEV ONLY) ===
export function buildSampleData() {
  if (!isLocalDevEnvironment()) {
    throw new Error('Fungsi pengisian data contoh (seeder) dinonaktifkan di mode production.');
  }
  var today = todayISO();
  var cut = addDaysISO(today, -20);
  var master = [
    { barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', kategori: 'Body Lotion' },
    { barcode: '8997236030029', sku: '5000012', nama: 'Scarlett Body Scrub Pomegranate 250ml', kategori: 'Body Scrub' },
    { barcode: '8997236030036', sku: '5000024', nama: 'Scarlett Brightly Ever After Serum 15ml', kategori: 'Serum' },
    { barcode: '8997236030043', sku: '5000025', nama: 'Scarlett Acne Serum 15ml', kategori: 'Serum' },
    { barcode: '8997236030050', sku: '5000041', nama: 'Scarlett C-Power Toner 100ml', kategori: 'Toner & Essence' },
    { barcode: '8997236031231', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V1)', kategori: 'Body Cream' },
    { barcode: '8997236031239', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V2)', kategori: 'Body Cream' },
    { barcode: '8997236030067', sku: '5000062', nama: 'Scarlett Sun Bright Daily Sunscreen 50ml', kategori: 'Sunscreen' },
    { barcode: '8997236030098', sku: '5000088', nama: 'Scarlett Shower Scrub Jolly 300ml', kategori: 'Shower Scrub' }
  ];
  var lokasi = ['RAK-A1', 'RAK-A2', 'RAK-B1', 'RAK-B2', 'RAK-C1', 'STAGING', 'DISPLAY', 'RETUR'];
  var opening = [
    { lok: 'RAK-A1', barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', qty: 120 },
    { lok: 'RAK-A2', barcode: '8997236030029', sku: '5000012', nama: 'Scarlett Body Scrub Pomegranate 250ml', qty: 80 },
    { lok: 'RAK-B1', barcode: '8997236030036', sku: '5000024', nama: 'Scarlett Brightly Ever After Serum 15ml', qty: 45 },
    { lok: 'RAK-B1', barcode: '8997236030050', sku: '5000041', nama: 'Scarlett C-Power Toner 100ml', qty: 3 },
    { lok: 'RAK-B2', barcode: '8997236030043', sku: '5000025', nama: 'Scarlett Acne Serum 15ml', qty: 14 },
    { lok: 'RAK-C1', barcode: '8997236031231', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V1)', qty: 30 },
    { lok: 'RAK-C1', barcode: '8997236031239', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V2)', qty: 18 },
    { lok: 'DISPLAY', barcode: '8997236030067', sku: '5000062', nama: 'Scarlett Sun Bright Daily Sunscreen 50ml', qty: 9 },
    { lok: 'DISPLAY', barcode: '8997236030098', sku: '5000088', nama: 'Scarlett Shower Scrub Jolly 300ml', qty: 24 }
  ];
  var masuk = [
    { id: uid(), tgl: addDaysISO(today, -25), barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', lok: 'RAK-A1', qty: 40, inboundQty: 40, ket: 'Periode lama', by: 'Rina', n: 0, ancanthoDone: true, ancanthoBy: 'Admin Gudang', ancanthoKet: 'Data periode sebelumnya', ancanthoAt: addDaysISO(today, -25) + ' 17:00' },
    { id: uid(), tgl: addDaysISO(today, -6), barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', lok: 'RAK-A1', qty: 50, inboundQty: 50, exp: addMonthsISO(today, 14), ket: 'Restock Pabrik', by: 'Budi', n: 1, ancanthoDone: true, ancanthoBy: 'Siska (Admin)', ancanthoKet: 'Transfer ke RAK-A1 selesai di Ancantho', ancanthoAt: addDaysISO(today, -6) + ' 14:20' },
    { id: uid(), tgl: addDaysISO(today, -2), barcode: '8997236030036', sku: '5000024', nama: 'Scarlett Brightly Ever After Serum 15ml', lok: 'RAK-B1', qty: 30, inboundQty: 30, exp: addMonthsISO(today, 5), ket: 'Restock Pabrik', by: 'Budi', n: 1, ancanthoDone: false, ancanthoBy: '', ancanthoKet: '', ancanthoAt: '' },
    { id: uid(), tgl: today, barcode: '8997236030029', sku: '5000012', nama: 'Scarlett Body Scrub Pomegranate 250ml', lok: 'RAK-A2', qty: 25, inboundQty: 28, exp: addMonthsISO(today, 10), ket: 'Masuk Harian', by: 'Rudi', n: 1, ancanthoDone: false, ancanthoBy: '', ancanthoKet: '', ancanthoAt: '' }
  ];
  var keluar = [
    { id: uid(), tgl: addDaysISO(today, -5), barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', lok: 'RAK-A1', qty: 35, exp: addMonthsISO(today, 14), ket: 'Order Marketplace', by: 'Sari', n: 1, ancanthoDone: true, ancanthoBy: 'Siska (Admin)', ancanthoKet: 'Sudah potong stok dari RAK-A1 di Ancantho', ancanthoAt: addDaysISO(today, -5) + ' 15:10' },
    { id: uid(), tgl: addDaysISO(today, -3), barcode: '8997236030029', sku: '5000012', nama: 'Scarlett Body Scrub Pomegranate 250ml', lok: 'RAK-A2', qty: 42, exp: addMonthsISO(today, 10), ket: 'Order Reseller', by: 'Sari', n: 1, ancanthoDone: true, ancanthoBy: 'Siska (Admin)', ancanthoKet: 'Done di Ancantho', ancanthoAt: addDaysISO(today, -3) + ' 16:05' },
    { id: uid(), tgl: addDaysISO(today, -1), barcode: '8997236030043', sku: '5000025', nama: 'Scarlett Acne Serum 15ml', lok: 'RAK-B2', qty: 8, exp: addDaysISO(today, -5), ket: 'Order Flash Sale', by: 'Budi', n: 1, ancanthoDone: false, ancanthoBy: '', ancanthoKet: '', ancanthoAt: '' },
    { id: uid(), tgl: today, barcode: '8997236031231', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V1)', lok: 'RAK-C1', qty: 12, exp: addDaysISO(today, 68), ket: 'Order Reguler', by: 'Rudi', n: 1, ancanthoDone: false, ancanthoBy: '', ancanthoKet: '', ancanthoAt: '' }
  ];
  var pindah = [
    { id: uid(), tgl: addDaysISO(today, -4), dari: 'RAK-A1', ke: 'STAGING', barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', qty: 15, by: 'Budi', n: 1 }
  ];
  var defect = [
    { id: uid(), tgl: addDaysISO(today, -2), barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', lok: 'RETUR', qty: 4, kategori: 'BOCOR / REMBES', sumber: 'STOK RAK', status: 'KARANTINA', ket: 'Botol retak saat bongkar muat', batch: 'B2601', exp: '', potongStok: false, by: 'Budi', n: 1 },
    { id: uid(), tgl: today, barcode: '8997236030043', sku: '5000025', nama: 'Scarlett Acne Serum 15ml', lok: 'RAK-B2', qty: 2, kategori: 'SEGEL RUSAK', sumber: 'TEMUAN MASUK', status: 'KARANTINA', ket: 'Segel kardus terbuka', batch: 'B2511', exp: addDaysISO(today, 95), potongStok: false, by: 'Admin Gudang', n: 1 }
  ];
  var batches = [
    { id: uid(), tglMasuk: addDaysISO(today, -90), lok: 'RAK-B2', barcode: '8997236030043', sku: '5000025', nama: 'Scarlett Acne Serum 15ml', batch: 'LOT-24A', exp: addDaysISO(today, -5), qty: 6, status: 'AKTIF', ket: 'Batch lama perlu karantina', by: 'Rina' },
    { id: uid(), tglMasuk: addDaysISO(today, -45), lok: 'RAK-C1', barcode: '8997236031231', sku: '5000054', nama: 'Scarlett Dreamy Body Cream 200ml (V1)', batch: 'LOT-25C', exp: addDaysISO(today, 68), qty: 18, status: 'AKTIF', ket: 'Prioritas keluar FEFO', by: 'Budi' },
    { id: uid(), tglMasuk: addDaysISO(today, -20), lok: 'RAK-B1', barcode: '8997236030036', sku: '5000024', nama: 'Scarlett Brightly Ever After Serum 15ml', batch: 'LOT-25G', exp: addMonthsISO(today, 5), qty: 30, status: 'AKTIF', ket: 'Masuk < 7 bulan', by: 'Budi' },
    { id: uid(), tglMasuk: today, lok: 'RAK-A1', barcode: '8997236030012', sku: '5000011', nama: 'Scarlett Body Lotion Romansa 300ml', batch: 'LOT-26K', exp: addMonthsISO(today, 14), qty: 120, status: 'AKTIF', ket: 'Stok baru', by: 'Admin Gudang' }
  ];
  var yest = addDaysISO(today, -1);
  var twoDaysAgo = addDaysISO(today, -2);
  var cycleCounts = [
    {
      id: 'cc_sample_2',
      tgl: twoDaysAgo,
      judul: 'Cycle Count Harian',
      status: 'SELESAI',
      blindCount: false,
      createdBy: 'Admin Gudang',
      createdAt: twoDaysAgo + 'T08:00:00',
      closedAt: twoDaysAgo + 'T17:15:00',
      items: [
        { id: uid(), sku: '5000011', barcode: '8997236030012', nama: 'Scarlett Body Lotion Romansa 300ml', kategori: 'Body Lotion', assignedTo: 'Budi', stokWms: 120, stokFisik: 120, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Budi', countedAt: '09:40', catatan: 'Rak rapi sesuai' },
        { id: uid(), sku: '5000012', barcode: '8997236030029', nama: 'Scarlett Body Scrub Pomegranate 250ml', kategori: 'Body Scrub', assignedTo: 'Budi', stokWms: 38, stokFisik: 36, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Budi', countedAt: '10:05', catatan: 'Kurang 2 pcs di RAK-A2' },
        { id: uid(), sku: '5000024', barcode: '8997236030036', nama: 'Scarlett Brightly Ever After Serum 15ml', kategori: 'Serum', assignedTo: 'Sari', stokWms: 75, stokFisik: 75, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Sari', countedAt: '10:30', catatan: '' }
      ]
    },
    {
      id: 'cc_sample_1',
      tgl: yest,
      judul: 'Cycle Count Harian',
      status: 'SELESAI',
      blindCount: false,
      createdBy: 'Admin Gudang',
      createdAt: yest + 'T08:00:00',
      closedAt: yest + 'T16:45:00',
      items: [
        { id: uid(), sku: '5000011', barcode: '8997236030012', nama: 'Scarlett Body Lotion Romansa 300ml', kategori: 'Body Lotion', assignedTo: 'Budi', stokWms: 135, stokFisik: 135, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Budi', countedAt: '09:15', catatan: '' },
        { id: uid(), sku: '5000012', barcode: '8997236030029', nama: 'Scarlett Body Scrub Pomegranate 250ml', kategori: 'Body Scrub', assignedTo: 'Budi', stokWms: 38, stokFisik: 37, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Budi', countedAt: '09:32', catatan: 'Ketemu 1 pcs di rak bawah' },
        { id: uid(), sku: '5000025', barcode: '8997236030043', nama: 'Scarlett Acne Serum 15ml', kategori: 'Serum', assignedTo: 'Sari', stokWms: 6, stokFisik: 5, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Sari', countedAt: '10:12', catatan: '1 pcs tester terpisah' },
        { id: uid(), sku: '5000054', barcode: '8997236031231', nama: 'Scarlett Dreamy Body Cream 200ml (V1)', kategori: 'Body Cream', assignedTo: 'Sari', stokWms: 48, stokFisik: 48, selisihSebelumnya: null, status: 'TERVERIFIKASI', countedBy: 'Sari', countedAt: '10:45', catatan: '' }
      ]
    },
    {
      id: 'cc_sample_today',
      tgl: today,
      judul: 'Cycle Count Harian',
      status: 'AKTIF',
      blindCount: false,
      createdBy: 'Admin Gudang',
      createdAt: today + 'T08:00:00',
      closedAt: '',
      items: [
        { id: uid(), sku: '5000011', barcode: '8997236030012', nama: 'Scarlett Body Lotion Romansa 300ml', kategori: 'Body Lotion', assignedTo: 'Budi', stokWms: 135, stokFisik: 135, selisihSebelumnya: null, status: 'TERHITUNG', countedBy: 'Budi', countedAt: '09:10', catatan: 'Sesuai (RAK-A1 + STAGING)' },
        { id: uid(), sku: '5000012', barcode: '8997236030029', nama: 'Scarlett Body Scrub Pomegranate 250ml', kategori: 'Body Scrub', assignedTo: 'Budi', stokWms: 63, stokFisik: 60, selisihSebelumnya: null, status: 'TERHITUNG', countedBy: 'Budi', countedAt: '09:28', catatan: 'Selisih -2 hari ini dari kemarin' },
        { id: uid(), sku: '5000025', barcode: '8997236030043', nama: 'Scarlett Acne Serum 15ml', kategori: 'Serum', assignedTo: 'Sari', stokWms: 6, stokFisik: 6, selisihSebelumnya: null, status: 'TERHITUNG', countedBy: 'Sari', countedAt: '09:45', catatan: 'Sudah dilengkapi kembali' },
        { id: uid(), sku: '5000041', barcode: '8997236030050', nama: 'Scarlett C-Power Toner 100ml', kategori: 'Toner & Essence', assignedTo: 'Budi', stokWms: 3, stokFisik: null, selisihSebelumnya: null, status: 'MENUNGGU', countedBy: '', countedAt: '', catatan: '' },
        { id: uid(), sku: '5000062', barcode: '8997236030067', nama: 'Scarlett Sun Bright Daily Sunscreen 50ml', kategori: 'Sunscreen', assignedTo: 'Sari', stokWms: 9, stokFisik: null, selisihSebelumnya: null, status: 'MENUNGGU', countedBy: '', countedAt: '', catatan: '' }
      ]
    }
  ];
  return {
    master: master,
    lokasi: lokasi,
    opening: opening,
    allstock: opening.map(function (x) { return Object.assign({}, x); }),
    masuk: masuk,
    keluar: keluar,
    pindah: pindah,
    defect: defect,
    batches: batches,
    cycleCounts: cycleCounts,
    inboundRegister: [],
    cutoff: cut,
    min: 10,
    mode: 'mut',
    cover: 7,
    expMonths: 7
  };
}
