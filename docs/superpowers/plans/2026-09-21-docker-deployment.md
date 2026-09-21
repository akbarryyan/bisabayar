# Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membuat bisabayar bisa dibangun sebagai image Docker di laptop, di-push ke GHCR, dan dijalankan di VPS lewat `docker compose` bersama MySQL-nya sendiri — menggantikan PM2.

**Architecture:** Image multi-stage `node:22-alpine` dengan `output: "standalone"` Next.js. Dua service di compose: aplikasi dan MySQL, keduanya memakai bind mount ke `/var/www/bisabayar` supaya isinya terlihat dan terukur dari host. VPS tidak pernah menjalankan `docker build`.

**Tech Stack:** Docker + Compose v2, node:22-alpine, Next.js 16 standalone, Prisma 5 + MySQL 8.4, GitHub Container Registry.

**Spec:** [`docs/superpowers/specs/2026-09-21-docker-deployment-design.md`](../specs/2026-09-21-docker-deployment-design.md)

## Global Constraints

- **Satu instance saja.** Pembatas laju in-memory dan sapuan rekonsiliasi in-process. `replicas` tidak boleh dinaikkan dan compose tidak boleh menskalakan service aplikasi.
- **Port host 3004** → 3000 di dalam container. transaksikilat memakai 3003 di VPS yang sama.
- **Direktori VPS `/var/www/bisabayar`.** `/var/www/whuz-app-2` tidak disentuh — itu jaring pengaman rollback.
- **Tanpa build arg.** `NEXT_PUBLIC_*` sengaja dibiarkan kosong saat build; kode jatuh ke `APP_URL` runtime.
- **Tanpa endpoint cron dan tanpa logrotate.** Lihat §6.1 dan §6.2 spec — bisabayar sudah menyelesaikan keduanya dengan cara lain.
- `npm run verify` = typecheck + test, **tanpa lint** (lint saat ini 51 error).
- Image ditandai `:latest` **dan** `:<git-sha>` pada setiap build. Tanpa tag sha, rollback tidak punya sasaran.
- Batas log container `max-size: 10m`, `max-file: 3` untuk **kedua** service.
- Commit memakai conventional commits.

## Fakta yang sudah diverifikasi

Dibuktikan lewat build percobaan sebelum rencana ini ditulis — jangan diuji ulang dari nol:

| Fakta | Nilai |
|---|---|
| `.next/standalone` terbentuk | ya, `server.js` ada |
| `rotating-file-stream` tertelusur | **ya** — risiko §10.1 tidak terjadi |
| `pino`, `pino-pretty`, `@prisma/client`, `.prisma` tertelusur | ya |
| `prisma` CLI tertelusur | **tidak** — harus di-`COPY` eksplisit |
| Ukuran | standalone 123M, `node_modules` penuh 741M, `.next/static` 4.5M |
| Ukuran image jadi | **514MB** (`docker images`). Dua layer Prisma CLI menyumbang 72,7MB — itu harga agar `migrate deploy` bisa dijalankan dari dalam container. Jangan memakai `docker image inspect --format '{{.Size}}'`; angkanya bukan total |
| Build context | 6,2MB, dari 923MB repo penuh |
| Entry CLI Prisma | `node_modules/prisma/build/index.js` |
| `binaryTargets` di schema | tidak diset — aman, karena `prisma generate` dijalankan di dalam stage alpine sehingga engine musl yang terbentuk |

---

## Task 1: Output standalone dan `.dockerignore`

Fondasi. Tanpa `output: "standalone"` image akan membawa 741M `node_modules`; dengan itu 123M. Di VPS yang pernah penuh 100%, selisih itu bukan detail.

**Files:**
- Modify: `next.config.ts`
- Create: `.dockerignore`
- Create: `scripts/check-standalone.sh`

**Interfaces:**
- Produces: `.next/standalone/server.js` sebagai entry point runtime; `scripts/check-standalone.sh` sebagai penjaga regresi yang dipakai Task 4

- [ ] **Step 1: Tulis penjaga yang gagal**

Buat `scripts/check-standalone.sh`:

```bash
#!/usr/bin/env bash
#
# Penjaga: paket yang dimuat secara DINAMIS harus ikut tertelusur ke
# .next/standalone.
#
# lib/logger.ts memuat rotating-file-stream lewat require() di dalam try/catch
# yang jatuh ke stdout bila gagal. Artinya kalau paket itu tidak ikut, aplikasi
# TETAP berjalan normal — hanya saja logs/app.json tidak pernah terbentuk, dan
# itu baru ketahuan saat lognya dibutuhkan. Kegagalan senyap seperti ini yang
# paling mahal.
#
# Pakai:  npm run build && bash scripts/check-standalone.sh
#
set -u
ROOT=".next/standalone"
fail=0

if [ ! -f "$ROOT/server.js" ]; then
  echo "GAGAL: $ROOT/server.js tidak ada. Sudah menjalankan 'npm run build'?"
  echo "       Pastikan next.config.ts memuat output: \"standalone\"."
  exit 1
fi

for p in rotating-file-stream pino pino-pretty @prisma/client .prisma; do
  if [ -e "$ROOT/node_modules/$p" ]; then
    echo "  ok      $p"
  else
    echo "  HILANG  $p"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "GAGAL: ada paket yang tidak tertelusur ke standalone."
  echo "       Salin manual di Dockerfile, atau tambahkan ke serverExternalPackages."
  exit 1
fi

echo
echo "OK: seluruh paket runtime yang kritis ada di standalone."
```

- [ ] **Step 2: Jalankan penjaga, pastikan GAGAL**

```bash
rm -rf .next
npm run build
bash scripts/check-standalone.sh
```

Harapan: GAGAL dengan `.next/standalone/server.js tidak ada` — karena `output: "standalone"` belum aktif.

- [ ] **Step 3: Aktifkan output standalone**

Di `next.config.ts`, sisipkan satu baris sebagai properti pertama di dalam `nextConfig`, tepat sebelum komentar tentang `serverExternalPackages`:

```ts
const nextConfig: NextConfig = {
  // Image produksi memuat .next/standalone saja (123M) alih-alih node_modules
  // penuh (741M). Lihat docs/DEPLOYMENT.md.
  output: "standalone",
  // pino & pino-pretty sudah masuk daftar external bawaan Next, tapi
  // rotating-file-stream tidak — kalau ikut di-bundle, instance stream-nya
  // terduplikasi antar webpack layer dan rotasi file jadi kacau.
  serverExternalPackages: ["pino", "pino-pretty", "rotating-file-stream"],
```

Sisa berkas tidak berubah.

- [ ] **Step 4: Jalankan penjaga, pastikan LULUS**

```bash
npm run build
bash scripts/check-standalone.sh
```

Harapan: lima baris `ok` lalu `OK: seluruh paket runtime yang kritis ada di standalone.`

- [ ] **Step 5: Buat `.dockerignore`**

Tanpa berkas ini, `docker build` mengirim `node_modules` (741M), `.next`, `logs/`, dan seluruh `public/uploads` ke daemon sebagai build context.

```
node_modules
.next
.git
.github
logs
public/uploads
coverage
tests
docs
.env
.env.*
!.env.example
*.tsbuildinfo
next-env.d.ts
.vscode
.claude
.specify
.codegraph
ecosystem.config.js
Dockerfile
docker-compose.yml
.dockerignore
README.md
```

`tests` dan `docs` dikecualikan karena tidak dibutuhkan saat build image — gate test berjalan di laptop lewat `npm run verify`, bukan di dalam image.

- [ ] **Step 6: Buktikan build context-nya kecil**

```bash
du -sh --exclude=node_modules --exclude=.next --exclude=.git --exclude=logs --exclude=public/uploads .
```

Harapan: puluhan MB, bukan ratusan.

- [ ] **Step 7: Commit**

```bash
git add next.config.ts .dockerignore scripts/check-standalone.sh
git commit -m "feat(build): output standalone dan .dockerignore

Standalone memangkas isi image dari 741M node_modules jadi 123M. Penjaga
check-standalone.sh memastikan paket yang dimuat secara dinamis —
rotating-file-stream — ikut tertelusur; kalau tidak, logging gagal senyap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Dockerfile

**Files:**
- Create: `Dockerfile`

**Interfaces:**
- Consumes: `output: "standalone"` dari Task 1
- Produces: image dengan entry `node server.js` pada port 3000, memuat `prisma` CLI di `node_modules/prisma/build/index.js` untuk `migrate deploy`

- [ ] **Step 1: Tulis Dockerfile**

```dockerfile
# Image produksi bisabayar.
#
# VPS TIDAK PERNAH menjalankan `docker build` — image dibangun di laptop atau CI
# lalu di-push ke GHCR. Lihat docs/DEPLOYMENT.md.
#
# `prisma generate` sengaja dijalankan di dalam stage alpine: schema.prisma tidak
# menyetel binaryTargets, jadi engine yang terbentuk mengikuti platform tempat
# generate berjalan. Kalau digenerate di luar (glibc) lalu disalin ke alpine
# (musl), Prisma gagal saat runtime dengan pesan yang menyesatkan.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
# openssl dibutuhkan Prisma; libc6-compat untuk binary yang menganggap glibc.
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` memicu postinstall → prisma generate, karena itu prisma/ disalin dulu.
RUN npm ci

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* sengaja TIDAK dikirim sebagai build arg. Semua pemakainya ada di
# kode server dan punya fallback ke APP_URL yang dibaca saat runtime, jadi ganti
# domain cukup mengubah .env di VPS tanpa membangun ulang image.
RUN npm run build

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# public/ tidak ikut ke standalone — harus disalin sendiri.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma CLI dan migrasinya TIDAK ikut tertelusur ke standalone, padahal
# `migrate deploy` saat rilis membutuhkannya. Disalin eksplisit.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Dibuat lebih dulu supaya kepemilikannya benar ketika volume host di-mount
# ke sini oleh compose.
RUN mkdir -p /app/logs /app/public/uploads \
  && chown -R nextjs:nodejs /app/logs /app/public/uploads

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 2: Build image-nya**

```bash
docker build -t bisabayar:uji .
```

Harapan: sukses. Pesan `prisma:error ... Environment variable not found: DATABASE_URL` selama `npm run build` **normal dan tidak membatalkan build** — sebagian halaman mencoba mengambil data saat static generation sementara `DATABASE_URL` memang tidak diset saat build.

Kalau `apk add` macet lama: matikan VPN. Itu masalah MTU di bridge network Docker — koneksi terbentuk tapi transfer macet.

- [ ] **Step 3: Uji bahwa konfigurasi salah menggagalkan start**

`instrumentation.ts` menolak menyala tanpa `SESSION_SECRET` dan `DATABASE_URL`. Perilaku ini harus terbawa ke container — lebih baik gagal keras daripada menyala setengah jalan dengan storefront terlihat sehat sementara login dan checkout diam-diam rusak.

```bash
timeout 60 docker run --rm bisabayar:uji 2>&1 | head -20
```

Harapan: keluarannya memuat `Konfigurasi lingkungan tidak lengkap:` beserta
`SESSION_SECRET belum diisi.` dan `DATABASE_URL belum diisi.`

**Container-nya TIDAK berhenti**, dan itu bukan kesalahan konfigurasimu.
`instrumentation.ts` melempar, Next 16 mencatatnya sebagai `unhandledRejection`,
lalu prosesnya tetap hidup — statusnya `running` sementara `GET /` menjawab `000`.
Terverifikasi saat pelaksanaan; perilakunya sama di bawah PM2, jadi ini bukan akibat
Docker.

Karena itu service aplikasi di Task 3 memakai `healthcheck`. Tanpa itu
`docker compose ps` menampilkan container yang mati di dalam sebagai "Up", dan
Docker tidak akan me-restart-nya karena ia tidak pernah keluar.

- [ ] **Step 4: Periksa isi image**

```bash
docker run --rm --entrypoint sh bisabayar:uji -c \
  'ls server.js && ls node_modules/prisma/build/index.js && ls node_modules/rotating-file-stream >/dev/null && echo SEMUA_ADA'
docker image inspect bisabayar:uji --format '{{.Size}}' | awk '{printf "ukuran image: %.0f MB\n", $1/1024/1024}'
```

Harapan: `SEMUA_ADA`, dan ukuran image di bawah 700 MB.

Kalau `node_modules/prisma/build/index.js` tidak ada, cari letaknya yang sebenarnya:
`docker run --rm --entrypoint sh bisabayar:uji -c "ls node_modules/prisma"` — lalu sesuaikan perintah migrasi di Task 3 dan Task 6.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): Dockerfile multi-stage berbasis standalone

prisma generate dijalankan di dalam stage alpine supaya engine musl yang
terbentuk. Prisma CLI dan prisma/migrations disalin eksplisit karena
keduanya tidak ikut tertelusur ke standalone, padahal migrate deploy saat
rilis membutuhkannya.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: docker-compose.yml dan smoke test lokal

Task ini membuktikan seluruh tumpukan jalan — aplikasi, MySQL, migrasi, volume — di laptop, sebelum apa pun menyentuh VPS.

**Files:**
- Create: `docker-compose.yml`
- Create: `scripts/smoke-docker.sh`

**Interfaces:**
- Consumes: image dari Task 2
- Produces: service `bisabayar-app` (host 3004) dan `bisabayar-mysql`; `scripts/smoke-docker.sh <base-url>` sebagai smoke test yang dipakai juga saat cutover

- [ ] **Step 1: Tulis compose**

```yaml
# Deployment bisabayar. VPS hanya `docker compose pull` + `up -d`.
#
# SATU instance aplikasi, tidak boleh lebih: pembatas laju disimpan di memori
# proses dan sapuan rekonsiliasi berjalan di dalam proses. Dua replika berarti
# batas laju dua kali lipat dan dua sapuan menembak provider yang sama.

services:
  bisabayar-mysql:
    image: mysql:8.4
    container_name: bisabayar-mysql
    restart: unless-stopped
    env_file: .env
    environment:
      TZ: Asia/Jakarta
    volumes:
      # Bind mount, bukan named volume: isinya harus terlihat dan terukur dari
      # host. VPS ini pernah penuh 100% karena pemakaian disk Docker tidak
      # terpantau.
      - ./mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p$$MYSQL_ROOT_PASSWORD"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  bisabayar-app:
    image: ghcr.io/akbarryyan/bisabayar:latest
    container_name: bisabayar-app
    restart: unless-stopped
    depends_on:
      bisabayar-mysql:
        condition: service_healthy
    env_file: .env
    environment:
      # Struktural, bukan rahasia — sengaja di sini, bukan di .env.
      TZ: Asia/Jakarta
      LOG_DIR: /app/logs
    ports:
      # Diikat ke loopback: nginx host yang mem-proxy. 3003 sudah dipakai
      # transaksikilat di VPS yang sama.
      - "127.0.0.1:3004:3000"
    volumes:
      - ./uploads:/app/public/uploads
      - ./logs:/app/logs
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

- [ ] **Step 2: Tulis smoke test**

Buat `scripts/smoke-docker.sh`:

```bash
#!/usr/bin/env bash
#
# Smoke test untuk instance Docker yang baru naik.
#
# Yang diperiksa bukan cuma "halamannya terbuka". Dua hal yang gagal SENYAP
# justru yang paling penting di sini:
#
#   1. logs/app.json. lib/logger.ts jatuh ke stdout bila rotating-file-stream
#      gagal dimuat, jadi aplikasi terlihat sehat sementara tidak ada log yang
#      tersimpan sama sekali.
#   2. Volume uploads. Kalau mount-nya salah alamat, unggahan tetap berhasil
#      tapi hilang setiap container dibuat ulang.
#
# Pakai:  bash scripts/smoke-docker.sh [http://127.0.0.1:3004] [/var/www/bisabayar]
#
set -u
BASE="${1:-http://127.0.0.1:3004}"
DIR="${2:-.}"
fail=0
pass=0

check_http() {
  local path="$1"; shift
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path" 2>/dev/null || echo 000)
  for want in "$@"; do
    if [ "$code" = "$want" ]; then
      echo "  ok      $path → $code"
      pass=$((pass+1))
      return
    fi
  done
  echo "  GAGAL   $path → $code (diharapkan: $*)"
  fail=$((fail+1))
}

echo "Halaman dan API:"
check_http "/" 200
check_http "/api/site-branding" 200
# Guard admin harus menolak tanpa cookie — 401 kalau anonim.
check_http "/api/admin/dashboard" 401 403

echo
echo "Log tersimpan ke berkas:"
if [ -s "$DIR/logs/app.json" ]; then
  echo "  ok      $DIR/logs/app.json ada dan tidak kosong"
  pass=$((pass+1))
  if grep -q '"msg":"server-start"' "$DIR/logs/app.json"; then
    echo "  ok      baris server-start ditemukan"
    pass=$((pass+1))
  else
    echo "  GAGAL   baris server-start tidak ada — logger mungkin jatuh ke stdout"
    fail=$((fail+1))
  fi
else
  echo "  GAGAL   $DIR/logs/app.json tidak ada atau kosong"
  echo "          rotating-file-stream kemungkinan tidak ikut ke image."
  fail=$((fail+1))
fi

echo
echo "Volume uploads bisa ditulis:"
if [ -d "$DIR/uploads" ]; then
  echo "  ok      $DIR/uploads ada di host"
  pass=$((pass+1))
else
  echo "  GAGAL   $DIR/uploads tidak ada"
  fail=$((fail+1))
fi

echo
echo "lulus=$pass gagal=$fail"
[ "$fail" -eq 0 ] || exit 1
```

- [ ] **Step 3: Siapkan `.env` sementara untuk uji lokal**

> ⚠️ Berkas `.env` ini HANYA untuk uji lokal dan **dihapus di Step 7**. Next.js
> ikut membaca `.env`, jadi membiarkannya akan mengacaukan `npm run dev` yang
> memakai `.env.local`.

```bash
cat > .env <<'EOF'
MYSQL_ROOT_PASSWORD=ujilokal-root
MYSQL_DATABASE=bisabayar
MYSQL_USER=bisabayar
MYSQL_PASSWORD=ujilokal-app

DATABASE_URL="mysql://bisabayar:ujilokal-app@bisabayar-mysql:3306/bisabayar"
SESSION_SECRET="uji-lokal-minimal-tiga-puluh-dua-karakter-ya"
APP_URL="http://127.0.0.1:3004"
EOF
```

Compose menunjuk image GHCR, sementara uji ini memakai image yang dibangun di Task 2.
Tandai ulang supaya nama yang dicari compose tersedia secara lokal:

```bash
docker tag bisabayar:uji ghcr.io/akbarryyan/bisabayar:latest
```

- [ ] **Step 4: Naikkan tumpukannya dan jalankan migrasi**

```bash
docker compose up -d bisabayar-mysql
docker compose ps                      # tunggu sampai bisabayar-mysql "healthy"
docker compose run --rm bisabayar-app node node_modules/prisma/build/index.js migrate deploy
docker compose up -d
```

Harapan: `migrate deploy` menerapkan seluruh migrasi ke database kosong dan berakhir dengan `All migrations have been successfully applied.`

- [ ] **Step 5: Jalankan smoke test**

```bash
bash scripts/smoke-docker.sh http://127.0.0.1:3004 .
```

Harapan: `gagal=0`. Kalau `logs/app.json` gagal, periksa `docker compose logs bisabayar-app` — kalau lognya justru muncul di stdout, berarti `rotating-file-stream` tidak terbawa dan Dockerfile perlu menyalinnya eksplisit.

- [ ] **Step 6: Buktikan data bertahan melewati recreate**

Inti dari seluruh urusan volume. Kalau langkah ini lolos, cutover aman.

```bash
echo "uji" > ./uploads/bukti.txt
docker compose down
docker compose up -d
sleep 5
cat ./uploads/bukti.txt                                    # harus "uji"
docker compose exec bisabayar-mysql mysql -uroot -p"ujilokal-root" \
  -e "SELECT COUNT(*) AS tabel FROM information_schema.tables WHERE table_schema='bisabayar';"
rm ./uploads/bukti.txt
```

Harapan: isi `bukti.txt` masih ada, dan jumlah tabel 28 — bukan 0. Nol berarti data MySQL tidak bertahan dan bind mount-nya salah.

- [ ] **Step 7: Bersihkan lingkungan uji**

```bash
docker compose down
rm -f .env
sudo rm -rf ./mysql-data ./uploads ./logs/app.json
```

`sudo` dibutuhkan karena `mysql-data` ditulis oleh proses di dalam container dengan uid berbeda.

> Pastikan `.env` benar-benar terhapus. Kalau tertinggal, `npm run dev` akan
> memakai `DATABASE_URL` yang menunjuk hostname compose dan gagal menyambung.

- [ ] **Step 8: Commit**

```bash
git status --short          # pastikan .env TIDAK muncul
git add docker-compose.yml scripts/smoke-docker.sh
git commit -m "feat(docker): compose untuk aplikasi dan MySQL, plus smoke test

Bind mount dipakai untuk data MySQL, uploads, dan logs supaya isinya terlihat
dan terukur dari host — VPS ini pernah penuh 100% karena pemakaian disk Docker
tidak terpantau. Batas log dipasang di kedua service sejak awal.

Smoke test memeriksa logs/app.json, bukan hanya halaman terbuka: logger jatuh
ke stdout tanpa bersuara kalau rotating-file-stream gagal dimuat.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Gate `npm run verify` dan workflow dorman

**Files:**
- Modify: `package.json`
- Create: `.github/workflows/build-and-push.yml`

**Interfaces:**
- Produces: `npm run verify`, dipakai sebagai gate manual sebelum build image

`verify` sengaja **tidak** memanggil `scripts/check-standalone.sh`: penjaga itu
membutuhkan `npm run build` lebih dulu, dan gate yang memakan beberapa menit akan
dilewati orang. Penjaga standalone dijalankan tersendiri setelah build, seperti pada
bagian Verifikasi akhir.

- [ ] **Step 1: Tambahkan script `verify`**

Di `package.json`, sisipkan setelah baris `"lint"`:

```json
    "verify": "tsc --noEmit && npm test",
```

Lint sengaja **tidak** disertakan: saat ini ada 51 error, dan gate yang selalu merah akan selalu dilewati. Lint bergabung setelah error itu dibereskan.

- [ ] **Step 2: Jalankan gate-nya**

```bash
npm run test:db:up && npm run test:db:push
npm run verify
```

Harapan: typecheck bersih, lalu 79 test lulus.

- [ ] **Step 3: Tulis workflow**

Buat `.github/workflows/build-and-push.yml`:

```yaml
# Build image dan push ke GHCR.
#
# DORMAN: akun GitHub terkunci karena billing, jadi workflow ini belum pernah
# berjalan. Selama itu, build dilakukan manual dari laptop — lihat
# docs/DEPLOYMENT.md. Berkas ini sudah siap begitu akunnya pulih.
#
# Job `build-and-push` hanya berjalan kalau `verify` hijau, sehingga image tidak
# pernah sampai ke registry dari kode yang test-nya merah.

name: build-and-push

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.4
        env:
          MYSQL_ROOT_PASSWORD: testpass
          MYSQL_DATABASE: whuz_test
        ports:
          - 3399:3306
        options: >-
          --health-cmd="mysqladmin ping -h 127.0.0.1 -uroot -ptestpass"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=12
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Siapkan skema database uji
        run: npm run test:db:push
      - name: Typecheck dan test
        run: npm run verify

  build-and-push:
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          # Dua tag selalu. Tanpa tag sha, rollback tidak punya sasaran.
          tags: |
            ghcr.io/akbarryyan/bisabayar:latest
            ghcr.io/akbarryyan/bisabayar:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: Periksa sintaks YAML-nya**

```bash
node -e "const f=require('fs').readFileSync('.github/workflows/build-and-push.yml','utf8'); if(!/name: build-and-push/.test(f)) throw new Error('nama workflow hilang'); console.log('YAML terbaca, panjang', f.length, 'karakter')"
```

Workflow tidak bisa diuji sungguhan selama akun terkunci — ini hanya memastikan berkasnya tidak korup.

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/build-and-push.yml
git commit -m "feat(ci): gate npm run verify dan workflow build-and-push

verify = typecheck + test. Lint belum disertakan karena saat ini 51 error;
gate yang selalu merah akan selalu dilewati.

Workflow dorman sampai akun GitHub pulih dari kunci billing. Sampai itu,
verify dijalankan manual sebelum build image dari laptop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Backup MySQL

Data pindah ke tempat baru tanpa jaring. Cutover belum boleh dianggap selesai sampai ini ada dan terbukti bisa di-restore.

**Files:**
- Create: `scripts/backup-mysql.sh`

**Interfaces:**
- Consumes: service `bisabayar-mysql` dari Task 3
- Produces: `scripts/backup-mysql.sh`, dipasang di crontab host saat cutover

- [ ] **Step 1: Tulis skripnya**

```bash
#!/usr/bin/env bash
#
# Dump harian database bisabayar dari container ke host.
#
# Dipasang di crontab host, BUKAN di dalam container — kalau di dalam, backup
# ikut hilang justru pada saat yang paling membutuhkannya.
#
# Retensi sengaja pendek: VPS ini dipakai bersama transaksikilat dan pernah
# penuh 100% sampai MySQL mati dengan "Error: 28 (No space left on device)".
#
# Pakai:   bash scripts/backup-mysql.sh [/var/www/bisabayar]
# Crontab: 0 3 * * * bash /var/www/bisabayar/scripts/backup-mysql.sh >> /var/log/bisabayar-backup.log 2>&1
#
set -eu
DIR="${1:-/var/www/bisabayar}"
OUT="$DIR/backups"
RETENSI_HARI=7
STAMP=$(date +%Y%m%d-%H%M%S)
BERKAS="$OUT/bisabayar-$STAMP.sql.gz"

mkdir -p "$OUT"

# Hentikan lebih awal kalau disk sudah sesak — dump yang gagal di tengah jalan
# justru menghabiskan sisa ruang dan meninggalkan berkas rusak.
PAKAI=$(df --output=pcent "$DIR" | tail -1 | tr -dc '0-9')
if [ "$PAKAI" -ge 85 ]; then
  echo "[$STAMP] BATAL: disk terpakai ${PAKAI}%, ambang batas 85%."
  exit 1
fi

# shellcheck disable=SC1091
set -a; . "$DIR/.env"; set +a

docker exec bisabayar-mysql mysqldump \
  -u root -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --quick --routines --triggers \
  "$MYSQL_DATABASE" | gzip -c > "$BERKAS"

# Dump yang gagal tetap menghasilkan berkas gzip kecil. Periksa isinya, jangan
# cuma keberadaannya.
if [ "$(stat -c %s "$BERKAS")" -lt 10240 ]; then
  echo "[$STAMP] GAGAL: hasil dump mencurigakan kecil, dibuang."
  rm -f "$BERKAS"
  exit 1
fi

find "$OUT" -name 'bisabayar-*.sql.gz' -mtime "+$RETENSI_HARI" -delete

echo "[$STAMP] OK: $BERKAS ($(du -h "$BERKAS" | cut -f1)), sisa $(ls -1 "$OUT" | wc -l) berkas"
```

`--single-transaction` membuat dump konsisten tanpa mengunci tabel, jadi aman dijalankan selagi aplikasi melayani trafik.

- [ ] **Step 2: Uji terhadap tumpukan lokal**

```bash
cat > .env <<'EOF'
MYSQL_ROOT_PASSWORD=ujilokal-root
MYSQL_DATABASE=bisabayar
MYSQL_USER=bisabayar
MYSQL_PASSWORD=ujilokal-app
DATABASE_URL="mysql://bisabayar:ujilokal-app@bisabayar-mysql:3306/bisabayar"
SESSION_SECRET="uji-lokal-minimal-tiga-puluh-dua-karakter-ya"
APP_URL="http://127.0.0.1:3004"
EOF
docker compose up -d bisabayar-mysql
docker compose run --rm bisabayar-app node node_modules/prisma/build/index.js migrate deploy
bash scripts/backup-mysql.sh .
```

Harapan: baris `OK:` beserta nama berkas dan ukurannya.

- [ ] **Step 3: Buktikan dump-nya benar-benar berisi**

Backup yang tidak pernah diperiksa bukan backup.

```bash
zcat backups/bisabayar-*.sql.gz | grep -c 'CREATE TABLE'
```

Harapan: 28 — sesuai jumlah model di `prisma/schema.prisma`.

- [ ] **Step 4: Bersihkan**

```bash
docker compose down
rm -f .env
sudo rm -rf ./mysql-data ./backups
```

- [ ] **Step 5: Commit**

```bash
git status --short          # pastikan .env dan backups/ TIDAK muncul
git add scripts/backup-mysql.sh
git commit -m "feat(ops): skrip backup harian MySQL dengan retensi 7 hari

Berhenti lebih awal bila disk terpakai di atas 85%, dan menolak dump yang
hasilnya mencurigakan kecil — keduanya kegagalan yang tanpa pemeriksaan
baru ketahuan saat backup dibutuhkan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Dokumentasi deployment dan runbook cutover

**Files:**
- Replace: `docs/DEPLOYMENT.md` — **berkas yang ada sekarang adalah dokumen transaksikilat apa adanya dan belum pernah di-commit.** Timpa seluruhnya.
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Tambahkan variabel MySQL ke `.env.example`**

Sisipkan tepat setelah blok `DATABASE_URL` di bagian `═══ WAJIB ═══`:

```
# Dibaca service MySQL di docker-compose.yml saat inisialisasi PERTAMA saja.
# Mengubahnya setelah mysql-data terbentuk tidak berpengaruh — password harus
# diubah lewat SQL, bukan lewat berkas ini.
# Hanya relevan untuk deployment Docker; abaikan saat dev lokal.
MYSQL_ROOT_PASSWORD=""
MYSQL_DATABASE="bisabayar"
MYSQL_USER="bisabayar"
MYSQL_PASSWORD=""
```

- [ ] **Step 2: Abaikan artefak Docker di git**

Tambahkan di akhir `.gitignore`:

```
# artefak deployment Docker (ada di VPS, bukan di repo)
/mysql-data/
/uploads/
/backups/
```

- [ ] **Step 3: Tulis ulang `docs/DEPLOYMENT.md`**

```markdown
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

### 2. Persiapan (belum mengganggu produksi)

```bash
mkdir -p /var/www/bisabayar/{logs,uploads,backups}
cd /var/www/bisabayar
# salin docker-compose.yml dan scripts/ dari repo, lalu susun .env
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
```

`rsync`, bukan `mv` — berkas lama harus tetap di tempatnya sampai rollback tidak
lagi dibutuhkan.

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
zcat /var/www/bisabayar/backups/*.sql.gz | grep -c 'CREATE TABLE'   # harus 28
```

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

```bash
tail -f /var/www/bisabayar/logs/app.json | npx pino-pretty
grep -hE '"level":"(error|fatal)"' /var/www/bisabayar/logs/app.json | npx pino-pretty
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
4. `output: "standalone"` membuat image memuat 123M, bukan 741M.

Pemeriksaan berkala:

```bash
df -h /                 # <80% aman
docker system df
du -sh /var/www/bisabayar/{mysql-data,uploads,backups,logs}
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

**Container naik tapi `logs/app.json` tidak pernah ada.** `lib/logger.ts` memuat
`rotating-file-stream` lewat `require()` dinamis dan jatuh ke stdout bila gagal —
tanpa bersuara. Jalankan `bash scripts/check-standalone.sh` setelah build; kalau
paket itu hilang, salin eksplisit di `Dockerfile`.

**Container gagal start dengan `Konfigurasi lingkungan tidak lengkap`.** Ini
disengaja: `SESSION_SECRET` (minimal 32 karakter) dan `DATABASE_URL` divalidasi
saat boot. Lebih baik gagal keras daripada menyala setengah jalan.

**`docker compose up` bilang MySQL unhealthy.** Inisialisasi pertama memakan
waktu; `start_period` sudah 60 detik. Periksa `docker compose logs
bisabayar-mysql`. Kalau ada keluhan izin akses pada `/var/lib/mysql`, periksa
kepemilikan `./mysql-data` di host.
```

- [ ] **Step 4: Rujuk dari README**

Di `README.md`, ganti seluruh bagian `## Deploy` beserta blok perintahnya dengan:

```markdown
## Deploy

Berjalan di Docker: image dibangun di laptop, di-push ke GHCR, VPS hanya
`docker compose pull` + `up -d`. Langkah lengkap, cutover, dan rollback ada di
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
```

Tambahkan juga satu baris di tabel Dokumentasi:

```markdown
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build image, deploy, cutover, rollback |
```

- [ ] **Step 5: Periksa tidak ada sisa rujukan transaksikilat**

```bash
grep -rn 'transaksikilat' docs/ README.md || echo "bersih — tidak ada sisa rujukan"
```

Harapan: `bersih`. Kalau masih ada, berarti dokumen transaksikilat belum sepenuhnya tertimpa.

- [ ] **Step 6: Commit**

```bash
git add docs/DEPLOYMENT.md .env.example .gitignore README.md
git commit -m "docs: runbook deployment Docker untuk bisabayar

Menimpa dokumen transaksikilat yang sempat disalin ke sini. Tiga hal sengaja
berbeda dan disebut eksplisit supaya tidak 'diperbaiki' kembali nanti: tanpa
crontab rekonsiliasi, tanpa logrotate, dan tanpa build arg.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verifikasi akhir

- [ ] **Jalankan semuanya dari keadaan bersih**

```bash
rm -rf .next
npm run build
bash scripts/check-standalone.sh
npm run verify
docker build -t bisabayar:uji .
npx tsc --noEmit
git status --short
```

Harapan: penjaga standalone lulus, `verify` hijau (79 test), image terbangun,
`tsc` bersih, dan `git status` kosong — tidak ada `.env`, `mysql-data/`,
`uploads/`, atau `backups/` yang tertinggal.

- [ ] **Periksa apa yang berubah**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Harapan: 6 commit. Berkas baru: `Dockerfile`, `.dockerignore`,
`docker-compose.yml`, `.github/workflows/build-and-push.yml`, tiga skrip di
`scripts/`, `docs/DEPLOYMENT.md`. Berkas yang diubah: `next.config.ts`,
`package.json`, `.env.example`, `.gitignore`, `README.md`.

---

## Catatan untuk pelaksana

1. **`.env` di repo hanya untuk uji lokal dan wajib dihapus.** Next.js ikut membacanya, jadi `.env` yang tertinggal membuat `npm run dev` memakai `DATABASE_URL` yang menunjuk hostname compose dan gagal menyambung. Task 3 dan Task 5 sama-sama membuat lalu menghapusnya.

2. **Jangan menaikkan jumlah replika aplikasi.** Pembatas laju in-memory dan sapuan rekonsiliasi in-process keduanya mengandaikan satu proses. Dua replika berarti batas laju dua kali lipat dan dua sapuan menembak provider yang sama.

3. **`prisma generate` harus berjalan di dalam stage alpine.** `schema.prisma` tidak menyetel `binaryTargets`, jadi engine mengikuti platform tempat generate dijalankan. Generate di luar lalu salin ke alpine menghasilkan kegagalan runtime yang pesannya menyesatkan.

4. **Rencana ini tidak menyentuh VPS.** Seluruh task dikerjakan dan diuji di laptop. Cutover adalah kegiatan operasional terpisah yang dijalankan manusia mengikuti runbook di Task 6 — jangan mencoba mengotomatiskannya.

5. **Task 3 Step 6 adalah inti dari seluruh urusan volume.** Kalau data tidak bertahan melewati `down` lalu `up`, jangan lanjut ke task berikutnya. Cutover akan kehilangan data.
