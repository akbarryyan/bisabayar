/**
 * Perhitungan fee payment gateway.
 *
 * Fungsi murni, menentukan berapa rupiah tambahan yang ditagihkan ke pelanggan
 * di atas harga produk. Nol test sebelum berkas ini.
 *
 * Dua keputusan di dalamnya yang perlu dikunci karena tidak terlihat dari nama
 * fungsinya:
 *
 *   1. Fee PERSEN dibulatkan ke ATAS (Math.ceil) — pelanggan membayar lebih,
 *      bukan kurang. Kalau suatu saat berubah jadi round atau floor, selisihnya
 *      ditanggung kita di setiap transaksi.
 *   2. Metode pembayaran kosong diperlakukan SAMA dengan "qris", jadi tetap
 *      kena fee. Hanya metode yang bernama lain yang bebas.
 */
import { describe, expect, it } from "vitest";
import {
  calculatePaymentGatewayFee,
  normalizePaymentGatewayFeeConfig,
  normalizePaymentGatewayFeeType,
  DEFAULT_PAYMENT_GATEWAY_FEE_CONFIG,
} from "@/lib/payment-gateway-fee";

describe("normalizePaymentGatewayFeeType", () => {
  it("hanya mengenali PERCENT; selain itu jatuh ke FIXED", () => {
    expect(normalizePaymentGatewayFeeType("PERCENT")).toBe("PERCENT");
    expect(normalizePaymentGatewayFeeType("FIXED")).toBe("FIXED");
    expect(normalizePaymentGatewayFeeType("percent")).toBe("FIXED"); // peka huruf besar
    expect(normalizePaymentGatewayFeeType(null)).toBe("FIXED");
    expect(normalizePaymentGatewayFeeType(undefined)).toBe("FIXED");
    expect(normalizePaymentGatewayFeeType("ngawur")).toBe("FIXED");
  });
});

describe("normalizePaymentGatewayFeeConfig", () => {
  it("nilai negatif dan bukan angka dijadikan nol", () => {
    expect(normalizePaymentGatewayFeeConfig({ type: "FIXED", value: -500 }).value).toBe(0);
    expect(normalizePaymentGatewayFeeConfig({ type: "FIXED", value: NaN }).value).toBe(0);
    expect(normalizePaymentGatewayFeeConfig(null)).toEqual(DEFAULT_PAYMENT_GATEWAY_FEE_CONFIG);
  });

  it("nilai positif dipertahankan apa adanya", () => {
    expect(normalizePaymentGatewayFeeConfig({ type: "PERCENT", value: 0.7 })).toEqual({
      type: "PERCENT",
      value: 0.7,
    });
  });
});

describe("calculatePaymentGatewayFee — fee tetap", () => {
  it("mengembalikan nominal yang disetel", () => {
    expect(calculatePaymentGatewayFee("qris", 50_000, { type: "FIXED", value: 1_500 })).toBe(1_500);
  });

  it("membulatkan nominal pecahan", () => {
    expect(calculatePaymentGatewayFee("qris", 50_000, { type: "FIXED", value: 1_500.6 })).toBe(1_501);
  });

  it("tidak terpengaruh besarnya transaksi", () => {
    const kecil = calculatePaymentGatewayFee("qris", 1_000, { type: "FIXED", value: 1_500 });
    const besar = calculatePaymentGatewayFee("qris", 5_000_000, { type: "FIXED", value: 1_500 });
    expect(kecil).toBe(besar);
  });
});

describe("calculatePaymentGatewayFee — fee persen", () => {
  it("menghitung persentase dari nominal transaksi", () => {
    expect(calculatePaymentGatewayFee("qris", 100_000, { type: "PERCENT", value: 0.7 })).toBe(700);
  });

  it("membulatkan ke ATAS, bukan ke terdekat", () => {
    // 10_000 × 0.7% = 70 pas — tidak membuktikan apa pun. Yang membuktikan:
    // 10_001 × 0.7% = 70.007 → 71, bukan 70.
    expect(calculatePaymentGatewayFee("qris", 10_001, { type: "PERCENT", value: 0.7 })).toBe(71);
    // 1 × 0.7% = 0.007 → 1. Fee terkecil yang mungkin tetap 1 rupiah, bukan 0.
    expect(calculatePaymentGatewayFee("qris", 1, { type: "PERCENT", value: 0.7 })).toBe(1);
  });
});

describe("calculatePaymentGatewayFee — kapan fee TIDAK dikenakan", () => {
  it("nominal nol atau negatif tidak kena fee", () => {
    expect(calculatePaymentGatewayFee("qris", 0, { type: "FIXED", value: 1_500 })).toBe(0);
    expect(calculatePaymentGatewayFee("qris", -5_000, { type: "FIXED", value: 1_500 })).toBe(0);
    expect(calculatePaymentGatewayFee("qris", NaN, { type: "FIXED", value: 1_500 })).toBe(0);
  });

  it("metode selain qris bebas fee", () => {
    expect(calculatePaymentGatewayFee("va_bca", 50_000, { type: "FIXED", value: 1_500 })).toBe(0);
    expect(calculatePaymentGatewayFee("WALLET", 50_000, { type: "FIXED", value: 1_500 })).toBe(0);
  });

  it("qris dikenali tanpa peduli huruf besar-kecil dan spasi", () => {
    expect(calculatePaymentGatewayFee("  QRIS ", 50_000, { type: "FIXED", value: 1_500 })).toBe(1_500);
  });

  it("metode KOSONG tetap kena fee — diperlakukan seperti qris", () => {
    // Perilaku yang mudah mengejutkan: string kosong lolos dari penyaring
    // metode, jadi pemanggil yang lupa mengisi methodKey tetap menagih fee.
    expect(calculatePaymentGatewayFee("", 50_000, { type: "FIXED", value: 1_500 })).toBe(1_500);
    expect(calculatePaymentGatewayFee(null, 50_000, { type: "FIXED", value: 1_500 })).toBe(1_500);
  });

  it("konfigurasi bernilai nol berarti tidak ada fee", () => {
    expect(calculatePaymentGatewayFee("qris", 50_000, { type: "FIXED", value: 0 })).toBe(0);
    expect(calculatePaymentGatewayFee("qris", 50_000, null)).toBe(0);
  });
});
