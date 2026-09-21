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
# pipefail WAJIB: tanpa itu, mysqldump yang gagal tetap menghasilkan exit code 0
# karena gzip di ujung pipeline berhasil, dan berkas terpotong lolos sebagai sukses.
set -euo pipefail
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

# Yang membuktikan dump utuh adalah penanda akhir yang ditulis mysqldump, BUKAN
# ukuran berkas. Dump skema database kosong hanya ~6KB setelah gzip, jadi ambang
# ukuran akan menolak backup yang sebenarnya sempurna. Dump yang terpotong di
# tengah jalan tidak akan punya baris ini.
if ! zcat "$BERKAS" | tail -5 | grep -q -- '-- Dump completed'; then
  echo "[$STAMP] GAGAL: dump tidak memuat penanda '-- Dump completed', kemungkinan terpotong. Dibuang."
  rm -f "$BERKAS"
  exit 1
fi

find "$OUT" -name 'bisabayar-*.sql.gz' -mtime "+$RETENSI_HARI" -delete

echo "[$STAMP] OK: $BERKAS ($(du -h "$BERKAS" | cut -f1)), sisa $(ls -1 "$OUT" | wc -l) berkas"
