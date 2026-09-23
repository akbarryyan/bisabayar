/**
 * Deteksi langkah tambahan saat rilis.
 *
 * Kode aplikasi hidup DI DALAM image, jadi rilis biasa cukup `docker compose
 * pull && up -d` di VPS. Tiga hal tidak ikut ke image dan butuh langkah
 * tambahan:
 *
 *   prisma/migrations/   → `migrate deploy` sebelum `up -d`
 *   docker-compose.yml   → `git pull` di VPS
 *   scripts/             → `git pull` di VPS
 *
 * Kalau terlewat, deploy-nya gagal secara SENYAP: container naik memakai
 * konfigurasi lama, atau naik sebelum tabelnya ada. Keduanya tidak menampilkan
 * kesalahan apa pun di layar.
 *
 * Diuji terhadap repo git sungguhan yang dibuat sementara — bukan tiruan git.
 * Yang ingin dibuktikan adalah pembacaan riwayat, dan riwayat tiruan tidak
 * membuktikan apa pun tentang perilaku git.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SKRIP = resolve("scripts/release-followup.sh");
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function tulis(relatif: string, isi: string) {
  const penuh = join(repo, relatif);
  mkdirSync(join(penuh, ".."), { recursive: true });
  writeFileSync(penuh, isi);
}

function commit(pesan: string): string {
  git("add", "-A");
  git("-c", "user.email=uji@contoh.test", "-c", "user.name=Uji", "commit", "-m", pesan);
  return git("rev-parse", "--short", "HEAD");
}

/** Jalankan helper; kembalikan daftar kata kunci, atau null bila sha tak dikenal. */
function deteksi(shaSebelum: string): string[] | null {
  try {
    const keluaran = execFileSync("bash", [SKRIP, shaSebelum], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    return keluaran === "" ? [] : keluaran.split("\n");
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 3) return null; // sha tidak dikenal
    throw err;
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rilis-uji-"));
  git("init", "-q");
  tulis("README.md", "awal\n");
  tulis("docker-compose.yml", "services: {}\n");
  tulis("scripts/smoke.sh", "echo halo\n");
  tulis("prisma/migrations/001_awal/migration.sql", "SELECT 1;\n");
  commit("awal");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("tidak ada yang perlu dilakukan", () => {
  it("perubahan kode aplikasi saja tidak menghasilkan apa pun", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("app/page.tsx", "export default function P() { return null }\n");
    commit("ubah halaman");

    expect(deteksi(dasar)).toEqual([]);
  });

  it("tidak ada commit baru sama sekali juga kosong", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    expect(deteksi(dasar)).toEqual([]);
  });
});

describe("mendeteksi tiap kategori", () => {
  it("migration baru → MIGRATION", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("prisma/migrations/002_tambah/migration.sql", "ALTER TABLE x ADD y INT;\n");
    commit("tambah migration");

    expect(deteksi(dasar)).toEqual(["MIGRATION"]);
  });

  it("docker-compose.yml berubah → COMPOSE", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("docker-compose.yml", "services:\n  app:\n    ports: ['3005:3000']\n");
    commit("ubah port");

    expect(deteksi(dasar)).toEqual(["COMPOSE"]);
  });

  it("berkas di scripts/ berubah → SCRIPTS", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("scripts/smoke.sh", "echo halo dunia\n");
    commit("ubah smoke test");

    expect(deteksi(dasar)).toEqual(["SCRIPTS"]);
  });

  it("skrip BARU di scripts/ juga terdeteksi, bukan cuma yang diubah", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("scripts/backup.sh", "echo backup\n");
    commit("tambah skrip backup");

    expect(deteksi(dasar)).toEqual(["SCRIPTS"]);
  });
});

describe("beberapa kategori sekaligus", () => {
  it("melaporkan semuanya, bukan berhenti di yang pertama", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("prisma/migrations/003_lagi/migration.sql", "ALTER TABLE a ADD b INT;\n");
    tulis("docker-compose.yml", "services:\n  app:\n    image: baru\n");
    tulis("scripts/smoke.sh", "echo berubah\n");
    tulis("app/page.tsx", "export default function P() { return null }\n");
    commit("perubahan besar");

    expect(deteksi(dasar)).toEqual(["MIGRATION", "COMPOSE", "SCRIPTS"]);
  });

  it("menjangkau beberapa commit, bukan hanya yang terakhir", () => {
    const dasar = git("rev-parse", "--short", "HEAD");
    tulis("prisma/migrations/004_a/migration.sql", "SELECT 1;\n");
    commit("migration");
    tulis("app/page.tsx", "export default function P() { return null }\n");
    commit("halaman");
    tulis("README.md", "terakhir\n");
    commit("readme");

    // Migration ada di commit tiga langkah ke belakang. Kalau pembandingnya
    // hanya commit terakhir, ini akan lolos tanpa terdeteksi — dan rilisnya
    // naik tanpa `migrate deploy`.
    expect(deteksi(dasar)).toEqual(["MIGRATION"]);
  });
});

describe("sha yang tidak dikenal", () => {
  it("tidak melaporkan apa pun, dan tidak berpura-pura kosong", () => {
    // Riwayat yang di-rebase atau catatan rilis dari mesin lain. Membedakan
    // "tidak ada yang berubah" dari "tidak bisa diperiksa" itu penting:
    // yang pertama aman dilanjutkan, yang kedua harus diperiksa manusia.
    expect(deteksi("0000000")).toBeNull();
  });
});
