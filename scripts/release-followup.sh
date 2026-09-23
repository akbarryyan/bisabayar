#!/usr/bin/env bash
#
# Menentukan langkah tambahan apa yang diperlukan di VPS untuk sebuah rilis,
# dengan membandingkan rilis sebelumnya terhadap HEAD.
#
# Dipisahkan dari release.sh supaya bisa diuji sendiri: ini satu-satunya bagian
# yang punya logika, sisanya hanya urutan perintah.
#
# Kenapa ini ada: kode aplikasi hidup DI DALAM image, jadi rilis biasa cukup
# `docker compose pull && up -d` di VPS. Tapi tiga hal TIDAK ikut ke image dan
# karenanya butuh langkah tambahan yang mudah terlupakan:
#
#   MIGRATION  prisma/migrations/  → `migrate deploy` sebelum `up -d`
#   COMPOSE    docker-compose.yml  → `git pull` di VPS, kalau tidak konfigurasi
#                                     lama yang dipakai
#   SCRIPTS    scripts/            → `git pull` di VPS, kalau tidak smoke test
#                                     dan backup memakai versi lama
#
# Pakai:  bash scripts/release-followup.sh <sha-sebelumnya> [sha-sekarang]
#
# Mencetak satu kata kunci per baris untuk tiap kategori yang berubah. Keluaran
# kosong berarti `pull` + `up -d` saja sudah cukup.
#
set -euo pipefail

SEBELUM="${1:-}"
SEKARANG="${2:-HEAD}"

[ -n "$SEBELUM" ] || { echo "pemakaian: $0 <sha-sebelumnya> [sha-sekarang]" >&2; exit 2; }

# Sha yang tidak dikenal bukan kesalahan: bisa jadi riwayatnya di-rebase, atau
# ini rilis pertama sejak catatan dibuat. Yang benar adalah diam dan biarkan
# pemanggil memberi tahu bahwa pemeriksaan tidak bisa dilakukan.
git rev-parse --verify --quiet "$SEBELUM^{commit}" >/dev/null || exit 3

berubah() {
  [ -n "$(git diff --name-only "$SEBELUM..$SEKARANG" -- "$@")" ]
}

berubah prisma/migrations && echo MIGRATION
berubah docker-compose.yml && echo COMPOSE
berubah scripts && echo SCRIPTS

exit 0
