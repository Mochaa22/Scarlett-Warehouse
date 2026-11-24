# Scarlett GP1 WMS

Sistem manajemen gudang (Barang Masuk, Antrean Surat Jalan / Inbound Matching, Barang Keluar, Perpindahan, Stok Aktif, Cycle Count, Defect, dan Monitor Expire) berbasis web.

## Alur Login & Hak Akses

- **Login Utama**: Menggunakan email dan password (`APP_LOGIN_EMAIL` & `APP_LOGIN_PASSWORD` atau setup awal di layar login).
- **Role Default**: Setelah berhasil masuk, sesi otomatis aktif sebagai **Stockkeeper** (menu operasional lapangan).
- **Akses Admin & Super Admin**: Klik tombol role **Stockkeeper** (atau **Role** di seluler), lalu masukkan PIN yang sesuai (`ADMIN_BACKUP_PIN` / `SUPER_ADMIN_BACKUP_PIN`).

## Jalankan secara Lokal

Siapkan Node.js 22+, salin `.env.example` ke `.env`, lalu jalankan:

```sh
npm ci
npm run dev
```

Buka `http://localhost:3000`. Untuk build produksi lokal:

```sh
npm run build
NODE_ENV=production npm start
```

## Deploy ke GitHub & Vercel

1. **Upload ke GitHub**: Push seluruh isi proyek ini ke repository GitHub Anda (`main` branch).
2. **Import di Vercel**:
   - Buka [Vercel Dashboard](https://vercel.com/new) → **Import Git Repository** → pilih repository GitHub Anda.
   - Framework Preset otomatis terdeteksi **Vite** (`buildCommand: npm run build`, `outputDirectory: dist`, konfigurasi route sudah tersedia di `vercel.json` dan `/api/index.ts`).
3. **Isi Environment Variables di Vercel** (*Settings → Environment Variables*):
   - `APP_LOGIN_EMAIL` = email login utama aplikasi Anda (mis. `scarlett@gmail.com`)
   - `APP_LOGIN_PASSWORD` = password login utama aplikasi Anda
   - `APP_USERS_JSON` = *(opsional)* daftar akun operator tambahan format JSON, atau kelola langsung lewat menu **Pengaturan & Master → Akun Operator** setelah login Super Admin
   - `ADMIN_BACKUP_PIN` = PIN untuk membuka mode **Admin** (minimal 4 karakter)
   - `SUPER_ADMIN_BACKUP_PIN` = PIN untuk membuka mode **Super Admin** (minimal 4 karakter, harus berbeda dari PIN Admin)
   - `PIN_SESSION_SECRET` = **wajib di Vercel** — string acak panjang minimal 16 karakter agar token sesi login tetap valid di semua perangkat & instance serverless
4. **Aktifkan Storage Persisten (Wajib di Vercel untuk Sinkronisasi Multi-User / Multi-Device)**:
   - Di Vercel Dashboard proyek Anda → tab **Storage** → buat / hubungkan **Upstash Redis** (atau **Vercel KV**).
   - Vercel otomatis mengisi `KV_REST_API_URL` & `KV_REST_API_TOKEN` (atau `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`), sehingga seluruh akun operator dan transaksi gudang tersinkron otomatis lintas perangkat & antar user setiap beberapa detik.
5. **Deploy / Redeploy**: Klik **Deploy** (atau **Redeploy** setelah mengisi Environment Variables / Storage), dan aplikasi siap langsung dipakai pada URL `.vercel.app` Anda.
