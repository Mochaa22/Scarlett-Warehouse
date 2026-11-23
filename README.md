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
   - `APP_LOGIN_EMAIL` = email login aplikasi Anda (mis. `scarlett@gmail.com`)
   - `APP_LOGIN_PASSWORD` = password login aplikasi Anda
   - `ADMIN_BACKUP_PIN` = PIN untuk membuka mode **Admin** (minimal 4 karakter)
   - `SUPER_ADMIN_BACKUP_PIN` = PIN untuk membuka mode **Super Admin** (minimal 4 karakter, harus berbeda dari PIN Admin)
   - `PIN_SESSION_SECRET` = string acak panjang minimal 16 karakter agar token sesi tetap valid di semua instance serverless Vercel
4. **Deploy / Redeploy**: Klik **Deploy** (atau **Redeploy** setelah mengisi Environment Variables), dan aplikasi siap langsung dipakai pada URL `.vercel.app` Anda.
