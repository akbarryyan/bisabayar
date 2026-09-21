# Desain — Migrasi Deployment ke Docker + GHCR

Tanggal: 2026-09-21
Status: disetujui, siap direncanakan

---

## 1. Tujuan

Memindahkan deployment bisabayar dari PM2 native di VPS ke Docker, mengikuti pola yang
sudah berjalan di project transaksikilat: image dibangun **di luar VPS**, di-push ke
GitHub Container Registry, dan VPS hanya `docker compose pull` + `up -d`. VPS tidak
pernah menjalankan `docker build`.

Berbeda dari transaksikilat, **MySQL ikut dikontainerkan** di sini.

## 2. Keadaan sekarang

| Lapis | Sekarang |
|---|---|
| Aplikasi | PM2 `exec_mode: fork`, `instances: 1`, `next start` dari `/var/www/whuz-app-2` |
| Database | MySQL di host VPS |
| Upload | `public/uploads/` di disk host |
| Log | `logs/app.json`, dirotasi by-size oleh aplikasi sendiri |
| CI | tidak ada |

Tidak ada `Dockerfile`, `docker-compose.yml`, maupun `.dockerignore` di repo.

## 3. Batasan yang menentukan desain

**3.1 Satu VPS dipakai bersama transaksikilat, dan pernah penuh.**
Insiden 2026-09-20: disk 40G penuh 100%, MySQL mati dengan `Error: 28 (No space left
on device)`, produksi mati ±1,5 hari. Penyebabnya 22 image Docker menumpuk (~24GB) plus
3.3GB build cache. Menambahkan container MySQL beserta datanya ke disk yang sama menuntut
anggaran disk yang eksplisit sejak awal, bukan sesudah kejadian.

**3.2 Aplikasi harus tetap satu instance.**
Pembatas laju disimpan in-memory dan sapuan rekonsiliasi berjalan di dalam proses. Dua
replika berarti batas laju dua kali lipat dan dua sapuan menembak provider yang sama.
`deploy.replicas` tidak boleh dinaikkan.

**3.3 GitHub Actions belum bisa dipakai.**
Akun terkunci karena billing. Workflow tetap ditulis tetapi dorman; jalur aktifnya build
manual dari laptop.

**3.4 Tiga hal menulis ke disk saat runtime.**
`public/uploads/` (unggahan pengguna), `LOG_DIR` (log terotasi), dan data MySQL. Ketiganya
butuh volume, kalau tidak hilang setiap container dibuat ulang.

**3.5 `SESSION_SECRET` dan `DATABASE_URL` divalidasi saat boot.**
`instrumentation.ts` melempar bila salah satu kosong atau `SESSION_SECRET` kurang dari 32
karakter. Container akan gagal start, bukan menyala setengah jalan. Ini perilaku yang
diinginkan dan harus dipertahankan.

---

## 4. Keputusan

| # | Keputusan | Alasan |
|---|---|---|
| D1 | MySQL ikut jadi service di compose | Keputusan pemilik project |
| D2 | Data MySQL **bind mount** ke `/var/www/bisabayar/mysql-data` | Terlihat langsung di host — bisa diukur `du`, di-backup, dan disalin tanpa menyentuh Docker. Named volume tersembunyi di `/var/lib/docker/volumes` dan mudah terlupakan saat menghitung disk (lihat 3.1) |
| D3 | Direktori baru `/var/www/bisabayar` | `/var/www/whuz-app-2` dibiarkan utuh sebagai jaring pengaman. Rollback = hidupkan PM2 lagi |
| D4 | Port host **3004** | transaksikilat memakai 3003 di VPS yang sama. Port baru berarti PM2 lama dan container bisa hidup berdampingan saat smoke test |
| D5 | `output: "standalone"` di `next.config.ts` | Image jauh lebih ramping — penting karena 3.1 |
| D6 | **Tanpa build arg** | Lihat §6.3 |
| D7 | **Tanpa endpoint cron** | Lihat §6.1 |
| D8 | **Tanpa logrotate** | Lihat §6.2 |
| D9 | `npm run verify` = typecheck + test, **tanpa lint** | Lint saat ini 51 error. Gate yang selalu merah akan selalu dilewati, dan gate yang selalu dilewati sama dengan tidak ada gate. Lint masuk setelah error itu dibereskan sebagai tugas terpisah |
| D10 | Cutover memakai `pm2 stop`, bukan mode maintenance | Lihat §8 |

---

## 5. Arsitektur

```
laptop  --build & push-->  ghcr.io/akbarryyan/bisabayar:latest
                                     :<git-sha>
                                        |
VPS /var/www/bisabayar  --compose pull & up -d-->
    bisabayar-app     127.0.0.1:3004 → 3000 (internal)
    bisabayar-mysql   ./mysql-data:/var/lib/mysql
```

Registry `ghcr.io/akbarryyan/bisabayar` (private). nginx host mem-proxy ke `127.0.0.1:3004`.

### 5.1 Berkas yang dibuat atau diubah

| Berkas | Perubahan |
|---|---|
| `Dockerfile` | **Baru.** Multi-stage, `node:22-alpine` |
| `.dockerignore` | **Baru.** Wajib — tanpa ini `node_modules`, `.next`, `logs/`, `public/uploads` ikut terkirim ke daemon |
| `docker-compose.yml` | **Baru.** Dua service, batas log, volume |
| `next.config.ts` | Tambah `output: "standalone"` |
| `package.json` | Tambah script `verify` |
| `.github/workflows/build-and-push.yml` | **Baru**, dorman sampai akun pulih |
| `docs/DEPLOYMENT.md` | **Ditulis ulang.** Yang ada sekarang masih dokumen transaksikilat apa adanya dan belum pernah di-commit |
| `.env.example` | Tambah `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` — dibaca service MySQL saat inisialisasi pertama |

### 5.2 Volume

| Host | Container | Isi |
|---|---|---|
| `./mysql-data` | `/var/lib/mysql` | Data MySQL |
| `./uploads` | `/app/public/uploads` | Unggahan pengguna |
| `./logs` | `/app/logs` | `app.json` dan arsip rotasinya |

`lib/upload.ts` menulis ke `path.join(process.cwd(), "public", "uploads", folder)`. Dengan
`output: standalone` cwd container adalah `/app`, jadi titik mount-nya `/app/public/uploads`.

### 5.3 Konfigurasi

Seluruh variabel runtime dibaca dari `/var/www/bisabayar/.env` lewat `env_file` di compose.
Aplikasi membaca 49 variabel runtime; yang wajib ada minimal `DATABASE_URL`,
`SESSION_SECRET`, dan `APP_URL`.

`DATABASE_URL` menunjuk service MySQL di jaringan compose, bukan `127.0.0.1`:

```
DATABASE_URL="mysql://bisabayar:<password>@bisabayar-mysql:3306/bisabayar"
```

`LOG_DIR=/app/logs` dan `TZ=Asia/Jakarta` diset di compose, bukan di `.env` — keduanya
sifatnya struktural, bukan rahasia.

Kredensial provider dan gateway **tidak** dipindah ke `.env`: keduanya sudah tersimpan di
tabel `site_configs` dan nilai di sana menimpa env.

### 5.4 Migration database saat deploy

Rilis biasa cukup `pull` lalu `up -d`. Rilis yang **mengandung migration** menyisipkan satu
langkah di antaranya:

```bash
docker compose pull
docker compose run --rm bisabayar-app npx prisma migrate deploy
docker compose up -d
```

Urutannya tidak boleh dibalik. Migration dijalankan memakai image baru selagi container
lama masih melayani trafik, sehingga tidak ada jeda mati. Kalau `up -d` lebih dulu,
container baru naik sebelum tabelnya ada dan setiap request yang menyentuhnya gagal.

Memeriksa apakah sebuah rilis mengandung migration:

```bash
git diff --name-only <sha-terakhir-dideploy>..HEAD -- prisma/migrations
```

Ini menuntut `prisma` dan `prisma/migrations/` ikut masuk ke image — `output: standalone`
tidak menyertakannya sendiri, jadi keduanya disalin eksplisit di `Dockerfile`.

### 5.5 Rollback rilis

Image di-tag dua kali: `:latest` dan `:<git-sha>`. Rollback dilakukan dengan mengganti tag
di `docker-compose.yml` ke sha yang dituju, lalu `pull` + `up -d`.

Perlu diketahui: rollback berbasis sha baru berguna kalau sha-nya pernah di-push. Build
manual dari laptop **wajib** menandai keduanya, bukan hanya `:latest` — kalau hanya
`:latest`, tidak ada yang bisa dituju saat rollback. Di transaksikilat langkah build
manualnya hanya menandai `:latest`, dan itu kekurangan yang tidak perlu ditiru.

Rollback yang mengembalikan migration tidak ditangani di sini: Prisma tidak punya
`migrate down`. Rilis yang mengandung migration merusak harus diperbaiki maju dengan
migration baru.

---

## 6. Yang sengaja berbeda dari transaksikilat

Menyalin `docs/DEPLOYMENT.md` transaksikilat apa adanya akan merusak tiga keputusan desain
bisabayar.

### 6.1 Tanpa endpoint cron rekonsiliasi

transaksikilat menjadwalkan `POST /api/cron/reconcile-orders` lewat crontab tiap 5 menit,
karena retry-nya bersandar pada timer di memori yang hilang setiap container dibuat ulang.

bisabayar sudah menyelesaikan masalah itu dengan cara lain. `sweepStuckOrders`
menanyakan ulang ke database order mana yang tersangkut di `PAID`/`PROCESSING_PROVIDER`,
sehingga keadaan selalu diturunkan dari data, bukan dari memori — container dibuat ulang
tidak menghilangkan apa pun. Endpoint `/api/cron/*` tidak ada di bisabayar dan tidak perlu
dibuat.

**Sapuan in-process dipertahankan. Tidak ada crontab untuk rekonsiliasi.**

### 6.2 Tanpa logrotate

transaksikilat menulis `app.log` polos dan menyerahkan rotasi ke logrotate host dengan
`copytruncate`.

bisabayar memakai pino dengan `rotating-file-stream` dan merotasi sendiri saat berkas
menyentuh `LOG_MAX_SIZE` (bawaan 10M), lengkap dengan kompresi gzip dan retensi. Memasang
logrotate di atasnya justru menimbulkan dua perotasi yang saling berebut berkas yang sama.

**Yang dibutuhkan hanya volume untuk `LOG_DIR`.**

### 6.3 Tanpa build arg

transaksikilat mengirim empat `NEXT_PUBLIC_*` sebagai `--build-arg`, dan karenanya harus
membangun ulang image setiap kali salah satu nilainya berubah.

Di bisabayar ketiga `NEXT_PUBLIC_*` (`APP_URL`, `BASE_URL`, `APP_NAME`) **hanya dipakai di
kode server** — tidak satu pun di komponen klien. Dan kedua tempat yang membangun callback
URL Poppay punya rantai fallback:

```ts
process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL
```

Bila `NEXT_PUBLIC_*` dibiarkan kosong saat build, Next meng-inline-nya sebagai `undefined`
dan rantai itu jatuh ke `APP_URL` yang dibaca saat runtime. `NEXT_PUBLIC_APP_NAME` hanya
cadangan terakhir setelah `site_configs`, yang di produksi selalu terisi.

**Konsekuensinya: ganti domain cukup ubah `.env` lalu `docker compose up -d`. Tidak perlu
build ulang.**

---

## 7. Anggaran disk

Wajib, karena 3.1.

Yang bertambah di disk yang sudah dipakai transaksikilat:

- image aplikasi bisabayar
- image MySQL (~600MB) — transaksikilat tidak punya karena MySQL-nya di host
- `mysql-data/` seukuran database sekarang
- `uploads/` — dipindah, bukan ditambah, tetapi selama transisi ada **dua** salinan
- berkas dump, **sementara**, ±2× ukuran database

Pengamannya:

1. `df -h /` diperiksa **sebelum** mulai. Batalkan bila pemakaian sudah di atas 70%.
2. `logging: max-size 10m, max-file 3` untuk **kedua** service sejak compose pertama.
   Tanpa ini driver `json-file` menulis stdout tanpa batas.
3. `docker image prune -af` menjadi bagian tetap langkah deploy.
4. Backup dibatasi retensi 7 hari.
5. `/var/www/whuz-app-2` baru dihapus setelah Docker stabil beberapa hari.

---

## 8. Cutover dan rollback

Database berpindah tempat, jadi ada downtime yang direncanakan. Itu tidak bisa dihindari.

```
1. Precheck       df -h, ukur database, ukur uploads
2. Persiapan      /var/www/bisabayar + .env + compose   (belum start)
3. ── DOWNTIME ── pm2 stop whuz-app-2
4. Dump           mysqldump dari MySQL host
5. Restore        start bisabayar-mysql, muat dump
6. Salin          public/uploads dan logs
7. Start          docker compose up -d, smoke test ke 127.0.0.1:3004
8. Alihkan        nginx → 3004, reload    ── DOWNTIME SELESAI ──
9. Pantau         log dan alur transaksi
```

### 8.1 Kenapa `pm2 stop`, bukan mode maintenance

Mode maintenance di bisabayar mengecualikan `/api` (lihat `EXCLUDED` di `middleware.ts`),
jadi callback Poppay dan VIP tetap masuk dan menulis ke database **lama**. Datanya akan
bercabang: dump sudah diambil, lalu ada tulisan baru yang tidak ikut terbawa.

Menghentikan prosesnya sepenuhnya lebih jujur. Callback yang gagal selama downtime akan
dikirim ulang oleh gateway, dan `WebhookEvent` beserta sapuan rekonsiliasi menangkap
sisanya — keduanya memang dirancang untuk itu.

### 8.2 Rollback

Selama jendela cutover, rollback murah dan lengkap: nginx dikembalikan ke port lama dan
`pm2 start` dijalankan. MySQL host dan `/var/www/whuz-app-2` tidak disentuh sama sekali —
keduanya masih persis seperti sebelum migrasi.

Setelah cutover berhasil, rollback tetap mungkin selama MySQL host belum dimatikan, tetapi
transaksi yang masuk lewat container tidak akan ada di database lama. Karena itu MySQL host
baru boleh dimatikan setelah beberapa hari stabil.

---

## 9. Backup

Tidak ada backup otomatis untuk data yang pindah ke tempat baru — itu tidak boleh dibiarkan.

`mysqldump` harian dari container ke `/var/www/bisabayar/backups`, retensi 7 hari,
dijadwalkan lewat crontab host. Ini satu-satunya crontab yang dipasang; rekonsiliasi tidak
(lihat 6.1).

Backup dianggap bagian dari cutover, bukan pekerjaan menyusul — cutover belum selesai
sampai backup pertama terbukti bisa di-restore.

---

## 10. Risiko

**10.1 Logging bisa gagal secara senyap.** `lib/logger.ts` memuat `rotating-file-stream`
lewat `require()` dinamis di dalam `try/catch` yang jatuh ke stdout bila gagal. Kalau
penelusuran dependensi `output: standalone` melewatkannya, aplikasi tetap berjalan normal
tetapi `logs/app.json` **tidak pernah terbentuk** — dan itu baru ketahuan saat log
dibutuhkan.

Karena itu smoke test wajib memeriksa keberadaan `logs/app.json` beserta baris
`server-start` di dalamnya, bukan sekadar memastikan halaman terbuka.

**10.2 Prisma di Alpine butuh OpenSSL.** Image `node:22-alpine` tidak memuatnya. Tanpa
`apk add --no-cache openssl`, Prisma gagal saat runtime dengan kesalahan yang menyesatkan.

**10.3 `apk add` bisa macet saat VPN aktif.** Masalah MTU di bridge network Docker —
koneksi terbentuk tapi transfer macet. Sudah tercatat di troubleshooting transaksikilat.
Build dilakukan dari laptop tanpa VPN.

**10.4 Error Prisma saat `next build` adalah normal.** Beberapa halaman mencoba mengambil
data saat static generation sementara `DATABASE_URL` memang tidak diset saat build. Next
menangkapnya dan tetap lanjut. Build dianggap sukses selama tahap akhirnya berhasil.

**10.5 Disk VPS.** Lihat §7. Ini risiko dengan preseden nyata di VPS yang sama.

---

## 11. Di luar ruang lingkup

- Memasukkan lint ke `npm run verify` — menunggu 51 error dibereskan (D9)
- Redis untuk pembatas laju — hanya perlu bila suatu saat replika dinaikkan (3.2)
- Rebranding nama `whuz-app` di `package.json` dan berkas dokumentasi
- Mematikan dan membersihkan MySQL host — tugas terpisah setelah beberapa hari stabil
- Memindahkan deployment transaksikilat; spec ini hanya menyentuh bisabayar
