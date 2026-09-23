/**
 * Kenaikan tier otomatis setelah order SUCCESS.
 *
 * `checkAndUpgradeUserTier` dipanggil dari eksekusi provider, rekonsiliasi, dan
 * webhook VIP — setiap kali sebuah order berhasil. Ia menentukan tier pengguna,
 * dan tier menentukan harga yang dibayar di transaksi berikutnya. Nol test
 * sebelum berkas ini.
 *
 * Butuh database sungguhan: yang diuji adalah keputusan berdasarkan hitungan
 * order dan perbandingan tier lintas baris, bukan aritmetika murni.
 *
 * Empat perilaku yang dikunci, dan semuanya mudah rusak tanpa terlihat:
 *   1. Hanya order SUCCESS yang dihitung
 *   2. Tier terbaik yang memenuhi syarat yang dipilih, bukan yang pertama lewat
 *   3. Tidak pernah menurunkan tier
 *   4. Aman dipanggil berkali-kali
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { checkAndUpgradeUserTier, getTierForUser, getPriceForUser } from "@/lib/pricing";

const prisma = new PrismaClient();

let memberId: string;
let resellerId: string;
let agentId: string;
let productId: string;

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
  await prisma.userTier.deleteMany();

  const member = await prisma.userTier.create({
    data: { name: "member", label: "Member", marginMultiplier: 1.0, minOrders: 0, isDefault: true, sortOrder: 1 },
  });
  const reseller = await prisma.userTier.create({
    data: { name: "reseller", label: "Reseller", marginMultiplier: 0.8, minOrders: 10, sortOrder: 2 },
  });
  const agent = await prisma.userTier.create({
    data: { name: "agent", label: "Agent", marginMultiplier: 0.6, minOrders: 50, sortOrder: 3 },
  });
  memberId = member.id;
  resellerId = reseller.id;
  agentId = agent.id;

  const product = await prisma.product.create({
    data: {
      provider: "DIGIFLAZZ", providerCode: "TIER-1", name: "Produk Uji",
      category: "UJI", brand: "UJI", type: "PREPAID",
      providerPrice: 10_000, margin: 2_000, sellingPrice: 12_000,
    },
  });
  productId = product.id;
});

const buatUser = (tierId?: string) =>
  prisma.user.create({
    data: {
      email: `tier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@contoh.test`,
      name: "Uji", role: "MEMBER", tierId: tierId ?? null,
    },
  });

async function buatOrder(userId: string, status: string, jumlah: number) {
  for (let i = 0; i < jumlah; i++) {
    await prisma.order.create({
      data: {
        orderCode: `WP-TIER-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        productId, userId, targetNumber: "0812", amount: 12_000,
        status, paymentMethod: "WALLET",
      },
    });
  }
}

const tierDari = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { tier: true } })).tier?.name ?? null;

describe("getTierForUser", () => {
  it("memakai tier milik pengguna bila ada", async () => {
    const u = await buatUser(resellerId);
    expect((await getTierForUser(u.id))?.name).toBe("reseller");
  });

  it("jatuh ke tier default bila pengguna belum punya tier", async () => {
    const u = await buatUser();
    expect((await getTierForUser(u.id))?.name).toBe("member");
  });

  it("jatuh ke tier default untuk tamu (tanpa userId)", async () => {
    expect((await getTierForUser(null))?.name).toBe("member");
    expect((await getTierForUser(undefined))?.name).toBe("member");
  });
});

describe("getPriceForUser", () => {
  it("menurunkan harga sesuai tier pengguna", async () => {
    const member = await buatUser(memberId);
    const agent = await buatUser(agentId);

    const hargaMember = await getPriceForUser(member.id, { id: productId, providerPrice: 10_000, margin: 2_000 });
    const hargaAgent = await getPriceForUser(agent.id, { id: productId, providerPrice: 10_000, margin: 2_000 });

    expect(hargaMember?.sellingPrice).toBe(12_000);
    expect(hargaAgent?.sellingPrice).toBe(11_200);
    // Harga modal tidak ikut berubah — yang berubah hanya markup-nya.
    expect(hargaAgent?.basePrice).toBe(10_000);
  });

  it("tamu mendapat harga tier default", async () => {
    const harga = await getPriceForUser(null, { id: productId, providerPrice: 10_000, margin: 2_000 });
    expect(harga?.sellingPrice).toBe(12_000);
  });
});

describe("checkAndUpgradeUserTier", () => {
  it("menaikkan tier setelah ambang order tercapai", async () => {
    const u = await buatUser(memberId);
    await buatOrder(u.id, "SUCCESS", 10);

    await checkAndUpgradeUserTier(u.id);

    expect(await tierDari(u.id)).toBe("reseller");
  });

  it("belum naik bila ambangnya kurang satu", async () => {
    const u = await buatUser(memberId);
    await buatOrder(u.id, "SUCCESS", 9);

    await checkAndUpgradeUserTier(u.id);

    expect(await tierDari(u.id)).toBe("member");
  });

  it("HANYA menghitung order SUCCESS", async () => {
    const u = await buatUser(memberId);
    await buatOrder(u.id, "SUCCESS", 5);
    await buatOrder(u.id, "PAID", 10);
    await buatOrder(u.id, "FAILED", 10);
    await buatOrder(u.id, "PROCESSING_PROVIDER", 10);

    await checkAndUpgradeUserTier(u.id);

    // 35 order total, tapi hanya 5 yang SUCCESS — belum memenuhi ambang 10.
    expect(await tierDari(u.id)).toBe("member");
  });

  it("melompat ke tier TERBAIK yang memenuhi syarat, bukan yang terdekat", async () => {
    const u = await buatUser(memberId);
    await buatOrder(u.id, "SUCCESS", 50);

    await checkAndUpgradeUserTier(u.id);

    // Memenuhi syarat reseller (10) dan agent (50) sekaligus — harus agent.
    expect(await tierDari(u.id)).toBe("agent");
  });

  it("TIDAK PERNAH menurunkan tier", async () => {
    // Agent dengan 10 order sukses MEMENUHI syarat reseller (ambang 10) tetapi
    // tidak memenuhi agent (ambang 50). Tanpa penjaga penurunan, ia akan turun
    // dari agent (0.6) ke reseller (0.8) — pemberian tier manual oleh admin
    // dianulir hitungan otomatis, dan harga yang dibayar pelanggan naik.
    //
    // Jumlahnya sengaja 10, bukan 1: dengan 1 order tidak ada tier yang
    // memenuhi syarat sama sekali, fungsinya keluar lebih awal, dan penjaga
    // penurunan tidak pernah dievaluasi — test-nya lulus tanpa menguji apa pun.
    const u = await buatUser(agentId);
    await buatOrder(u.id, "SUCCESS", 10);

    await checkAndUpgradeUserTier(u.id);

    expect(await tierDari(u.id)).toBe("agent");
  });

  it("aman dipanggil berkali-kali", async () => {
    const u = await buatUser(memberId);
    await buatOrder(u.id, "SUCCESS", 10);

    await Promise.all([
      checkAndUpgradeUserTier(u.id),
      checkAndUpgradeUserTier(u.id),
      checkAndUpgradeUserTier(u.id),
    ]);

    expect(await tierDari(u.id)).toBe("reseller");
  });

  it("tidak melempar untuk pengguna yang tidak ada", async () => {
    // Dipanggil dari jalur pemenuhan order; melempar di sini akan menggagalkan
    // order yang sebenarnya sudah sukses.
    await expect(checkAndUpgradeUserTier("tidak-ada")).resolves.toBeUndefined();
  });
});
