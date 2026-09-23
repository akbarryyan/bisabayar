/**
 * Formula harga berjenjang.
 *
 *     markup       = round(margin × marginMultiplier)
 *     sellingPrice = providerPrice + markup
 *
 * Ini fungsi murni yang menentukan berapa yang dibayar pelanggan, dipakai oleh
 * checkout, eksekusi provider, rekonsiliasi, dan webhook VIP — dan sampai test
 * ini ditulis, tidak punya satu pun pengujian.
 *
 * Yang dikunci di sini bukan cuma "formulanya benar", tapi keputusan-keputusan
 * yang mudah berubah tanpa sengaja: pembulatan memakai round (bukan floor atau
 * ceil), pengali menyentuh margin saja (bukan harga modal), dan pengali di atas
 * 1 menaikkan harga alih-alih ditolak.
 */
import { describe, expect, it } from "vitest";
import { calcTierPrice } from "@/lib/pricing";

describe("calcTierPrice", () => {
  it("Member (pengali 1.0) membayar margin penuh", () => {
    expect(calcTierPrice(10_000, 2_000, 1.0)).toEqual({
      markup: 2_000,
      sellingPrice: 12_000,
    });
  });

  it("Reseller (pengali 0.8) membayar 80% margin", () => {
    expect(calcTierPrice(10_000, 2_000, 0.8)).toEqual({
      markup: 1_600,
      sellingPrice: 11_600,
    });
  });

  it("Agent (pengali 0.6) membayar 60% margin", () => {
    expect(calcTierPrice(10_000, 2_000, 0.6)).toEqual({
      markup: 1_200,
      sellingPrice: 11_200,
    });
  });

  it("pengali hanya menyentuh margin, TIDAK menyentuh harga modal", () => {
    // Kalau suatu saat ada yang mengalikan seluruh harga alih-alih marginnya,
    // test ini yang menangkapnya: 10_000 tetap utuh di hasil akhir.
    const { sellingPrice } = calcTierPrice(10_000, 2_000, 0.5);
    expect(sellingPrice).toBe(11_000);
    expect(sellingPrice).not.toBe(6_000); // = (10_000 + 2_000) × 0.5
  });

  it("membulatkan markup ke bilangan terdekat, bukan ke bawah", () => {
    // 1_505 × 0.5 = 752.5 → 753, bukan 752.
    expect(calcTierPrice(0, 1_505, 0.5).markup).toBe(753);
    // 1_501 × 0.5 = 750.5 → 751 (round setengah ke atas di JavaScript).
    expect(calcTierPrice(0, 1_501, 0.5).markup).toBe(751);
    // 1_499 × 0.5 = 749.5 → 750.
    expect(calcTierPrice(0, 1_499, 0.5).markup).toBe(750);
  });

  it("margin nol berarti dijual seharga modal", () => {
    expect(calcTierPrice(7_500, 0, 0.8)).toEqual({
      markup: 0,
      sellingPrice: 7_500,
    });
  });

  it("pengali nol berarti dijual seharga modal, bukan gratis", () => {
    expect(calcTierPrice(7_500, 3_000, 0)).toEqual({
      markup: 0,
      sellingPrice: 7_500,
    });
  });

  it("pengali di atas 1 MENAIKKAN harga, tidak ditolak", () => {
    // Perilaku ini disengaja dan perlu diketahui: tidak ada pagar atas, jadi
    // salah ketik di /admin/tiers (1.5 alih-alih 0.15) langsung menaikkan harga
    // jual ke pelanggan tanpa ada yang menghalangi.
    expect(calcTierPrice(10_000, 2_000, 1.5)).toEqual({
      markup: 3_000,
      sellingPrice: 13_000,
    });
  });
});
