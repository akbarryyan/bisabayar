/**
 * Validasi unggahan gambar.
 *
 * `/api/upload` terbuka untuk SETIAP pengguna yang login, dan berkasnya ditulis
 * ke disk server. Yang berdiri di antara pengguna dan disk hanyalah dua
 * pemeriksaan di `saveUploadedImage`: jenis berkas dan ukurannya. Nol test
 * sebelum berkas ini.
 *
 * Perlu diketahui dan memang belum diperbaiki: jenis berkas ditentukan dari
 * `file.type`, yang dikirim KLIEN — bukan dari isi berkasnya. Jadi berkas apa
 * pun yang mengaku `image/png` akan diterima. Test di bawah mengunci perilaku
 * yang ada sekarang, termasuk batasnya; memperbaikinya butuh pemeriksaan
 * magic-byte dan itu perubahan tersendiri.
 */
import { afterEach, describe, expect, it } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { saveUploadedImage, UploadError, imageRefSchema, UPLOAD_FOLDERS } from "@/lib/upload";

const dibuat: string[] = [];

afterEach(() => {
  for (const url of dibuat) {
    const p = join(process.cwd(), "public", url.replace(/^\//, ""));
    if (existsSync(p)) rmSync(p);
  }
  dibuat.length = 0;
});

const berkas = (tipe: string, ukuran = 1_024) =>
  new File([new Uint8Array(ukuran)], "contoh", { type: tipe });

describe("jenis berkas yang ditolak", () => {
  it("menolak PDF, HTML, dan skrip", async () => {
    for (const tipe of ["application/pdf", "text/html", "application/javascript", "text/plain"]) {
      await expect(saveUploadedImage(berkas(tipe), "banners")).rejects.toBeInstanceOf(UploadError);
    }
  });

  it("menolak SVG", async () => {
    // SVG bisa memuat <script>. Kalau suatu saat ia dimasukkan ke daftar yang
    // diizinkan, berkas yang diunggah pengguna menjadi jalur XSS yang disajikan
    // dari domain kita sendiri.
    await expect(saveUploadedImage(berkas("image/svg+xml"), "banners")).rejects.toBeInstanceOf(UploadError);
  });

  it("menolak jenis kosong", async () => {
    await expect(saveUploadedImage(berkas(""), "banners")).rejects.toBeInstanceOf(UploadError);
  });

  it("penolakannya memakai status 400, bukan 500", async () => {
    await saveUploadedImage(berkas("application/pdf"), "banners").catch((e: UploadError) => {
      expect(e.status).toBe(400);
    });
  });
});

describe("batas ukuran", () => {
  const MAKS = 5 * 1024 * 1024;

  it("menerima berkas tepat di batas", async () => {
    const url = await saveUploadedImage(berkas("image/png", MAKS), "banners");
    dibuat.push(url);
    expect(url).toMatch(/^\/uploads\/banners\/.+\.png$/);
  });

  it("menolak satu byte di atas batas", async () => {
    await expect(saveUploadedImage(berkas("image/png", MAKS + 1), "banners")).rejects.toBeInstanceOf(UploadError);
  });
});

describe("jenis yang diterima dan pemetaan ekstensinya", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ])("%s disimpan sebagai .%s", async (tipe, ekstensi) => {
    const url = await saveUploadedImage(berkas(tipe), "banners");
    dibuat.push(url);
    expect(url.endsWith(`.${ekstensi}`)).toBe(true);
  });

  it("nama berkas diacak, tidak memakai nama kiriman pengguna", async () => {
    // Nama dari pengguna tidak boleh menentukan nama di disk — di situlah
    // path traversal dan penimpaan berkas orang lain bermula.
    const a = await saveUploadedImage(new File([new Uint8Array(8)], "../../etc/passwd", { type: "image/png" }), "banners");
    const b = await saveUploadedImage(new File([new Uint8Array(8)], "../../etc/passwd", { type: "image/png" }), "banners");
    dibuat.push(a, b);

    expect(a).not.toBe(b);
    expect(a).not.toContain("passwd");
    expect(a).not.toContain("..");
    expect(a).toMatch(/^\/uploads\/banners\/[0-9a-f-]{36}\.png$/);
  });
});

describe("daftar folder tujuan", () => {
  it("tetap seperti yang diketahui route /api/upload", () => {
    // Menambah folder di sini tanpa memperbarui ADMIN_ONLY_FOLDERS di
    // app/api/upload/route.ts berarti folder baru itu terbuka untuk setiap
    // member, bukan hanya admin.
    expect([...UPLOAD_FOLDERS]).toEqual([
      "promos", "brands", "banners", "payment-methods", "sellers", "site", "footer",
    ]);
  });
});

describe("imageRefSchema", () => {
  it("menerima URL absolut dan path unggahan lokal", () => {
    expect(imageRefSchema.safeParse("https://i.ibb.co.com/x.png").success).toBe(true);
    expect(imageRefSchema.safeParse("http://contoh.test/x.png").success).toBe(true);
    expect(imageRefSchema.safeParse("/uploads/banners/x.png").success).toBe(true);
  });

  it("menolak path lain dan skema berbahaya", () => {
    expect(imageRefSchema.safeParse("/etc/passwd").success).toBe(false);
    expect(imageRefSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(imageRefSchema.safeParse("uploads/tanpa-garis-miring.png").success).toBe(false);
    expect(imageRefSchema.safeParse("").success).toBe(false);
  });
});
