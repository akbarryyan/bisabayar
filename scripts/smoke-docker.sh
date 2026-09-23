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
# Pakai:  bash scripts/smoke-docker.sh [http://127.0.0.1:3005] [/var/www/bisabayar]
#
set -u
BASE="${1:-http://127.0.0.1:3005}"
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
# Dibaca DARI DALAM container. Logger membuat app.json dengan mode 0640 milik
# uid 1001, jadi user host biasa tidak bisa membacanya — `grep` dari host akan
# menjawab "Permission denied" dan itu bukan pertanda logging rusak.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx bisabayar-app; then
  if docker exec bisabayar-app sh -c 'test -s /app/logs/app.json' 2>/dev/null; then
    echo "  ok      /app/logs/app.json ada dan tidak kosong"
    pass=$((pass+1))
    if docker exec bisabayar-app sh -c 'grep -q "\"msg\":\"server-start\"" /app/logs/app.json' 2>/dev/null; then
      echo "  ok      baris server-start ditemukan"
      pass=$((pass+1))
    else
      echo "  GAGAL   baris server-start tidak ada — logger mungkin jatuh ke stdout"
      fail=$((fail+1))
    fi
  else
    echo "  GAGAL   /app/logs/app.json tidak ada atau kosong"
    echo "          Dua sebab yang paling sering: rotating-file-stream tidak ikut ke"
    echo "          image, atau container tidak punya izin menulis ke volume logs."
    echo "          Perbaiki izin:  docker compose exec -u root bisabayar-app \\"
    echo "                            chown -R nextjs:nodejs /app/logs /app/public/uploads"
    fail=$((fail+1))
  fi
else
  echo "  LEWAT   container bisabayar-app tidak berjalan; pemeriksaan log dilewati"
fi

echo
echo "Volume uploads bisa ditulis OLEH CONTAINER:"
# Keberadaan direktori di host TIDAK cukup diperiksa. Bind mount menimpa
# direktori di dalam image beserta kepemilikannya, jadi direktori yang ada dan
# terlihat normal di host tetap tidak bisa ditulis oleh uid 1001 di dalam
# container. Unggahan lalu gagal di produksi sementara test ini hijau.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx bisabayar-app; then
  if docker exec bisabayar-app sh -c 'touch /app/public/uploads/.smoke && rm /app/public/uploads/.smoke' 2>/dev/null; then
    echo "  ok      container bisa menulis ke /app/public/uploads"
    pass=$((pass+1))
  else
    echo "  GAGAL   container TIDAK bisa menulis ke /app/public/uploads"
    echo "          Perbaiki kepemilikan di host:  sudo chown -R 1001:1001 $DIR/uploads $DIR/logs"
    fail=$((fail+1))
  fi
else
  echo "  LEWAT   container bisabayar-app tidak berjalan; pemeriksaan tulis dilewati"
fi

echo
echo "lulus=$pass gagal=$fail"
[ "$fail" -eq 0 ] || exit 1
