# Deployment

VPS **tidak pernah** menjalankan `docker build`. Image dibangun di luar VPS —
idealnya lewat GitHub Actions, sementara ini manual dari laptop karena akun
GitHub masih terkunci — lalu di-push ke GitHub Container Registry. VPS hanya
`docker compose pull` + `docker compose up -d`.

Rancangan lengkap beserta alasannya:
[`superpowers/specs/2026-09-21-docker-deployment-design.md`](superpowers/specs/2026-09-21-docker-deployment-design.md)

## Arsitektur

```text
laptop  --build & push-->  ghcr.io/akbarryyan/bisabayar:latest + :<git-sha>
                                        |
VPS /var/www/bisabayar  --compose pull & up -d-->
    bisabayar-app     127.0.0.1:3004 → 3000
    bisabayar-mysql   ./mysql-data
```

nginx host mem-proxy ke `127.0.0.1:3004`. transaksikilat memakai 3003 di VPS
yang sama.

## Build dan push dari laptop

Jalankan gate-nya dulu. Jangan membangun image kalau ini merah.

```bash
cd ~/Kerjaan/repository/bisabayar
git pull origin main

npm run test:db:up && npm run test:db:push
npm run verify

SHA=$(git rev-parse --short HEAD)
docker build -t ghcr.io/akbarryyan/bisabayar:latest -t "ghcr.io/akbarryyan/bisabayar:$SHA" .
docker push ghcr.io/akbarryyan/bisabayar:latest
docker push "ghcr.io/akbarryyan/bisabayar:$SHA"
```

**Dua tag, selalu.** Tanpa tag sha, rollback tidak punya sasaran.

Tidak ada `--build-arg`. Ketiga `NEXT_PUBLIC_*` hanya dipakai di kode server dan
punya fallback ke `APP_URL` runtime, jadi ganti domain cukup mengubah `.env` di
VPS lalu `up -d` — tanpa membangun ulang.

Login GHCR di laptop, sekali per mesin, token butuh scope `write:packages`:

```bash
echo "<PAT_WRITE_PACKAGES>" | docker login ghcr.io -u akbarryyan --password-stdin
```

### Catatan: legacy builder

Docker di laptop ini memakai legacy builder — buildx belum terpasang, dan
Docker sendiri memperingatkan builder itu *deprecated*. Build tetap berhasil,
hanya saja tanpa cache layer BuildKit setiap build ulang mengerjakan `npm ci`
dari awal. Selama rilis masih dibangun manual, memasangnya menghemat banyak
waktu:

```bash
sudo apt install docker-buildx
```

Flag `--progress=plain` hanya berlaku setelah buildx terpasang; legacy builder
menolaknya. Workflow GitHub Actions memakai buildx sendiri, jadi tidak
terpengaruh.

## Deploy ke VPS

```bash
ssh <user>@<vps-host>
cd /var/www/bisabayar
docker compose pull
docker compose up -d
docker image prune -af
docker inspect bisabayar-app --format '{{.Config.Image}}'
```

`docker image prune -af` hanya membuang image yang tidak dipakai container mana
pun, jadi aman dijalankan tepat setelah `up -d`.

**Kalau rilisnya mengandung migration**, sisipkan satu langkah:

```bash
docker compose pull
docker compose run --rm bisabayar-app node node_modules/prisma/build/index.js migrate deploy
docker compose up -d
```

Urutannya tidak boleh dibalik. Migration berjalan memakai image baru selagi
container lama masih melayani trafik. Kalau `up -d` lebih dulu, container baru
naik sebelum tabelnya ada.

Memeriksa apakah sebuah rilis mengandung migration:

```bash
git diff --name-only <sha-terakhir-dideploy>..HEAD -- prisma/migrations
```

Login GHCR di VPS, sekali saja, token cukup scope `read:packages`:

```bash
echo "<PAT_READ_PACKAGES>" | docker login ghcr.io -u akbarryyan --password-stdin
```

Lalu smoke test:

```bash
bash scripts/smoke-docker.sh http://127.0.0.1:3004 /var/www/bisabayar
```

## Cutover pertama dari PM2

Database berpindah tempat, jadi ada downtime yang direncanakan. Selama seluruh
langkah ini, `/var/www/whuz-app-2` dan MySQL host **tidak disentuh** — keduanya
adalah jalan pulang.

### 1. Precheck

```bash
df -h /                                        # batalkan kalau >70%
docker system df
mysql -u root -p -e "SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024) AS mb
  FROM information_schema.tables GROUP BY table_schema;"
du -sh /var/www/whuz-app-2/public/uploads
```

Image bisabayar berukuran ~514MB, ditambah image MySQL ~600MB yang belum ada di
VPS ini karena transaksikilat memakai MySQL host.

### 2. Persiapan (belum mengganggu produksi)

```bash
mkdir -p /var/www/bisabayar/{logs,uploads,backups}
cd /var/www/bisabayar
# salin docker-compose.yml dan scripts/ dari repo, lalu susun .env
```

**Kepemilikan direktori volume WAJIB disesuaikan.** Container berjalan sebagai
uid 1001, sementara direktori yang baru dibuat milik user host. Bind mount
menimpa direktori di dalam image beserta kepemilikannya, jadi `chown` di
`Dockerfile` tidak menolong sama sekali.

Kalau dilewati: `logs/app.json` tidak pernah terbentuk — dan **diam-diam**,
karena `lib/logger.ts` menangkap kegagalan izin lalu jatuh ke stdout — sementara
setiap unggahan gambar gagal.

```bash
sudo chown -R 1001:1001 /var/www/bisabayar/logs /var/www/bisabayar/uploads
```

Tanpa akses sudo, hal yang sama bisa dilakukan dari dalam container setelah
`up -d`:

```bash
docker compose exec -u root bisabayar-app \
  chown -R nextjs:nodejs /app/logs /app/public/uploads
docker compose restart bisabayar-app
```

`.env` di VPS wajib memuat `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`,
`MYSQL_USER`, `MYSQL_PASSWORD`, `SESSION_SECRET`, `APP_URL`, dan:

```
DATABASE_URL="mysql://bisabayar:<password>@bisabayar-mysql:3306/bisabayar"
```

Kredensial provider dan gateway **tidak** perlu disalin — semuanya sudah ada di
tabel `site_configs`, dan nilai di sana menimpa env.

### 3. Downtime mulai

```bash
pm2 stop whuz-app-2
```

Memakai `pm2 stop`, bukan mode maintenance: mode maintenance mengecualikan
`/api`, jadi callback Poppay dan VIP tetap masuk dan menulis ke database lama —
datanya akan bercabang setelah dump diambil. Callback yang gagal selama downtime
akan dikirim ulang oleh gateway, dan `WebhookEvent` beserta sapuan rekonsiliasi
menangkap sisanya.

### 4. Pindahkan data

```bash
mysqldump -u root -p --single-transaction --quick --routines --triggers \
  <nama-db-lama> | gzip -c > /root/bisabayar-cutover.sql.gz

cd /var/www/bisabayar
docker compose up -d bisabayar-mysql
docker compose ps                              # tunggu "healthy"

zcat /root/bisabayar-cutover.sql.gz | docker exec -i bisabayar-mysql \
  mysql -u root -p"<MYSQL_ROOT_PASSWORD>" bisabayar

rsync -a /var/www/whuz-app-2/public/uploads/ /var/www/bisabayar/uploads/
sudo chown -R 1001:1001 /var/www/bisabayar/uploads
```

`rsync`, bukan `mv` — berkas lama harus tetap di tempatnya sampai rollback tidak
lagi dibutuhkan. `chown` diulang karena `rsync` membawa kepemilikan asal.

### 5. Naikkan dan uji, produksi masih mati

```bash
docker compose pull
docker compose up -d
bash scripts/smoke-docker.sh http://127.0.0.1:3004 /var/www/bisabayar
```

Jangan lanjut kalau ada satu pun yang `GAGAL`.

### 6. Alihkan nginx

Ubah `proxy_pass` ke `http://127.0.0.1:3004`, lalu:

```bash
nginx -t && systemctl reload nginx
```

Downtime selesai. Uji lewat domain sungguhan: halaman utama, login, dan minimal
satu alur transaksi sampai tuntas.

### 7. Pasang backup

```bash
crontab -e
# 0 3 * * * bash /var/www/bisabayar/scripts/backup-mysql.sh >> /var/log/bisabayar-backup.log 2>&1

bash /var/www/bisabayar/scripts/backup-mysql.sh      # jalankan sekali sekarang
zcat /var/www/bisabayar/backups/*.sql.gz | grep -c 'CREATE TABLE'   # harus 29
```

Angkanya 29: 28 model di `schema.prisma` ditambah `_prisma_migrations` milik
Prisma.

Cutover belum selesai sampai langkah ini hijau.

### 8. Rollback, kalau perlu

```bash
# kembalikan proxy_pass nginx ke port lama
nginx -t && systemctl reload nginx
pm2 start whuz-app-2
cd /var/www/bisabayar && docker compose down
```

Lengkap dan utuh selama MySQL host belum dimatikan. Setelah trafik masuk lewat
container, transaksi baru hanya ada di database container — karena itu MySQL
host baru boleh dimatikan setelah beberapa hari stabil, dan `pm2 delete
whuz-app-2` hanya setelah itu.

## Rollback rilis

Image ditandai `:latest` dan `:<git-sha>`. Untuk kembali ke versi sebelumnya:

1. Cari sha-nya (`git log --oneline`)
2. Di VPS, ganti tag image di `docker-compose.yml` dari `:latest` ke `:<sha>`
3. `docker compose pull && docker compose up -d`

Rollback yang mengembalikan migration tidak ditangani: Prisma tidak punya
`migrate down`. Rilis dengan migration merusak diperbaiki maju dengan migration
baru.

## Log aplikasi

Aplikasi menulis JSON terstruktur ke `/var/www/bisabayar/logs/app.json` dan
**merotasinya sendiri** saat menyentuh `LOG_MAX_SIZE` (bawaan 10M), lengkap
dengan kompresi gzip.

**Jangan memasang logrotate untuk berkas ini.** Dua perotasi akan berebut berkas
yang sama. Ini berbeda dari transaksikilat, yang menulis log polos dan memang
menyerahkan rotasi ke logrotate.

Berkasnya dibuat dengan mode `0640` milik uid 1001, jadi user host biasa **tidak
bisa membacanya**. Pakai `sudo`, atau baca dari dalam container:

```bash
sudo tail -f /var/www/bisabayar/logs/app.json | npx pino-pretty
docker compose exec bisabayar-app tail -f /app/logs/app.json | npx pino-pretty
docker compose exec bisabayar-app grep -hE '"level":"(error|fatal)"' /app/logs/app.json
```

Detail: [LOGGING.md](LOGGING.md).

## Rekonsiliasi order menggantung

**Tidak ada crontab untuk ini, dan memang tidak diperlukan.**

`sweepStuckOrders` berjalan di dalam proses aplikasi tiap 60 detik, menanyakan
ulang ke database order mana yang tersangkut di `PAID`/`PROCESSING_PROVIDER`.
Keadaannya diturunkan dari data, bukan dari timer di memori, jadi container
dibuat ulang tidak menghilangkan apa pun.

Ini berbeda dari transaksikilat, yang memakai `POST /api/cron/reconcile-orders`
dari crontab karena retry-nya memang bersandar pada timer memori. Endpoint
semacam itu tidak ada di bisabayar.

Sapuan manual dari panel admin tetap tersedia lewat
`POST /api/admin/transactions/reconcile-all`.

## Kebersihan disk

VPS ini dipakai bersama transaksikilat. **Insiden 2026-09-20:** disk 40G penuh
100%, MySQL mati dengan `Error: 28 (No space left on device)`, produksi mati
±1,5 hari — 22 image Docker menumpuk (~24GB) plus 3.3GB build cache.

Yang menutup celah itu di sini:

1. `docker image prune -af` adalah bagian tetap langkah deploy.
2. Batas log container dipasang di **kedua** service (`max-size: 10m`,
   `max-file: 3`).
3. Backup dibatasi retensi 7 hari dan membatalkan diri bila disk ≥85%.
4. `output: "standalone"` membuat image memuat 123M isi aplikasi, bukan 741M
   `node_modules` penuh.

Pemeriksaan berkala:

```bash
df -h /                 # <80% aman
docker system df
sudo du -sh /var/www/bisabayar/{mysql-data,uploads,backups,logs}
```

Yang masih tumbuh tanpa batas dan perlu diawasi: `uploads/` — bertambah seiring
transaksi dan tidak pernah dibersihkan.

## Troubleshooting

**`apk add` macet lama saat `docker build`.** VPN aktif menyebabkan masalah MTU
di bridge network Docker: koneksi TCP terbentuk tapi transfer macet. Matikan VPN
saat build.

**Banyak `prisma:error ... Environment variable not found: DATABASE_URL` saat
build.** Normal dan tidak membatalkan build — sebagian halaman mencoba mengambil
data saat static generation sementara `DATABASE_URL` memang tidak diset saat
build.

**Container naik tapi `logs/app.json` tidak pernah ada.** Dua sebab, keduanya
gagal tanpa bersuara karena `lib/logger.ts` jatuh ke stdout:

1. Kepemilikan volume salah — lihat langkah 2 pada Cutover. Ini yang paling
   sering.
2. `rotating-file-stream` tidak ikut ke image. Jalankan
   `bash scripts/check-standalone.sh` setelah build.

**`docker compose ps` bilang container "Up" tapi situs tidak bisa diakses.**
Konfigurasi yang tidak lengkap **tidak** membuat container keluar:
`instrumentation.ts` melempar, Next mencatatnya sebagai `unhandledRejection`,
lalu prosesnya tetap hidup sementara `GET /` menjawab `000`. Kolom health pada
`docker compose ps` yang memberi tahu keadaan sebenarnya — periksa itu, bukan
kolom status. Lalu `docker compose logs bisabayar-app` untuk melihat sebabnya.

**Container gagal start dengan `Konfigurasi lingkungan tidak lengkap`.** Ini
disengaja: `SESSION_SECRET` (minimal 32 karakter) dan `DATABASE_URL` divalidasi
saat boot. Lebih baik gagal keras daripada menyala setengah jalan.

**`docker compose up` bilang MySQL unhealthy.** Inisialisasi pertama memakan
waktu; `start_period` sudah 60 detik. Periksa `docker compose logs
bisabayar-mysql`. Kalau ada keluhan izin akses pada `/var/lib/mysql`, periksa
kepemilikan `./mysql-data` di host.

**Backup ditolak dengan "tidak memuat penanda '-- Dump completed'".** Dump
terpotong, biasanya karena kredensial salah atau MySQL mati di tengah jalan.
Berkasnya sengaja dibuang supaya tidak ada backup rusak yang terlihat sah.
