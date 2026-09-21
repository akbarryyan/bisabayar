/**
 * Perbandingan digest signature webhook.
 *
 * Kasus yang paling penting ada di test "dua string kosong": kredensial yang
 * belum diisi menghasilkan digest kosong di KEDUA sisi, dan perbandingan naif
 * akan menyatakannya cocok — artinya konfigurasi yang belum lengkap justru
 * meloloskan semua orang.
 */
import { describe, expect, it } from "vitest";
import { safeEqualHex } from "@/lib/webhook-signature";

describe("safeEqualHex", () => {
  it("menerima digest yang sama persis", () => {
    const digest = "a".repeat(32);
    expect(safeEqualHex(digest, digest)).toBe(true);
  });

  it("mengabaikan beda huruf besar-kecil dan spasi di tepi", () => {
    expect(safeEqualHex("ABCDEF0123456789", "  abcdef0123456789 ")).toBe(true);
  });

  it("menolak digest yang berbeda", () => {
    expect(safeEqualHex("a".repeat(32), "b".repeat(32))).toBe(false);
  });

  it("menolak dua string kosong", () => {
    expect(safeEqualHex("", "")).toBe(false);
  });

  it("menolak bila salah satu sisi kosong", () => {
    expect(safeEqualHex("a".repeat(32), "")).toBe(false);
    expect(safeEqualHex("", "a".repeat(32))).toBe(false);
  });

  it("menolak panjang yang berbeda tanpa melempar", () => {
    expect(safeEqualHex("abc", "abcdef")).toBe(false);
  });
});
