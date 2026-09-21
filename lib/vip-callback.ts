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
import type { Prisma } from "@prisma/client";
import { OrderRepository } from "@/src/infra/db/repositories/order.repository";
import { OrderStatus, WebhookSource } from "@/src/core/domain/enums/order.enum";
import { checkAndUpgradeUserTier } from "@/lib/pricing";

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

export interface VipCallbackPayload {
  data?: unknown;
  [key: string]: unknown;
}

export type VipCallbackResult =
  | { action: "ignored"; reason: string }
  | { action: "duplicate" }
  | { action: "order_not_found" }
  | { action: "already_terminal"; orderId: string }
  | { action: "claimed"; status: "SUCCESS" | "FAILED"; orderId: string };

interface VipItem {
  trxid: string;
  status: string;
  note: string;
}

/** Prepaid mengirim `data` sebagai array, Game sebagai objek tunggal. */
function normalizeVipItem(payload: VipCallbackPayload): VipItem | null {
  if (!payload?.data) return null;

  const item = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!item || typeof item !== "object") return null;

  const { trxid, status, note } = item as Record<string, unknown>;
  return {
    trxid: trxid == null ? "" : String(trxid),
    status: status == null ? "" : String(status),
    note: note == null ? "" : String(note),
  };
}

type OrderRow = NonNullable<Awaited<ReturnType<OrderRepository["findById"]>>>;

async function terapkanSukses(
  orderRepo: OrderRepository,
  order: OrderRow,
  note: string,
): Promise<VipCallbackResult> {
  const serialNumber = note !== "" ? note : undefined;

  const menang = await orderRepo.claimStatusTransition(
    order.id,
    [OrderStatus.PAID, OrderStatus.PROCESSING_PROVIDER],
    OrderStatus.SUCCESS,
    {
      serialNumber,
      notes: `VIP webhook: success${serialNumber ? ` | SN: ${serialNumber}` : ""}`,
    },
  );

  if (!menang) {
    // Order sudah terminal. Backfill komisi HANYA untuk order yang benar-benar
    // SUCCESS — membacanya ulang wajib, karena `order` adalah snapshot sebelum
    // klaim dan bisa saja kini FAILED. Membayar komisi atas order gagal jauh
    // lebih buruk daripada melewatkan backfill.
    const terkini = await orderRepo.findById(order.id);
    if (terkini?.status === OrderStatus.SUCCESS) {
      await orderRepo.creditSellerCommission(order.id).catch((err) =>
        log.error({ err, orderId: order.id }, "backfill komisi seller gagal"),
      );
    }
    return { action: "already_terminal", orderId: order.id };
  }

  await orderRepo.creditSellerCommission(order.id);

  if (order.paymentMethod === "WALLET" && order.userId) {
    await orderRepo.finalizeDebitLedger(order.userId, Number(order.amount), order.id);
  }

  if (order.userId) {
    await checkAndUpgradeUserTier(order.userId).catch(() => {});
  }

  log.info({ orderId: order.id, serialNumber: serialNumber ?? null }, "order success");
  return { action: "claimed", status: "SUCCESS", orderId: order.id };
}

async function terapkanGagal(
  orderRepo: OrderRepository,
  order: OrderRow,
  note: string,
): Promise<VipCallbackResult> {
  const menang = await orderRepo.claimStatusTransition(
    order.id,
    [OrderStatus.PAID, OrderStatus.PROCESSING_PROVIDER],
    OrderStatus.FAILED,
    { notes: `VIP webhook: error | ${note || "No note"}` },
  );

  if (!menang) return { action: "already_terminal", orderId: order.id };

  // Hanya pemenang klaim yang sampai di sini. Itu satu-satunya yang menjaga
  // releaseWalletHold, karena metode itu tidak punya penjaga idempotensi
  // sendiri — ia hanya increment saldo.
  if (order.paymentMethod === "WALLET" && order.userId) {
    await orderRepo.releaseWalletHold(order.userId, Number(order.amount), order.id);
  }

  log.info({ orderId: order.id, note: note || null }, "order failed");
  return { action: "claimed", status: "FAILED", orderId: order.id };
}

/**
 * Proses satu callback VIP.
 *
 * Idempotensinya dua lapis. WebhookEvent menahan kiriman ulang yang pemrosesannya
 * SUDAH tuntas; klaim status atomik menahan yang beriringan. Lapis kedua tidak
 * bisa dihilangkan: komentar pada findOrCreateWebhookEvent menyatakan pemrosesan
 * ulang aman karena tiap jalur hilir menjaga dirinya sendiri, dan justru itu yang
 * tidak berlaku di sini — releaseWalletHold tidak punya penjaga apa pun.
 */
export async function handleVipCallback(
  payload: VipCallbackPayload,
): Promise<VipCallbackResult> {
  const item = normalizeVipItem(payload);
  if (!item) {
    log.warn("payload tanpa field data");
    return { action: "ignored", reason: "payload tanpa data" };
  }

  const { trxid, status: vipStatus, note } = item;
  if (!trxid) {
    log.warn("trxid kosong di payload");
    return { action: "ignored", reason: "trxid kosong" };
  }

  // waiting / processing masih berjalan — tunggu success/error. Sengaja TIDAK
  // dicatat sebagai WebhookEvent: statusnya bukan keputusan, dan mencatatnya
  // hanya menumpuk baris tanpa guna.
  if (vipStatus === "waiting" || vipStatus === "processing") {
    log.debug({ trxid, vipStatus }, "status interim diabaikan");
    return { action: "ignored", reason: `status interim ${vipStatus}` };
  }

  if (vipStatus !== "success" && vipStatus !== "error") {
    log.warn({ trxid, vipStatus }, "status tak dikenal, diabaikan");
    return { action: "ignored", reason: `status tak dikenal ${vipStatus}` };
  }

  const orderRepo = new OrderRepository();
  const eventId = `vip:${trxid}:${vipStatus}`;

  const { event, alreadyProcessed } = await orderRepo.findOrCreateWebhookEvent({
    source: WebhookSource.VIP_RESELLER,
    eventId,
    eventType: vipStatus,
    payload: payload as Prisma.InputJsonValue,
  });

  if (alreadyProcessed) {
    log.debug({ eventId }, "callback duplikat, sudah tuntas sebelumnya");
    return { action: "duplicate" };
  }

  if (event.errorMessage) {
    log.info(
      { eventId, previousError: event.errorMessage },
      "mencoba ulang callback yang sebelumnya gagal",
    );
  }

  try {
    const order = await orderRepo.findByProviderRef(trxid);

    if (!order) {
      // Event DIBIARKAN TERBUKA. Penyebab paling mungkin adalah balapan: VIP
      // mengirim callback sebelum providerRef sempat tersimpan di sisi kita.
      // Menandainya selesai akan membuat kiriman ulang VIP ditolak sebagai
      // duplikat dan order tertinggal tanpa penyelesai — konstitusi §2.1b.
      log.warn({ trxid, eventId }, "order belum ada untuk providerRef; event dibiarkan terbuka");
      return { action: "order_not_found" };
    }

    const hasil =
      vipStatus === "success"
        ? await terapkanSukses(orderRepo, order, note)
        : await terapkanGagal(orderRepo, order, note);

    await orderRepo.markWebhookProcessed(eventId);
    return hasil;
  } catch (error) {
    await orderRepo.markWebhookProcessed(
      eventId,
      error instanceof Error ? error.message : "Unknown VIP callback error",
    );
    throw error;
  }
}
