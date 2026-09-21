/**
 * lib/vip-callback.ts
 *
 * Pemrosesan callback VIP Reseller. Bentuknya mengikuti lib/poppay-callback.ts:
 * route handler hanya mem-parse dan memverifikasi, seluruh keputusan ada di sini.
 * Dengan begitu skenario konkurensi bisa diuji sebagai fungsi, bukan lewat HTTP.
 *
 * Rancangan lengkap beserta alasannya:
 * docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md
 */
import { createHash } from "crypto";
import { getSiteConfigValue } from "@/lib/site-config";
import { safeEqualHex } from "@/lib/webhook-signature";
import { getLogger } from "@/lib/logger";

const log = getLogger("webhook").child({ provider: "vip" });

export type VipAuthVerdict =
  | { ok: true; mode: "verified" | "skipped" }
  | { ok: false; reason: string };

/**
 * Verifikasi keaslian callback VIP.
 *
 * Perlu diketahui dan tidak bisa diperbaiki dari sisi kita: signature VIP adalah
 * `md5(API_ID + API_KEY)` — nilai STATIS yang sama untuk setiap permintaan, tidak
 * terikat payload. VIP yang menentukan formatnya, bukan kita. Jadi verifikasi ini
 * membuktikan pengirim mengetahui kredensial, bukan bahwa pesan ini baru.
 * Perlindungan terhadap pengiriman ulang datang dari WebhookEvent dan klaim status
 * atomik di hilir, bukan dari sini.
 *
 * Kredensial dibaca lewat getSiteConfigValue, yang sudah menerapkan urutan
 * site_configs → env sesuai konstitusi §5.1. Versi sebelumnya membaca process.env
 * langsung, sehingga mati total ketika kredensial hanya ada di database.
 */
export async function verifyVipWebhookAuth(headers: Headers): Promise<VipAuthVerdict> {
  const [apiId, apiKey, requiredRaw] = await Promise.all([
    getSiteConfigValue("VIP_API_ID"),
    getSiteConfigValue("VIP_API_KEY"),
    getSiteConfigValue("VIP_WEBHOOK_SIGNATURE_REQUIRED", "true"),
  ]);

  // Bawaannya ketat: apa pun selain "false" berarti wajib.
  const required = requiredRaw.trim().toLowerCase() !== "false";
  const signature = headers.get("x-client-signature")?.trim() ?? "";

  if (!apiId || !apiKey) {
    if (required) return { ok: false, reason: "Kredensial VIP belum diisi." };
    log.warn("kredensial VIP kosong, verifikasi signature dilewati");
    return { ok: true, mode: "skipped" };
  }

  if (!signature) {
    if (required) return { ok: false, reason: "Header X-Client-Signature tidak ada." };
    log.warn("header signature tidak ada, verifikasi dilewati");
    return { ok: true, mode: "skipped" };
  }

  // Signature yang ADA tetapi tidak cocok selalu ditolak, apa pun nilai flag.
  // Tidak ada tafsir yang membenarkan penerimaannya, dan di sinilah bug lama
  // berada.
  const expected = createHash("md5").update(apiId + apiKey).digest("hex");
  if (!safeEqualHex(expected, signature)) {
    return { ok: false, reason: "Signature tidak cocok." };
  }

  return { ok: true, mode: "verified" };
}
