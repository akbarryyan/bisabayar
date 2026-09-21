# Logging

Semua log aplikasi ditulis sebagai satu baris JSON (NDJSON) ke `logs/app.json`.

```json
{
  "level": "info",
  "time": "2026-08-31T09:29:35.738+07:00",
  "app": "whuzpay",
  "env": "production",
  "pid": 2084836,
  "subsystem": "http",
  "requestId": "c54dc99b-…",
  "route": "/api/auth/me",
  "method": "GET",
  "userId": "cmsso8ccx…",
  "path": "/api/auth/me",
  "status": 200,
  "durationMs": 15,
  "msg": "access"
}
```

## Rotasi

File dirotasi saat menyentuh `LOG_MAX_SIZE` (default `10M`):

```
logs/
  app.json          ← sedang ditulis
  app.1.json.gz     ← arsip TERBARU
  app.2.json.gz
  …
  app.10.json.gz    ← paling lama; yang melewati ini dibuang
```

Nomor kecil = lebih baru. Tiap rotasi menggeser semua arsip satu nomor (mode
classical rotating-file-stream, ala logrotate).

Aplikasi berjalan sebagai SATU proses, jadi seluruh log masuk ke
`logs/app.json`. Pekerjaan latar — sapuan rekonsiliasi — berjalan di dalam
proses yang sama dan memakai correlation id sendiri per sapuan, sehingga tetap
bisa dirunut meski tidak berasal dari request HTTP.

Kalau suatu saat ada proses kedua, ia **wajib** menulis berkas berbeda:
rotating-file-stream melacak ukuran berkas per proses dan akan me-rename berkas
aktif di bawah kaki proses lain.

## Membaca log

```bash
npm run logs:tail      # logs/app.json, di-pretty-print
npm run logs:errors    # hanya level error & fatal

# runut satu request dari access log sampai log aplikasinya
grep '"requestId":"c54dc99b-4b57-42dd-9217-71528759c48e"' logs/app.json | npx pino-pretty -t "SYS:standard"
```

## Menulis log

```ts
import { getLogger } from "@/lib/logger";

const log = getLogger("webhook"); // satu binding per file, selalu bernama `log`

log.info({ orderId, amount }, "order paid");
log.error({ err, orderId }, "provider execute failed");
```

### Aturan

**Objek dulu, pesan belakangan.** Kebalikannya (`log.error("msg", { err })`)
adalah kesalahan mekanis paling sering — untungnya ditangkap `tsc --noEmit`.

**`msg` wajib string konstan.** Tanpa interpolasi, tanpa concat. Semua nilai
masuk sebagai field, supaya `msg` bisa dipakai sebagai kunci pengelompokan.

```ts
log.info(`Order ${orderId} SUCCESS`); // ❌
log.info({ orderId }, "order success"); // ✅
```

**Error selalu di key `err`.** Itu yang di-serialize pino (message + stack +
type). Kirim objek Error-nya utuh, bukan `.message` saja.

```ts
} catch (error) {
  log.error({ err: error, orderId }, "checkout failed");  // ✅
}
```

**Jangan tulis ulang method/path/requestId.** Access log sudah membawanya.
Tag lama seperti `[GET /api/admin/promos]` dibuang, bukan dipindah ke `msg`.

**Tag domain jadi `subsystem`,** bukan bagian dari pesan: `[Webhook/VIP]` →
`getLogger("webhook")` + field `provider: "vip"`.

### Level

|         |                                                                                               |
| ------- | --------------------------------------------------------------------------------------------- |
| `debug` | diagnostik, dump payload, guard yang di-skip, progres internal                                |
| `info`  | perubahan state bisnis: order dibayar, saldo bertambah, tier naik                             |
| `warn`  | kondisi tidak normal yang tertangani: config kosong, payload tak lengkap, record tidak ketemu |
| `error` | exception nyata; alur gagal                                                                   |
| `fatal` | proses tidak bisa lanjut                                                                      |

Default `LOG_LEVEL`: `info` di produksi, `debug` di development.

### Subsystem

Daftar tertutup — TypeScript menolak nilai lain. Ini yang menjaga nama tetap
konsisten di ratusan call site.

| path                                                                                                | subsystem                           |
| --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `app/api/auth/**`                                                                                   | `auth`                              |
| `app/api/webhook{,s}/**`                                                                            | `webhook` (+ field `provider`)      |
| `app/api/admin/**`                                                                                  | `admin`                             |
| `app/api/{orders,checkout,transaksi}/**`, `src/core/services/checkout/**`                           | `order`                             |
| `app/api/wallet/**`                                                                                 | `wallet`                            |
| `app/api/{catalog,promos,vouchers,page-content,footer-config,payment-methods}/**`, `lib/pricing.ts` | `catalog`                           |
| `app/api/{seller,merchant}/**`                                                                      | `seller`                            |
| `src/core/services/provider/**`, `src/infra/providers/**`                                           | `provider` (+ field `providerType`) |
| `src/core/services/payment/**`, `src/infra/payment/**`, `lib/poppay-callback.ts`                    | `payment`                           |
| `src/infra/db/**`                                                                                   | `db`                                |
| `lib/mailer.ts`, `lib/fonnte.ts`                                                                    | `notify`                            |
| `app/api/{upload,analytics,dev}/**`                                                                 | `http`                              |

`http` selebihnya milik access log, supaya log request gampang dipisah dari log aplikasi.

### Nama field

camelCase dan konsisten: `orderId`, `orderCode`, `userId`, `topupId`,
`topupCode`, `invoiceId`, `providerRef`, `providerType`, `trxid`, `jobId`,
`jobName`, `amount`, `eventId`, `clientIp`.

Jangan pakai nama `error`, `msg`, `level`, `time`, `pid`, `app`, `env`,
`subsystem`, `requestId` — bentrok dengan field pino.

## Yang tidak boleh di-log

Jangan pernah melempar `process.env`, body request mentah, atau response
provider mentah ke logger.

`redact` pino menyensor `password`, `passwordHash`, `otp`, `pin`, `token`,
`apiKey`, `secret`, `signature`, `sign`, `authorization`, `cookie` — tapi
**hanya sampai satu tingkat nesting**. Untuk payload yang kedalamannya tidak
diketahui, sensor dulu:

```ts
import { redactDeep } from "@/lib/logger";
log.debug({ payload: redactDeep(providerResponse) }, "provider raw response");
```

Access log sengaja mencatat `path` **tanpa query string**, karena query dari
callback provider bisa membawa token.

## Pengecualian `console.*`

`no-console` aktif sebagai error di `app/`, `lib/`, `src/`, `components/`,
`hooks/`, dan `middleware.ts`. Yang dikecualikan, dengan alasannya:

|                                                        |                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/seed-*.ts`                                     | CLI seeder, jalan di luar Next; outputnya untuk dibaca operator di terminal, dan `seed-admin.ts` mencetak password — tidak boleh masuk file log |
| `app/admin/{products,providers,transactions}/page.tsx` | `"use client"` — pino butuh `node:fs`, mengimpornya merusak build browser                                                                       |
| `lib/logger.ts`, `instrumentation.ts`                  | fallback ke stderr saat logger sendiri gagal                                                                                                    |

Jangan menambah pengecualian tanpa alasan sekelas ini.

`middleware.ts` jalan di Edge runtime dan **tidak boleh** mengimpor
`@/lib/logger`. Request yang di-redirect middleware tetap tercatat access log
lengkap dengan status dan durasinya.

Sebelum menambahkan `getLogger` ke file `lib/**` mana pun, pastikan file itu
tidak di-import dari komponen `"use client"`:

```bash
for f in $(grep -rl '"use client"' --include='*.tsx' app components hooks); do
  grep -o 'from "@/lib/[^"]*"' "$f"
done | sort -u
```

`npm run build` adalah jaring pengaman terakhir — pino yang bocor ke client
chunk menggagalkan build dengan keras.

## Environment

|                     | default                   | catatan                                                                       |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `TZ`                | _(OS)_                    | **wajib `Asia/Jakarta` di VPS** — kalau tidak, offset di `time` jadi `+00:00` |
| `LOG_LEVEL`         | `info` prod / `debug` dev |                                                                               |
| `LOG_DIR`           | `./logs`                  | di PM2/systemd sebaiknya path absolut, cwd bisa berbeda                       |
| `LOG_FILE`          | `app.json`                | satu proses, satu berkas                                                      |
| `LOG_MAX_SIZE`      | `10M`                     | ambang rotasi                                                                 |
| `LOG_MAX_FILES`     | `10`                      | jumlah arsip `.gz` yang disimpan                                              |
| `LOG_APP_NAME`      | `whuzpay`                 | isi field `app`                                                               |
| `LOG_TO_FILE`       | `true`                    |                                                                               |
| `LOG_TO_STDOUT`     | `false` prod / `true` dev |                                                                               |
| `LOG_PRETTY`        | `true` (dev saja)         | butuh `pino-pretty`                                                           |
| `LOG_HTTP_PAGES`    | `true`                    | `false` → hanya `/api/*` yang dicatat                                         |
| `LOG_HTTP_PREFETCH` | `false`                   | `true` → ikut mencatat RSC prefetch                                           |

Kalau `logs/` tidak bisa ditulis (read-only, EACCES), logger menulis peringatan
ke stderr lalu jatuh ke stdout — aplikasi tetap jalan.

Ada reverse proxy di depan? Teruskan request id supaya bisa dikorelasi dengan
log nginx:

```nginx
proxy_set_header X-Request-Id $request_id;
```

## Deployment dengan PM2

[`ecosystem.config.js`](../ecosystem.config.js) sudah menyetel `TZ`, `LOG_DIR`
absolut.

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 restart ecosystem.config.js --update-env   # setelah mengubah blok env
```

Variabel logging untuk pengguna PM2 diletakkan di `ecosystem.config.js`, bukan
Verifikasi setelah deploy — baris pertama adalah `server-start` dan memuat
field `tz`:

```bash
head -1 /var/www/whuz-app-2/logs/app.json
```

### `pm2 logs` akan sepi

`LOG_TO_STDOUT` default `false` di produksi, jadi output aplikasi hanya masuk
file. Set `LOG_TO_STDOUT: "true"` di `ecosystem.config.js` kalau Anda ingin log
tetap muncul di `pm2 logs` — akan tertulis di kedua tempat.

### Cluster mode

Beberapa instance PM2 **tidak boleh** menulis file log yang sama. Logger
menanganinya otomatis: PM2 menyetel `NODE_APP_INSTANCE`, dan instance 1 ke atas
mendapat nama file sendiri.

```
instances: 1 (fork)   → logs/app.json
instances: 4 (cluster) → logs/app.json, app-1.json, app-2.json, app-3.json
```

Masing-masing dirotasi sendiri. Untuk membaca semuanya sekaligus:

```bash
cat /var/www/whuz-app-2/logs/app*.json | grep '"level":"error"'
```

### `npm run logs:*` butuh devDependencies

Script `logs:tail` / `logs:errors` memipe ke `pino-pretty`, yang ada di
`devDependencies`. Kalau deploy Anda memakai `npm ci --omit=dev`, paket itu
tidak terpasang dan script-nya gagal — pakai `tail`/`grep` biasa.
