import crypto from "crypto";
import { NextResponse } from "next/server";
import { getSiteConfigValue } from "@/lib/site-config";
import { handlePoppayCallback, type PoppayCallbackPayload } from "@/lib/poppay-callback";
import { getLogger } from "@/lib/logger";
import { safeEqualHex } from "@/lib/webhook-signature";

export const dynamic = "force-dynamic";

const log = getLogger("webhook").child({ provider: "poppay" });

type VerificationResult =
  | { mode: "verified" | "skipped" | "invalid"; reason?: string };

function readHeader(headers: Headers, keys: string[]): string {
  for (const key of keys) {
    const value = headers.get(key);
    if (value) return value.trim();
  }
  return "";
}

function normalizeBool(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function computeHmacSha256(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function computeSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function verifyPoppayWebhookSignature(
  headers: Headers,
  rawBody: string,
  payload: PoppayCallbackPayload
): Promise<VerificationResult> {
  const secret = (await getSiteConfigValue("POPPAY_SECRET_KEY")).trim();
  const signatureRequired = normalizeBool(await getSiteConfigValue("POPPAY_WEBHOOK_SIGNATURE_REQUIRED", ""));

  if (!secret) {
    if (signatureRequired) {
      return { mode: "invalid", reason: "POPPAY_SECRET_KEY belum diisi saat strict verification aktif." };
    }
    return { mode: "skipped" };
  }

  const signature = readHeader(headers, [
    "x-signature",
    "x-poppay-signature",
    "signature",
    "x-callback-signature",
  ]);
  const timestamp = readHeader(headers, [
    "x-timestamp",
    "x-poppay-timestamp",
    "timestamp",
    "x-callback-timestamp",
  ]);

  if (!signature) {
    if (signatureRequired) {
      return { mode: "invalid", reason: "Header signature callback tidak ditemukan." };
    }
    log.warn("signature header missing, verification skipped");
    return { mode: "skipped" };
  }

  const compactBody = rawBody.trim();
  const baseFields = `${payload.refid}${payload.agg_refid}${payload.status}`;
  const candidates = [
    computeHmacSha256(secret, compactBody),
    computeSha256(compactBody + secret),
    computeSha256(secret + compactBody),
  ];

  if (timestamp) {
    candidates.push(
      computeHmacSha256(secret, `${baseFields}${timestamp}`),
      computeHmacSha256(secret, `${timestamp}.${compactBody}`),
      computeHmacSha256(secret, `${compactBody}${timestamp}`)
    );
  }

  candidates.push(
    computeHmacSha256(secret, baseFields),
    computeSha256(baseFields + secret),
    computeSha256(secret + baseFields)
  );

  const isValid = candidates.some((candidate) => safeEqualHex(candidate, signature));
  if (!isValid) {
    return { mode: "invalid", reason: "Signature callback Poppay tidak valid." };
  }

  return { mode: "verified" };
}

export async function POST(request: Request) {
  let rawBody = "";
  let payload: PoppayCallbackPayload | null = null;

  try {
    rawBody = await request.text();
    payload = JSON.parse(rawBody) as PoppayCallbackPayload;
  } catch {
    return NextResponse.json(
      {
        status: "success",
        message: "Invalid JSON ignored",
        data: { id: "ignored-invalid-json", created_at: new Date().toISOString() },
      },
      { status: 200 }
    );
  }

  if (!payload?.refid || !payload?.agg_refid || payload?.status == null) {
    return NextResponse.json(
      {
        status: "success",
        message: "Missing required fields ignored",
        data: { id: "ignored-missing-fields", created_at: new Date().toISOString() },
      },
      { status: 200 }
    );
  }

  try {
    const verification = await verifyPoppayWebhookSignature(request.headers, rawBody, payload);
    if (verification.mode === "invalid") {
      log.warn(
        { refid: payload.refid, reason: verification.reason },
        "signature not validated, continuing with inquiry cross-check",
      );
    }

    const result = await handlePoppayCallback(payload, JSON.parse(rawBody));
    return NextResponse.json(
      {
        status: "success",
        message: "Operation completed successfully",
        data: {
          id: payload.refid,
          created_at: new Date().toISOString(),
          verification: verification.mode,
          result,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    log.error({ err: error, refid: payload.refid }, "callback processing failed");
    return NextResponse.json(
      {
        status: "success",
        message: "Operation completed with internal error",
        data: {
          id: payload.refid,
          created_at: new Date().toISOString(),
        },
      },
      { status: 200 }
    );
  }
}
