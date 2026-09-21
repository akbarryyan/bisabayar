# Desain — Autentikasi & Idempotensi Webhook VIP Reseller

Tanggal: 2026-09-21
Status: disetujui, siap direncanakan

---

## 1. Masalah

[`app/api/webhook/vip/route.ts`](../../../app/api/webhook/vip/route.ts) adalah satu-satunya
jalur uang yang tidak mengikuti aturan di
[WHUZPAY_CONSTITUTION.md](../../WHUZPAY_CONSTITUTION.md). Empat cacat bertumpuk:

**1.1 Signature bisa dilewati sepenuhnya.**

```ts
if (signature && expectedSig && signature !== expectedSig) { ...tolak... }
```

Tanpa header `X-Client-Signature`, cabang ini tidak pernah dievaluasi dan permintaan
lolos. Ini anti-pola yang sama persis dengan yang dilarang konstitusi §4.2 untuk
`view_token`: tidak mengirim apa pun menjadi lebih longgar daripada mengirim nilai salah.

**1.2 Kredensial dibaca dari tempat yang salah.**

Route membaca `process.env.VIP_API_ID` dan `process.env.VIP_API_KEY`, sementara
[`vip.adapter.ts`](../../../src/infra/providers/vip/vip.adapter.ts) membacanya dari
`site_configs`. Konvensi project (konstitusi §5.1) adalah DB menimpa env. Bila kredensial
hanya ada di DB — kondisi normal di produksi — maka `expectedSig` di route ini adalah
md5 dari string kosong, dan pemeriksaan mati total.

**1.3 Tidak ada `WebhookEvent`.**

Poppay mencatat setiap callback untuk idempotensi. VIP tidak mencatat apa pun.
Satu-satunya penjaga adalah `if (order.status === FAILED) return` — pembacaan lalu
pemeriksaan di JavaScript, persis pola yang dilarang konstitusi §2.1.

**1.4 Jalur hilirnya tidak menjaga diri sendiri.**

Komentar pada
[`findOrCreateWebhookEvent`](../../../src/infra/db/repositories/order.repository.ts)
menjelaskan bahwa pemrosesan ulang webhook aman *karena setiap jalur hilir menjaga
idempotensinya sendiri*. Asumsi itu tidak berlaku di sini: `releaseWalletHold` tidak
punya penjaga apa pun — ia hanya `increment` saldo. Bandingkan dengan
`refundPaidOrderToWallet` yang punya. Akibatnya, menambahkan `WebhookEvent` saja
tidak menutup lubangnya.

### Dampak

Handler ini memanggil `updateStatus(SUCCESS)` + `creditSellerCommission()` (uang keluar
ke wallet seller) atau `updateStatus(FAILED)` + `releaseWalletHold()` (saldo kembali ke
pembeli). Dua callback `error` bersamaan atas order yang sama menghasilkan dua ledger
`RELEASE` — saldo bertambah dua kali.

### Yang meringankan

Penyerang membutuhkan `trxid` milik VIP, yang tidak dipublikasikan. Ini bukan lubang
yang bisa dieksploitasi siapa pun tanpa informasi orang dalam. Tetapi pertahanannya
berlapis nol, dan cacat 1.4 bisa terpicu tanpa penyerang sama sekali — cukup dua
kiriman ulang VIP yang beriringan.

---

## 2. Batasan yang menentukan desain

**2.1 Signature VIP statis dan tidak bisa dibuat terikat payload.**

Protokol VIP mendefinisikan header sebagai `md5(API_ID + API_KEY)` — terkonfirmasi di
komentar route dan di `generateSignature()` pada adapter. Nilainya sama untuk setiap
permintaan. Kita tidak mengendalikan sisi pengirim, jadi signature ini **akan tetap
replayable secara desain**. Rencana awal "signature terikat payload" tidak dapat
dilaksanakan dan dicoret.

**2.2 VIP aktif di mode real di produksi.**

Perubahan yang keliru menolak callback sah berdampak pada order nyata.

**2.3 Sapuan rekonsiliasi adalah jaring pengaman.**

`sweepStuckOrders` berjalan tiap 60 detik, menemukan order di `PAID` /
`PROCESSING_PROVIDER`, lalu menanyakan status langsung ke VIP lewat `checkStatus`.
Penolakan yang keliru berarti pemenuhan tertunda ±60 detik, bukan order gagal. Inilah
yang membuat sikap ketat terjangkau meski VIP sedang aktif.

---

## 3. Keputusan

| # | Keputusan | Alasan |
|---|---|---|
| D1 | Signature **wajib** secara default, dapat dimatikan lewat `VIP_WEBHOOK_SIGNATURE_REQUIRED` di `site_configs` | Menutup lubang sekarang, dengan jalan keluar tanpa deploy bila ternyata VIP tidak mengirim header. Meniru `POPPAY_WEBHOOK_SIGNATURE_REQUIRED` yang sudah ada |
| D2 | Signature yang **ada tapi tidak cocok selalu ditolak**, apa pun nilai flag | Tidak ada tafsir yang membenarkan penerimaannya. Di sinilah bug sekarang berada |
| D3 | Kredensial lewat `getSiteConfigValue(key, envFallback)` | Memberi semantik konvensi project secara langsung: DB menimpa, env jadi cadangan |
| D4 | Logika dipindah ke `lib/vip-callback.ts` | Route jadi tipis sesuai konstitusi §1.1, dan skenario konkurensi bisa diuji sebagai fungsi — cara yang sama dipakai test Poppay |
| D5 | Klaim status atomik menggantikan `if (order.status === ...)` | Konstitusi §2.1. Hanya pemenang klaim yang boleh menyentuh uang |
| D6 | `WebhookEvent` dengan `eventId = vip:<trxid>:<status>` | Meniru format Poppay `poppay:<agg_refid>:<status>:<refid>` |
| D7 | **IP allowlist tidak ditegakkan** — tetap log-only | Keputusan pemilik project. Lihat §7 Risiko yang diterima |
| D8 | Pencatatan IP dipindah ke `clientIp()` | Tetap dalam batas log-only, tetapi yang tercatat jadi akurat. `x-forwarded-for` entri pertama bisa dipalsukan klien; `x-real-ip` disetel nginx |

---

## 4. Desain

### 4.1 Berkas

| Berkas | Perubahan |
|---|---|
| `lib/webhook-signature.ts` | **Baru.** `safeEqualHex()`, diangkat dari route Poppay agar dipakai bersama |
| `lib/vip-callback.ts` | **Baru.** `verifyVipWebhookAuth()` dan `handleVipCallback()` |
| `app/api/webhook/vip/route.ts` | Dipangkas jadi parse → verifikasi → delegasi |
| `app/api/webhook/poppay/route.ts` | Hanya mengganti `safeEqualHex` lokal dengan impor. Nol perubahan logika |
| `src/infra/db/repositories/order.repository.ts` | **Tambah** `claimStatusTransition()`. Metode baru; lima pemanggil yang ada tidak tersentuh |
| `tests/vip-webhook-auth.test.ts` | **Baru** |
| `.env.example`, `docs/PROVIDER_SYSTEM.md` | Kunci konfigurasi baru |

### 4.2 Verifikasi

```ts
const [apiId, apiKey, mode] = await Promise.all([
  getSiteConfigValue("VIP_API_ID",  process.env.VIP_API_ID  ?? ""),
  getSiteConfigValue("VIP_API_KEY", process.env.VIP_API_KEY ?? ""),
  getSiteConfigValue("VIP_WEBHOOK_SIGNATURE_REQUIRED", "true"),
]);
```

| Kondisi | `required = true` (default) | `required = false` |
|---|---|---|
| Kredensial kosong | **401** | lolos, `warn` |
| Header tidak ada | **401** | lolos, `warn` |
| Header ada, tidak cocok | **401** | **401** |
| Cocok | lolos | lolos |

Perbandingan memakai `crypto.timingSafeEqual` lewat `safeEqualHex`, sama seperti Poppay.

IP dicatat dengan `clientIp()` dan dibandingkan terhadap `178.248.73.218`; ketidakcocokan
menghasilkan `log.warn` dan **tidak** menolak permintaan.

### 4.3 Alur `handleVipCallback()`

```
1. status waiting / processing      → ok(), tanpa mencatat event
2. findOrCreateWebhookEvent("vip:<trxid>:<status>")
   └─ alreadyProcessed              → ok(), duplikat
3. cari order lewat findByProviderRef(trxid)
   └─ tidak ada                     → ok(), event DIBIARKAN TERBUKA (lihat 4.6)
4. claimStatusTransition(orderId, [PAID, PROCESSING_PROVIDER], SUCCESS | FAILED)
   └─ count === 0                   → pemanggil lain sudah menang.
                                       JANGAN sentuh uang. Lihat 4.5
5. hanya pemenang klaim:
   success → creditSellerCommission + finalizeDebitLedger (bila WALLET)
             + checkAndUpgradeUserTier
   error   → releaseWalletHold (bila WALLET)
6. markWebhookProcessed(eventId), atau dengan pesan error bila langkah 5 melempar
```

Langkah 4 adalah inti perbaikan. Ia menjadikan `releaseWalletHold` yang tidak berpenjaga
tetap aman di jalur ini, karena hanya satu pemanggil yang bisa memenangkan `updateMany`.

### 4.4 `claimStatusTransition()`

```ts
async claimStatusTransition(
  orderId: string,
  from: OrderStatus[],
  to: OrderStatus,
  extra?: { serialNumber?: string; providerRef?: string; notes?: string },
): Promise<boolean> {
  const hasil = await prisma.order.updateMany({
    where: { id: orderId, status: { in: from } },
    data: { status: to, ...(extra yang terisi) },
  });
  return hasil.count > 0;
}
```

Bentuknya sengaja mengikuti `claimForProcessing` yang sudah ada dan sudah terbukti:
`updateMany` dengan syarat status, lalu periksa `count`.

### 4.5 Backfill komisi untuk order yang sudah SUCCESS

Perilaku ini ada di kode sekarang dan dipertahankan. Bila klaim gagal karena order sudah
`SUCCESS` dan callback yang masuk juga `success`, jalankan `creditSellerCommission()`.
Aman diulang: metode itu sudah memakai klaim atomik atas `sellerCommissionCreditedAt`.

### 4.6 Order belum ditemukan bukan "selesai"

Bila `findByProviderRef(trxid)` tidak menemukan apa pun, barisnya `WebhookEvent`
**tidak** ditandai selesai. Penyebab paling mungkin adalah balapan: VIP mengirim callback
sebelum `providerRef` sempat tersimpan di sisi kita. Menandainya selesai akan membuat
kiriman ulang VIP ditolak sebagai duplikat, dan order tertinggal tanpa penyelesai.

Ini penerapan langsung konstitusi §2.1b: yang boleh menghentikan pemrosesan hanyalah
event dengan `processed = true`, dan percobaan yang belum tuntas dibiarkan terbuka.

Test #7 mengunci perilaku ini: callback untuk `trxid` tak dikenal, lalu callback ulang
setelah order ada, harus berhasil diproses.

### 4.7 Semantik respons

Tetap `200` untuk no-op bisnis — trxid tidak dikenal, status interim, duplikat — supaya
VIP tidak mengirim ulang tanpa guna. **Berubah:** kegagalan autentikasi menjadi `401`,
bukan `200` seperti sekarang.

---

## 5. Testing

Konstitusi §13 mewajibkan test yang **gagal pada kode sebelum perbaikan**. Test integrasi
terhadap MySQL sekali pakai, mengikuti pola `tests/webhook-idempotency.test.ts`.

| # | Test | Gagal di kode lama karena |
|---|---|---|
| 1 | Tanpa header signature → ditolak | Sekarang lolos akibat `signature &&` |
| 2 | Header salah → ditolak | Sudah ditolak sekarang; penjaga regresi |
| 3 | Kredensial dibaca dari `site_configs`, bukan env | Sekarang membaca `process.env` |
| 4 | **Dua callback `error` bersamaan → tepat satu ledger `RELEASE`** | Keduanya lolos sekarang; saldo bertambah dua kali |
| 5 | Callback duplikat setelah selesai → tidak diproses ulang | Belum ada `WebhookEvent` |
| 6 | `required = false` + header hilang → lolos | Memastikan jalan keluarnya benar-benar berfungsi |
| 7 | Callback untuk `trxid` tak dikenal, lalu callback ulang setelah order ada → berhasil diproses | Mengunci §4.6; regresi di sini akan menelan kiriman ulang VIP |

Test #4 adalah yang membuktikan lubang uangnya tertutup.

---

## 6. Rollout

1. Deploy dengan `VIP_WEBHOOK_SIGNATURE_REQUIRED` belum ada di `site_configs` → default `"true"`, langsung ketat.
2. Pantau `logs/app.json` untuk `level: warn` dari `provider: vip`.
3. Bila VIP ternyata tidak mengirim header: setel `VIP_WEBHOOK_SIGNATURE_REQUIRED = false` lewat `/admin/settings`. Berlaku tanpa deploy.
4. Selama jendela itu, `sweepStuckOrders` tetap memenuhi order yang callback-nya tertolak.

Rollback: satu kunci `site_configs`, atau `git revert` bila perlu.

---

## 7. Risiko yang diterima

**7.1 Signature tetap replayable.** Konsekuensi langsung dari protokol VIP (§2.1). Sama
untuk setiap permintaan, selamanya, sampai kredensial dirotasi.

**7.2 IP tidak ditegakkan (D7).** Keputusan pemilik project. Konsekuensinya: setelah
perbaikan ini, pertahanan terhadap callback palsu adalah kerahasiaan `trxid` **dan**
kerahasiaan signature statis. Bila signature statis itu bocor — dari log pihak ketiga,
dari riwayat konfigurasi, atau dari sisi VIP — penyerang yang juga mengetahui `trxid`
bisa memalsukan callback, dan kebocorannya bersifat permanen sampai kredensial dirotasi.
Penegakan IP akan menutup ini; kodenya tidak dibangun dalam tugas ini.

Yang **tetap** dilindungi meski 7.1 dan 7.2 terjadi: callback palsu tidak dapat memindahkan
uang lebih dari sekali, karena klaim atomik dan `WebhookEvent`. Kerugian maksimalnya satu
transisi status per order, bukan pengurasan berulang.

**7.3 Jalur `releaseWalletHold` di luar webhook VIP masih tanpa penjaga.** Di
`reconcile-order.service.ts` dan `execute-provider-purchase.service.ts` ia terlindungi
`claimForProcessing`. Memberi penjaga pada metodenya sendiri adalah tugas terpisah.

---

## 8. Di luar ruang lingkup

- Penjaga idempotensi di dalam `releaseWalletHold` (tugas terpisah)
- `updateStatus()` bersyarat status untuk seluruh pemanggil (tugas terpisah)
- Penegakan signature Poppay — `invalid` di sana masih hanya dicatat
- Penegakan IP allowlist (D7)
