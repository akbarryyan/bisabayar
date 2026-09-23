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
