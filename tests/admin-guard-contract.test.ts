/**
 * Kontrak guard route admin — konstitusi §9.1.
 *
 * Aturannya mekanis, tidak butuh penilaian per route:
 *
 *   GET                          → requireAdmin()          percaya seal, 0 query
 *   POST/PUT/PATCH/DELETE        → requireAdminVerified()  +1 query cek isActive & role
 *
 * Mutasi perlu cek database karena `role` di cookie hanya snapshot saat login
 * dan seal-nya sah sampai 14 hari — admin yang di-demote masih akan lolos
 * selama itu kalau kita hanya percaya cookie.
 *
 * Guard juga harus menjadi statement PERTAMA, di luar blok try, supaya
 * penolakan tidak tertelan catch lalu berubah menjadi 500.
 *
 * Test ini membaca berkas route secara statis, bukan menjalankan servernya.
 * Tujuannya menangkap route admin BARU yang lupa diberi guard — kelas kesalahan
 * yang tidak akan terlihat sampai ada yang menyalahgunakannya.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ADMIN_API = "app/api/admin";

/**
 * Satu-satunya route admin tanpa guard, dan memang harus begitu: ini endpoint
 * login admin (POST) sekaligus endpoint verifikasi yang dipanggil
 * hooks/useAdminAuth.ts (GET). Memberinya guard berarti tidak ada seorang pun
 * yang bisa login lagi.
 */
const DIKECUALIKAN = new Set(["auth/route.ts"]);

const MUTASI = ["POST", "PUT", "PATCH", "DELETE"];

function cariRoute(dir: string, hasil: string[] = []): string[] {
  for (const entri of readdirSync(dir)) {
    const p = join(dir, entri);
    if (statSync(p).isDirectory()) cariRoute(p, hasil);
    else if (entri === "route.ts") hasil.push(p);
  }
  return hasil;
}

/** Potong berkas menjadi per-handler supaya guard diperiksa dalam lingkupnya sendiri. */
function pecahPerHandler(isi: string): Array<{ method: string; badan: string }> {
  const penanda = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  const titik: Array<{ method: string; mulai: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = penanda.exec(isi)) !== null) {
    titik.push({ method: m[1], mulai: m.index });
  }
  return titik.map((t, i) => ({
    method: t.method,
    badan: isi.slice(t.mulai, titik[i + 1]?.mulai ?? isi.length),
  }));
}

const berkas = cariRoute(ADMIN_API).sort();
const relatif = (p: string) => p.slice(ADMIN_API.length + 1);

describe("kontrak guard route admin", () => {
  it("menemukan route admin untuk diperiksa", () => {
    // Penjaga terhadap test yang diam-diam tidak menguji apa pun: kalau pola
    // pencarian berkasnya rusak, daftarnya kosong dan semua test di bawah lulus
    // tanpa memeriksa satu berkas pun.
    expect(berkas.length).toBeGreaterThan(40);
  });

  it("SETIAP route admin memanggil guard", () => {
    const tanpaGuard = berkas
      .filter((f) => !DIKECUALIKAN.has(relatif(f)))
      .filter((f) => !/requireAdmin(Verified)?\s*\(/.test(readFileSync(f, "utf8")))
      .map(relatif);

    expect(tanpaGuard).toEqual([]);
  });

  it("handler yang MENGUBAH data memakai requireAdminVerified", () => {
    const salah: string[] = [];

    for (const f of berkas) {
      if (DIKECUALIKAN.has(relatif(f))) continue;
      const isi = readFileSync(f, "utf8");

      for (const { method, badan } of pecahPerHandler(isi)) {
        if (!MUTASI.includes(method)) continue;
        if (!/requireAdminVerified\s*\(/.test(badan)) {
          salah.push(`${relatif(f)} → ${method}`);
        }
      }
    }

    expect(salah).toEqual([]);
  });

  it("guard dipanggil SEBELUM blok try, bukan di dalamnya", () => {
    const salah: string[] = [];

    for (const f of berkas) {
      if (DIKECUALIKAN.has(relatif(f))) continue;

      for (const { method, badan } of pecahPerHandler(readFileSync(f, "utf8"))) {
        const posisiGuard = badan.search(/requireAdmin(Verified)?\s*\(/);
        if (posisiGuard === -1) continue;

        const posisiTry = badan.search(/\btry\s*\{/);
        if (posisiTry !== -1 && posisiTry < posisiGuard) {
          salah.push(`${relatif(f)} → ${method}`);
        }
      }
    }

    expect(salah).toEqual([]);
  });
});
