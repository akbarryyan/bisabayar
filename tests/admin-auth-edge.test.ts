/**
 * Guard admin di Edge runtime — lapis kedua untuk seluruh /admin dan /api/admin.
 *
 * `middleware.ts` tidak bisa menyentuh Prisma, jadi ia hanya bisa membaca
 * cookie. Seluruh keputusannya ada di dua fungsi ini, dan sebelum berkas ini,
 * keduanya nol test.
 *
 * Yang paling penting dikunci adalah perilaku GAGAL-TERTUTUP: setiap keadaan
 * yang tidak bisa dipastikan harus berakhir `anonymous`, bukan diloloskan.
 * Kesalahan ke arah sebaliknya membuka seluruh panel admin, dan tidak akan
 * terlihat dari luar — halamannya terbuka, seolah memang boleh.
 */
import { describe, expect, it } from "vitest";
import { sealData } from "iron-session";
import {
  verdictFromSession,
  verdictFromSeal,
  ADMIN_DENY,
  ADMIN_ROLE,
} from "@/lib/admin-auth-edge";

const RAHASIA = "rahasia-uji-minimal-tiga-puluh-dua-karakter";

const adminSah = {
  isLoggedIn: true, userId: "u1", role: ADMIN_ROLE,
  email: "admin@contoh.test", name: "Admin",
};

describe("verdictFromSession — keputusan murni", () => {
  it("meloloskan admin yang lengkap", () => {
    expect(verdictFromSession(adminSah)).toEqual({
      kind: "ok", userId: "u1", role: "ADMIN",
      email: "admin@contoh.test", name: "Admin",
    });
  });

  it("member ditolak sebagai forbidden, bukan anonymous", () => {
    // Bedanya penting: 403 berarti "kamu login tapi bukan admin", 401 berarti
    // "silakan login". Menyamakannya membuat member dilempar ke halaman login
    // berulang-ulang padahal sesinya sah.
    expect(verdictFromSession({ ...adminSah, role: "MEMBER" })).toEqual({ kind: "forbidden" });
  });

  it("sesi tanpa data sama sekali → anonymous", () => {
    expect(verdictFromSession(null)).toEqual({ kind: "anonymous" });
    expect(verdictFromSession(undefined)).toEqual({ kind: "anonymous" });
    expect(verdictFromSession({})).toEqual({ kind: "anonymous" });
  });

  it("isLoggedIn palsu → anonymous", () => {
    expect(verdictFromSession({ ...adminSah, isLoggedIn: false })).toEqual({ kind: "anonymous" });
  });

  it("isLoggedIn true TANPA userId → anonymous", () => {
    // Bukan kasus rekaan: seal cacat berisi isLoggedIn:true tanpa userId pernah
    // membuat senderId terisi null di app/api/admin/tickets/[id].
    expect(verdictFromSession({ isLoggedIn: true, role: ADMIN_ROLE })).toEqual({ kind: "anonymous" });
    expect(verdictFromSession({ isLoggedIn: true, userId: "", role: ADMIN_ROLE })).toEqual({ kind: "anonymous" });
  });

  it("peran tanpa nilai → forbidden", () => {
    expect(verdictFromSession({ isLoggedIn: true, userId: "u1" })).toEqual({ kind: "forbidden" });
  });

  it("peran peka huruf besar-kecil — 'admin' huruf kecil BUKAN admin", () => {
    expect(verdictFromSession({ ...adminSah, role: "admin" })).toEqual({ kind: "forbidden" });
  });

  it("email dan nama yang kosong tidak menggagalkan, hanya jadi string kosong", () => {
    const hasil = verdictFromSession({ isLoggedIn: true, userId: "u1", role: ADMIN_ROLE });
    expect(hasil).toEqual({ kind: "ok", userId: "u1", role: "ADMIN", email: "", name: "" });
  });
});

describe("verdictFromSeal — gagal-tertutup", () => {
  const dengan = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const asli = process.env.SESSION_SECRET;
    if (env.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = env.SESSION_SECRET;
    try { await fn(); } finally {
      if (asli === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = asli;
    }
  };

  it("membuka seal admin yang sah", async () => {
    await dengan({ SESSION_SECRET: RAHASIA }, async () => {
      const seal = await sealData(adminSah, { password: RAHASIA });
      expect(await verdictFromSeal(seal)).toMatchObject({ kind: "ok", userId: "u1" });
    });
  });

  it("seal member → forbidden", async () => {
    await dengan({ SESSION_SECRET: RAHASIA }, async () => {
      const seal = await sealData({ ...adminSah, role: "MEMBER" }, { password: RAHASIA });
      expect(await verdictFromSeal(seal)).toEqual({ kind: "forbidden" });
    });
  });

  it("tanpa seal → anonymous", async () => {
    await dengan({ SESSION_SECRET: RAHASIA }, async () => {
      expect(await verdictFromSeal(undefined)).toEqual({ kind: "anonymous" });
      expect(await verdictFromSeal("")).toEqual({ kind: "anonymous" });
    });
  });

  it("seal ngawur → anonymous, tidak melempar", async () => {
    // Melempar di middleware berarti 500 untuk SELURUH situs, termasuk
    // halaman depan dan checkout — matcher-nya mencakup hampir semua path.
    await dengan({ SESSION_SECRET: RAHASIA }, async () => {
      expect(await verdictFromSeal("bukan-seal-sama-sekali")).toEqual({ kind: "anonymous" });
    });
  });

  it("seal dari SESSION_SECRET LAIN → anonymous", async () => {
    // Inilah yang membuat rotasi rahasia benar-benar mencabut akses: seal lama
    // tidak boleh masih diterima setelah rahasianya diganti.
    const seal = await sealData(adminSah, { password: "rahasia-lama-yang-juga-tiga-puluh-dua-karakter" });
    await dengan({ SESSION_SECRET: RAHASIA }, async () => {
      expect(await verdictFromSeal(seal)).toEqual({ kind: "anonymous" });
    });
  });

  it("SESSION_SECRET kosong atau terlalu pendek → anonymous", async () => {
    const seal = await sealData(adminSah, { password: RAHASIA });

    await dengan({ SESSION_SECRET: undefined }, async () => {
      expect(await verdictFromSeal(seal)).toEqual({ kind: "anonymous" });
    });
    await dengan({ SESSION_SECRET: "pendek" }, async () => {
      expect(await verdictFromSeal(seal)).toEqual({ kind: "anonymous" });
    });
  });
});

describe("kontrak penolakan", () => {
  it("401 untuk anonim, 403 untuk bukan admin", () => {
    // Dipakai middleware DAN route handler. Kalau bentuknya bergeser di salah
    // satu sisi, klien admin yang memanggil r.json() tanpa mengecek res.ok
    // akan gagal dengan cara yang membingungkan.
    expect(ADMIN_DENY.anonymous.status).toBe(401);
    expect(ADMIN_DENY.forbidden.status).toBe(403);
    expect(ADMIN_DENY.anonymous.body).toEqual({ success: false, error: "Unauthorized" });
    expect(ADMIN_DENY.forbidden.body).toEqual({ success: false, error: "Forbidden" });
  });
});
