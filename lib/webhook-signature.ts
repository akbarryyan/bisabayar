/**
 * Perbandingan signature webhook.
 *
 * Diangkat dari app/api/webhook/poppay/route.ts supaya webhook Poppay dan VIP
 * memakai pembanding yang sama. Keduanya membandingkan digest heksadesimal.
 */
import crypto from "crypto";

/**
 * Bandingkan dua digest hex tanpa membocorkan posisi byte yang berbeda lewat
 * waktu eksekusi.
 *
 * Nilai kosong SELALU gagal. Ini disengaja: kredensial yang belum diisi
 * menghasilkan digest kosong di kedua sisi, dan memperlakukannya sebagai cocok
 * akan mengubah konfigurasi yang belum lengkap menjadi pintu terbuka.
 */
export function safeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft.length !== normalizedRight.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(normalizedLeft, "utf8"),
      Buffer.from(normalizedRight, "utf8")
    );
  } catch {
    return false;
  }
}
