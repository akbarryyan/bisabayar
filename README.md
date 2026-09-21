# Whuzpay

Website PPOB dan topup game: checkout tamu, dompet member, katalog merchant.
Next.js 16 (App Router) + MySQL + Prisma.

## Menjalankan

```bash
npm install
cp .env.example .env.local        # isi DATABASE_URL dan SESSION_SECRET
npm run db:migrate:local
npm run db:seed                   # admin: admin@whuzpay.com / admin123
npm run dev
```

`SESSION_SECRET` minimal 32 karakter — server menolak menyala tanpanya.

## Test

```bash
npm run test:db:up                # MySQL sekali pakai lewat Docker
npm run test:db:push
npm test
```

Test-nya integrasi, bukan unit dengan tiruan. Alasannya ada di
[docs/TESTING.md](docs/TESTING.md).

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [WHUZPAY_PROJECT.md](docs/WHUZPAY_PROJECT.md) | Arsitektur sistem sebagaimana adanya |
| [WHUZPAY_CONSTITUTION.md](docs/WHUZPAY_CONSTITUTION.md) | Aturan rekayasa — baca sebelum menyentuh jalur uang |
| [TESTING.md](docs/TESTING.md) | Cara dan alasan pengujian |
| [LOGGING.md](docs/LOGGING.md) | Log terstruktur, rotasi, penelusuran |
| [PROVIDER_SYSTEM.md](docs/PROVIDER_SYSTEM.md) | Digiflazz & VIP Reseller |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build image, deploy, cutover, rollback |

## Catatan penting

**Kredensial dan mode tersimpan di database**, tabel `site_configs`, dan diubah
lewat `/admin/settings`. Nilai di `.env` hanya cadangan ketika kuncinya belum
ada di database — jadi menyunting `.env.production` sering kali tidak berpengaruh.

**Aplikasi berjalan satu proses.** Tidak ada worker terpisah dan tidak ada
Redis. Rekonsiliasi order tersangkut ditangani sapuan berkala di dalam proses
yang sama.

## Deploy

Berjalan di Docker: image dibangun di laptop, di-push ke GHCR, VPS hanya
`docker compose pull` + `up -d`. Langkah lengkap, cutover dari PM2, dan rollback
ada di [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
