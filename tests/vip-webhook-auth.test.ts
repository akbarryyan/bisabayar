/**
 * Autentikasi callback VIP Reseller.
 *
 * Kode sebelumnya berbunyi:
 *
 *     if (signature && expectedSig && signature !== expectedSig) { tolak }
 *
 * Tanpa header, cabang itu tidak pernah dievaluasi dan permintaan lolos —
 * anti-pola yang sama dengan yang dilarang konstitusi §4.2 untuk view_token:
 * tidak mengirim apa pun jadi lebih longgar daripada mengirim nilai salah.
 *
 * Cacat kedua: kredensial dibaca dari process.env, sementara vip.adapter.ts
 * membacanya dari site_configs. Bila kredensial hanya ada di DB — kondisi normal
 * di produksi — expectedSig menjadi md5 dari string kosong.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";
import { setSiteConfig, invalidateSiteConfigCache } from "@/lib/site-config";
import { verifyVipWebhookAuth } from "@/lib/vip-callback";

const prisma = new PrismaClient();

const ID_DB = "id-dari-database";
const KEY_DB = "key-dari-database";
const ID_ENV = "id-dari-env";
const KEY_ENV = "key-dari-env";

const sig = (apiId: string, apiKey: string) =>
  createHash("md5").update(apiId + apiKey).digest("hex");

const headers = (signature?: string) =>
  new Headers(signature === undefined ? {} : { "x-client-signature": signature });

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await prisma.siteConfig.deleteMany();
  // Tulis lewat setSiteConfig supaya cache 10 detik ikut dikosongkan.
  await setSiteConfig("VIP_API_ID", ID_DB);
  await setSiteConfig("VIP_API_KEY", KEY_DB);
  process.env.VIP_API_ID = ID_ENV;
  process.env.VIP_API_KEY = KEY_ENV;
});

describe("mode ketat (bawaan)", () => {
  it("MENOLAK permintaan tanpa header signature", async () => {
    const hasil = await verifyVipWebhookAuth(headers());
    expect(hasil.ok).toBe(false);
  });

  it("menolak signature yang tidak cocok", async () => {
    const hasil = await verifyVipWebhookAuth(headers("a".repeat(32)));
    expect(hasil.ok).toBe(false);
  });

  it("menerima signature yang cocok", async () => {
    const hasil = await verifyVipWebhookAuth(headers(sig(ID_DB, KEY_DB)));
    expect(hasil).toEqual({ ok: true, mode: "verified" });
  });

  it("menolak bila kredensial belum diisi di mana pun", async () => {
    // deleteMany langsung melewati invalidateSiteConfigCache — kosongkan manual,
    // kalau tidak cache 10 detik masih menyimpan nilai dari beforeEach.
    await prisma.siteConfig.deleteMany();
    invalidateSiteConfigCache();
    delete process.env.VIP_API_ID;
    delete process.env.VIP_API_KEY;

    // Kredensial kosong menghasilkan digest kosong di kedua sisi. Yang ingin
    // dibuktikan: itu ditolak, bukan dianggap cocok.
    const hasil = await verifyVipWebhookAuth(headers(sig("", "")));
    expect(hasil.ok).toBe(false);
  });
});

describe("sumber kredensial", () => {
  it("memakai site_configs, BUKAN process.env", async () => {
    const dariDb = await verifyVipWebhookAuth(headers(sig(ID_DB, KEY_DB)));
    expect(dariDb.ok).toBe(true);

    const dariEnv = await verifyVipWebhookAuth(headers(sig(ID_ENV, KEY_ENV)));
    expect(dariEnv.ok).toBe(false);
  });

  it("jatuh ke env ketika kunci belum ada di site_configs", async () => {
    await prisma.siteConfig.deleteMany();
    invalidateSiteConfigCache();

    const hasil = await verifyVipWebhookAuth(headers(sig(ID_ENV, KEY_ENV)));
    expect(hasil.ok).toBe(true);
  });
});

describe("jalan keluar VIP_WEBHOOK_SIGNATURE_REQUIRED=false", () => {
  beforeEach(async () => {
    await setSiteConfig("VIP_WEBHOOK_SIGNATURE_REQUIRED", "false");
  });

  it("meloloskan permintaan tanpa header", async () => {
    const hasil = await verifyVipWebhookAuth(headers());
    expect(hasil).toEqual({ ok: true, mode: "skipped" });
  });

  it("TETAP menolak signature yang jelas salah", async () => {
    const hasil = await verifyVipWebhookAuth(headers("a".repeat(32)));
    expect(hasil.ok).toBe(false);
  });
});

describe("route handler POST /api/webhook/vip", () => {
  const panggil = async (signature?: string, body: unknown = { result: false }) => {
    const { POST } = await import("@/app/api/webhook/vip/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/webhook/vip", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-client-signature": signature }),
      },
      body: JSON.stringify(body),
    });
    return POST(req);
  };

  it("membalas 401 ketika header signature tidak ada", async () => {
    const res = await panggil();
    expect(res.status).toBe(401);
  });

  it("membalas 401 ketika signature salah", async () => {
    const res = await panggil("a".repeat(32));
    expect(res.status).toBe(401);
  });

  it("membalas 200 ketika signature benar", async () => {
    const res = await panggil(sig(ID_DB, KEY_DB));
    expect(res.status).toBe(200);
  });

  it("membalas 200 untuk body yang bukan JSON, tanpa memeriksa signature", async () => {
    const { POST } = await import("@/app/api/webhook/vip/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/webhook/vip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "bukan json",
    });
    expect((await POST(req)).status).toBe(200);
  });
});
