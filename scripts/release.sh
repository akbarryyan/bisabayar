#!/usr/bin/env bash
#
# Rilis: gate → build → push, dalam satu perintah.
#
# Alasan berkas ini ada: build dan test sebagai dua perintah terpisah berarti
# melewatkan salah satunya MUNGKIN dilakukan — dan yang paling sering dilewati
# justru rilis yang terasa sepele. Digabung jadi satu, melewatkannya bukan lagi
# soal disiplin melainkan tidak bisa.
#
# Konsekuensinya: setiap image yang ada di GHCR pasti dibangun dari kode yang
# test-nya hijau. Itu jaminan yang tidak bisa diberikan gate manual.
#
# Pakai:  npm run release
#         npm run release -- --no-push     bangun saja, jangan dorong ke GHCR
#         npm run release -- --allow-dirty  izinkan working tree kotor
#
set -euo pipefail

IMAGE="ghcr.io/akbarryyan/bisabayar"
CATATAN=".release-log"
BOLEH_KOTOR=0
DORONG=1

for arg in "$@"; do
  case "$arg" in
    --no-push)     DORONG=0 ;;
    --allow-dirty) BOLEH_KOTOR=1 ;;
    *) echo "Argumen tidak dikenal: $arg"; exit 2 ;;
  esac
done

batal() { echo; echo "BATAL: $1"; exit 1; }

# Akar repo ditentukan oleh git, bukan oleh letak skrip ini. Dengan begitu skrip
# tetap benar dari mana pun ia dipanggil.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
  || batal "tidak dijalankan dari dalam repo git."
cd "$ROOT"

# ── 1. Keadaan repo ─────────────────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || batal "sedang di branch '$BRANCH', bukan main."

if [ "$BOLEH_KOTOR" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  git status --short
  batal "ada perubahan yang belum di-commit. Image akan ditandai dengan sha
       commit terakhir, jadi isinya TIDAK cocok dengan tag-nya — dan rollback
       ke tag itu nanti mengembalikan kode yang berbeda dari yang dirilis.
       Commit dulu, atau pakai --allow-dirty kalau memang disengaja."
fi

echo "==> Mengambil perubahan terbaru"
git pull --ff-only origin main

SHA=$(git rev-parse --short HEAD)
echo "    sha: $SHA"

# ── 2. Gate — tidak ada yang dibangun kalau ini merah ───────────────────────
echo
echo "==> Menyiapkan database uji"
npm run test:db:up >/dev/null
docker exec whuz-test-mysql mysqladmin ping -uroot -ptestpass --wait=60 --silent >/dev/null 2>&1 \
  || batal "database uji tidak siap."
npm run test:db:push >/dev/null

echo "==> Gate: typecheck + seluruh test"
npm run verify || batal "gate merah. Tidak ada image yang dibangun."

# ── 3. Build ────────────────────────────────────────────────────────────────
echo
echo "==> Membangun image"
# Dua tag, selalu. Tanpa tag sha, rollback tidak punya sasaran.
docker build -t "$IMAGE:latest" -t "$IMAGE:$SHA" .

echo "==> Memeriksa isi image"
docker run --rm --entrypoint sh "$IMAGE:$SHA" -c \
  'ls server.js >/dev/null && ls node_modules/prisma/build/index.js >/dev/null \
   && ls -d node_modules/rotating-file-stream >/dev/null && ls -d prisma/migrations >/dev/null' \
  || batal "isi image tidak lengkap. Periksa Dockerfile."

UKURAN=$(docker images "$IMAGE:$SHA" --format '{{.Size}}')
echo "    ukuran: $UKURAN"

if [ "$DORONG" -eq 0 ]; then
  echo
  echo "Selesai tanpa push (--no-push). Image lokal: $IMAGE:$SHA"
  exit 0
fi

# ── 4. Push ─────────────────────────────────────────────────────────────────
echo
echo "==> Mendorong ke GHCR"
docker push "$IMAGE:latest"
docker push "$IMAGE:$SHA"

# ── 5. Catat, lalu beri tahu langkah di VPS ─────────────────────────────────
SHA_SEBELUMNYA=$(tail -1 "$CATATAN" 2>/dev/null | awk '{print $2}' || true)
printf '%s %s %s\n' "$(date -Iseconds)" "$SHA" "$UKURAN" >> "$CATATAN"

# Kategori apa saja yang berubah sejak rilis terakhir. Kode aplikasi hidup di
# DALAM image, jadi rilis biasa cukup pull + up -d di VPS — tetapi migration,
# docker-compose.yml, dan scripts/ tidak ikut ke image dan butuh langkah
# tambahan yang paling mudah terlupakan justru saat rilis terasa sepele.
PERUBAHAN=""
TIDAK_BISA_DIPERIKSA=0
if [ -n "$SHA_SEBELUMNYA" ]; then
  PERUBAHAN=$(bash scripts/release-followup.sh "$SHA_SEBELUMNYA" HEAD) || TIDAK_BISA_DIPERIKSA=1
else
  TIDAK_BISA_DIPERIKSA=1
fi

punya() { printf '%s\n' "$PERUBAHAN" | grep -qx "$1"; }

PERLU_GIT_PULL=0
punya COMPOSE && PERLU_GIT_PULL=1
punya SCRIPTS && PERLU_GIT_PULL=1

echo
echo "─────────────────────────────────────────────────────────────"
echo " Terdorong: $IMAGE:$SHA"
echo
echo " Langkah di VPS:"
echo
echo "   ssh <user>@<vps-host>"
echo "   cd /var/www/bisabayar"
if [ "$PERLU_GIT_PULL" -eq 1 ]; then
  ALASAN=""
  punya COMPOSE && ALASAN="docker-compose.yml"
  punya SCRIPTS && ALASAN="${ALASAN:+$ALASAN dan }scripts/"
  echo "   git pull origin main          # WAJIB: $ALASAN berubah di rilis ini"
fi
echo "   docker compose pull"
if punya MIGRATION; then
  echo "   docker compose run --rm bisabayar-app \\"
  echo "     node node_modules/prisma/build/index.js migrate deploy   # RILIS INI ADA MIGRATION"
fi
echo "   docker compose up -d"
echo "   docker image prune -af"
echo "   bash scripts/smoke-docker.sh http://127.0.0.1:3005 /var/www/bisabayar"

if [ "$TIDAK_BISA_DIPERIKSA" -eq 1 ]; then
  echo
  echo " Catatan: rilis sebelumnya tidak diketahui, jadi migration, compose,"
  echo " dan scripts TIDAK diperiksa otomatis. Periksa sendiri terhadap sha"
  echo " yang benar-benar terpasang di VPS:"
  echo
  echo "   git diff --name-only <sha-di-vps>..HEAD -- prisma/migrations docker-compose.yml scripts"
fi
echo "─────────────────────────────────────────────────────────────"
