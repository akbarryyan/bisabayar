/**
 * POST /api/webhook/vip
 *
 * Menerima notifikasi status transaksi dari VIP Reseller (Prepaid & Game/Streaming).
 * Strukturnya sama untuk kedua jenis.
 *
 * Route ini sengaja tipis — parse, verifikasi, delegasi. Seluruh keputusan ada di
 * lib/vip-callback.ts, bentuk yang sama dipakai webhook Poppay. Alasannya: skenario
 * konkurensi hanya bisa diuji dengan jujur kalau logikanya berupa fungsi.
 *
 * Header:
 *   X-Client-Signature: md5(API_ID + API_KEY)
 *
 * Payload:
 *   { result: true, data: [{ trxid, data, service, status, note, price }], message }
 *
 * Status VIP: waiting / processing diabaikan, success → SUCCESS, error → FAILED.
 *
 * Webhook TIDAK dibatasi rate limit — kiriman ulang VIP harus selalu bisa masuk.
 * Konstitusi §9.3.
 */

import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/rate-limit";
import { getLogger, redactDeep } from "@/lib/logger";
import {
  handleVipCallback,
  verifyVipWebhookAuth,
  type VipCallbackPayload,
} from "@/lib/vip-callback";

export const dynamic = "force-dynamic";

const log = getLogger("webhook").child({ provider: "vip" });

/** IP resmi VIP Reseller. Dicatat saja — penegakannya sengaja tidak dilakukan. */
const VIP_WEBHOOK_IP = "178.248.73.218";

function ok() {
  return NextResponse.json({ success: true }, { status: 200 });
}

export async function POST(req: NextRequest) {
  let payload: VipCallbackPayload;
  try {
    payload = (await req.json()) as VipCallbackPayload;
  } catch {
    // 200 supaya VIP tidak mengirim ulang body yang memang rusak.
    log.warn("gagal mem-parse body json");
    return ok();
  }

  log.debug({ payload: redactDeep(payload) }, "webhook diterima");

  const auth = await verifyVipWebhookAuth(req.headers);
  if (!auth.ok) {
    log.warn({ reason: auth.reason }, "callback VIP ditolak");
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  // Penegakan IP sengaja TIDAK dilakukan — keputusan pemilik project.
  // Yang dipakai clientIp(), bukan x-forwarded-for mentah: ia mendahulukan
  // x-real-ip yang disetel nginx dan tidak bisa dipalsukan klien, sehingga yang
  // tercatat di sini layak dipercaya bila nanti penegakannya jadi dinyalakan.
  const ip = clientIp(req);
  if (ip !== VIP_WEBHOOK_IP) {
    log.warn({ clientIp: ip, expectedIp: VIP_WEBHOOK_IP }, "callback dari IP tak dikenal");
  }

  try {
    const hasil = await handleVipCallback(payload);
    log.debug({ hasil }, "callback VIP selesai diproses");
  } catch (error) {
    // Tetap 200. Barisnya WebhookEvent sudah menyimpan errorMessage dan belum
    // ditandai selesai, jadi kiriman ulang VIP maupun sapuan rekonsiliasi masih
    // bisa menuntaskannya. Pola yang sama dipakai route Poppay.
    log.error({ err: error }, "pemrosesan callback VIP gagal");
  }

  return ok();
}
