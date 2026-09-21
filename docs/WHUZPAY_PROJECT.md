# Whuzpay — Arsitektur Sistem

Website PPOB dan topup game dengan checkout tamu dan dompet member.

> Dokumen ini menggambarkan sistem **sebagaimana adanya**. Versi sebelumnya
> adalah rencana yang ditulis sebelum implementasi, dan sudah menyimpang jauh —
> ia masih menyebut Pakasir sebagai payment gateway dan BullMQ sebagai jalur
> eksekusi provider, padahal keduanya sudah tidak ada.
>
> Aturan rekayasanya ada di [WHUZPAY_CONSTITUTION.md](WHUZPAY_CONSTITUTION.md).

---

## 1) Tech stack

| Lapis | Yang dipakai |
|---|---|
| Aplikasi | Next.js 16 (App Router), TypeScript, React 19 |
| Database | MySQL 8.4 + Prisma |
| Sesi | iron-session (cookie tersegel) |
| Payment gateway | **Poppay** — satu-satunya |
| Provider PPOB | Digiflazz, VIP Reseller |
| Notifikasi | SMTP (nodemailer), WhatsApp (Fonnte) |
| Log | pino + rotating-file-stream |
| Test | Vitest, integrasi terhadap MySQL sekali pakai |

Berjalan sebagai **satu proses** (PM2 `exec_mode: fork`, `instances: 1`). Tidak
ada worker terpisah dan tidak ada Redis.

---

## 2) Alur transaksi

### Payment gateway (tamu maupun member)

```text
pilih produk → input target → checkout
→ POST /api/checkout membuat order + invoice Poppay
→ pelanggan membayar
→ Poppay memanggil /api/webhook/poppay
→ cross-check inquireIncoming ke Poppay
→ order PAID → eksekusi provider INLINE
→ SUCCESS / FAILED / PROCESSING_PROVIDER
```

### Wallet (member)

```text
checkout → HOLD saldo (atomik) → order PAID
→ eksekusi provider INLINE
→ SUCCESS: catat DEBIT   |   FAILED: RELEASE saldo
```

### Kalau ada yang tersangkut

Eksekusi provider berjalan inline, jadi tidak ada retry berlapis seperti queue.
Jaring pengamannya dua:

1. **Kiriman ulang gateway.** `WebhookEvent` hanya dianggap selesai bila
   pemrosesannya benar-benar berhasil; percobaan yang gagal dibiarkan terbuka.
2. **Sapuan berkala.** `sweepStuckOrders` menanyakan ulang ke database order
   mana yang tersangkut di `PAID` / `PROCESSING_PROVIDER`, lalu merekonsiliasi.
   Jadwalnya tidak disimpan di mana pun, sehingga restart tidak menghilangkan
   apa pun.

---

## 3) Struktur kode

```
app/
  api/            route handler — parse, validasi, panggil service
  admin/          dasbor admin (client-side)
  (halaman publik, akun, merchant)

src/
  core/
    domain/       enum & error
    ports/        payment-gateway.port.ts, provider.port.ts
    services/     seluruh logika bisnis
  infra/
    db/           prisma + repository
    payment/      poppay (client + adapter)
    providers/    digiflazz, vip, mock, factory

lib/              sesi, guard admin, rate limit, logger, konfigurasi situs
tests/            test integrasi (butuh MySQL uji)
```

Yang perlu diketahui: **tidak ada `src/infra/queue`** dan tidak ada
`queue.port.ts` — keduanya dihapus bersama BullMQ.

---

## 4) Endpoint inti

| Endpoint | Catatan |
|---|---|
| `POST /api/checkout` | Membuat order. Voucher diresolusi & diklaim di dalam service |
| `GET /api/orders/[code]` | Publik. Isi respons dibatasi bila tanpa kredensial |
| `POST /api/webhook/poppay` | Uang masuk & keluar. Satu-satunya callback gateway |
| `POST /api/webhook/vip` | Callback status provider VIP |
| `GET /api/wallet`, `/api/wallet/topup` | Dompet member |
| `app/api/admin/**` | Seluruhnya ter-guard `requireAdmin*` |

---

## 5) Status & kosakata ledger

**Order:** `CREATED` → `WAITING_PAYMENT` → `PAID` → `PROCESSING_PROVIDER` →
`SUCCESS`, dengan cabang `EXPIRED`, `FAILED`, dan `REFUNDED`.

**LedgerEntry** — sembilan tipe:

| Tipe | Arti | Menggeser saldo? |
|---|---|---|
| `HOLD` | Saldo ditahan saat checkout wallet | ya, mengurangi |
| `DEBIT` | Finalisasi setelah provider sukses | tidak — sudah dipotong `HOLD` |
| `RELEASE` | Pelepasan `HOLD` saat gagal | ya, menambah |
| `REFUND` | Pengembalian order gateway yang gagal | ya, menambah |
| `CREDIT` | Topup saldo | ya, menambah |
| `COMMISSION` | Komisi seller | ya, menambah |
| `WITHDRAW_HOLD` | Penarikan diajukan | ya, mengurangi |
| `WITHDRAW_PAID` | Penarikan tuntas | tidak — pencatatan |
| `WITHDRAW_RELEASE` | Penarikan gagal, saldo kembali | ya, menambah |

Karena `DEBIT` dan `WITHDRAW_PAID` tidak menggeser saldo, saldo diturunkan dari
`-HOLD -WITHDRAW_HOLD +RELEASE +WITHDRAW_RELEASE +REFUND +CREDIT +COMMISSION`.
Ini penting saat merekonsiliasi ledger dengan `Wallet.balance`.

---

## 6) Konfigurasi

Lihat [`.env.example`](../.env.example) untuk daftar lengkap beserta
penjelasannya.

Satu hal yang sering membingungkan: **kredensial dan mode tersimpan di tabel
`site_configs`, bukan di berkas env.** Nilai di database MENIMPA env; env hanya
cadangan ketika kuncinya belum ada. Artinya rotasi kredensial produksi
dilakukan lewat `/admin/settings`, bukan dengan menyunting `.env.production`.

`SESSION_SECRET` dan `DATABASE_URL` divalidasi saat boot — server menolak
menyala bila salah.

---

## 7) Menjalankan

```bash
npm install
npm run db:migrate:local     # terapkan migrasi ke DB dev
npm run db:seed              # data awal (admin: admin@whuzpay.com / admin123)
npm run dev

npm run test:db:up           # MySQL uji sekali pakai
npm run test:db:push
npm test
```

Detail pengujian: [TESTING.md](TESTING.md). Logging: [LOGGING.md](LOGGING.md).

---

## 8) Yang masih menjadi pekerjaan

- **Verifikasi tanda tangan callback Poppay** belum ditegakkan — verdict
  `invalid` baru dicatat, belum menolak. Perlu kepastian format dari Poppay.
- **Belum ada endpoint inquiry untuk transaksi keluar**, sehingga callback
  penarikan bergantung pada kerahasiaan `refid`, bukan tanda tangan.
- **Voucher pada order gateway** diklaim saat order dibuat, bukan saat dibayar.
  Order yang tidak pernah dibayar tetap memakan kuota sampai dilepas manual.
- **Belum ada dokumen integrasi Poppay.** Pemetaan kode status 1–5 hanya ada di
  `lib/poppay-callback.ts`.
- **Cakupan test** masih terbatas pada jalur uang dan pembatas laju.
- **`GET /api/vouchers/validate`** menghitung diskon dari `amount` yang dikirim
  klien, sehingga pratinjaunya bisa berbeda dari yang benar-benar diterapkan.
- **IP allowlist webhook VIP belum ditegakkan.** IP dicatat tetapi tidak menolak.
  Karena signature VIP statis dan replayable, penegakan IP adalah lapis berikutnya
  yang paling bernilai. Lihat §7.2 pada
  `docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md`.
- **`releaseWalletHold` belum punya penjaga idempotensi sendiri.** Di jalur webhook
  VIP, reconcile, dan eksekusi provider ia terlindungi klaim atomik pemanggilnya.
  Memberi penjaga pada metodenya sendiri akan melindungi pemanggil berikutnya yang
  lupa melakukannya.
