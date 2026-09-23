/**
 * Aturan checkout — konstitusi §4 (tamu) dan §3 (wallet).
 *
 * `create-checkout.service.ts` adalah pintu masuk SETIAP transaksi: 387 baris
 * yang menentukan harga, menahan saldo, membuat token tamu, dan memutuskan siapa
 * boleh membayar dengan cara apa. Nol test sebelum berkas ini.
 *
 * Database sungguhan, payment gateway tiruan. Pembagian itu disengaja dan sesuai
 * konstitusi §1.4: yang tidak boleh ditiru adalah perilaku DATABASE — transaksi,
 * kunci baris, isolasi. Gateway pembayaran adalah sistem HTTP di luar sana;
 * menirunya tidak menyembunyikan kesalahan apa pun yang ingin kita tangkap.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { CreateCheckoutService } from "@/src/core/services/checkout/create-checkout.service";
import { OrderRepository } from "@/src/infra/db/repositories/order.repository";
import type {
  IPaymentGatewayPort,
  CreatePaymentInput,
  CreatePaymentResult,
  DetailPaymentResult,
} from "@/src/core/ports/payment-gateway.port";

const prisma = new PrismaClient();

/** Gateway tiruan — mencatat apa yang diminta, selalu berhasil. */
class GatewayTiruan implements IPaymentGatewayPort {
  gatewayName = "tiruan";
  permintaan: CreatePaymentInput[] = [];

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.permintaan.push(input);
    return {
      invoiceId: `INV-${input.orderId}`,
      paymentUrl: `https://tiruan.test/${input.orderId}`,
      paymentNumber: "000111222",
      method: input.method ?? "QRIS",
      amount: input.amount,
      fee: 0,
      totalPayment: input.amount,
      raw: {},
    };
  }
  async detailPayment(orderId: string, amount: number): Promise<DetailPaymentResult> {
    return {
      invoiceId: `INV-${orderId}`, orderId, status: "pending",
      amount, fee: 0, totalPayment: amount, raw: {},
    };
  }
  async cancelPayment(): Promise<void> {}
  async simulatePayment(): Promise<void> {}
}

let gateway: GatewayTiruan;
let service: CreateCheckoutService;
let productId: string;
let memberId: string;
let agentId: string;

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await prisma.paymentInvoice.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();
  await prisma.userTier.deleteMany();

  const tierMember = await prisma.userTier.create({
    data: { name: "member", label: "Member", marginMultiplier: 1.0, isDefault: true },
  });
  const tierAgent = await prisma.userTier.create({
    data: { name: "agent", label: "Agent", marginMultiplier: 0.6, minOrders: 50 },
  });

  const product = await prisma.product.create({
    data: {
      provider: "DIGIFLAZZ", providerCode: "CO-1", name: "Produk Uji",
      category: "UJI", brand: "UJI", type: "PREPAID",
      providerPrice: 10_000, margin: 2_000, sellingPrice: 12_000,
      isActive: true, stock: true,
    },
  });
  productId = product.id;

  const member = await prisma.user.create({
    data: { email: `m-${Date.now()}@contoh.test`, name: "Member", role: "MEMBER", tierId: tierMember.id },
  });
  const agent = await prisma.user.create({
    data: { email: `a-${Date.now()}@contoh.test`, name: "Agent", role: "MEMBER", tierId: tierAgent.id },
  });
  memberId = member.id;
  agentId = agent.id;

  gateway = new GatewayTiruan();
  service = new CreateCheckoutService(new OrderRepository(), gateway);
});

const checkoutTamu = () =>
  service.execute({
    productId, targetNumber: "081234567890", paymentMethod: "PAYMENT_GATEWAY",
  });

describe("tamu tidak boleh memakai wallet — konstitusi §4.1", () => {
  it("menolak checkout wallet tanpa userId", async () => {
    await expect(
      service.execute({ productId, targetNumber: "0812", paymentMethod: "WALLET" }),
    ).rejects.toThrow();
  });

  it("tidak meninggalkan order apa pun setelah ditolak", async () => {
    await service
      .execute({ productId, targetNumber: "0812", paymentMethod: "WALLET" })
      .catch(() => {});
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("token tamu — konstitusi §4.2", () => {
  it("tamu menerima viewToken, dan database HANYA menyimpan hash-nya", async () => {
    const hasil = await checkoutTamu();

    expect(hasil.viewToken).toBeTruthy();
    expect(hasil.viewToken).toHaveLength(64); // 32 byte hex

    const order = await prisma.order.findUniqueOrThrow({
      where: { orderCode: hasil.orderCode },
    });

    // Yang tersimpan adalah sidik jarinya, bukan tokennya. Kalau suatu saat ada
    // yang menyimpan token mentah, pembobol database langsung bisa membuka
    // setiap pesanan tamu.
    expect(order.viewTokenHash).toBeTruthy();
    expect(order.viewTokenHash).not.toBe(hasil.viewToken);

    const { createHash } = await import("node:crypto");
    expect(order.viewTokenHash).toBe(
      createHash("sha256").update(hasil.viewToken!).digest("hex"),
    );
  });

  it("token mentah tidak muncul di kolom mana pun pada baris order", async () => {
    const hasil = await checkoutTamu();
    const order = await prisma.order.findUniqueOrThrow({
      where: { orderCode: hasil.orderCode },
    });

    const semuaNilai = JSON.stringify(order);
    expect(semuaNilai).not.toContain(hasil.viewToken);
  });

  it("member TIDAK menerima viewToken", async () => {
    const hasil = await service.execute({
      productId, targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY", userId: memberId,
    });
    expect(hasil.viewToken).toBeUndefined();
  });
});

describe("snapshot harga sadar tier", () => {
  it("agent membayar lebih murah daripada member untuk produk yang sama", async () => {
    const hasilMember = await service.execute({
      productId, targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY", userId: memberId,
    });
    const hasilAgent = await service.execute({
      productId, targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY", userId: agentId,
    });

    expect(hasilMember.amount).toBe(12_000);          // 10_000 + 2_000 × 1.0
    expect(hasilAgent.amount).toBe(11_200);           // 10_000 + 2_000 × 0.6
  });

  it("harga dibekukan di baris order, bukan dihitung ulang saat dibaca", async () => {
    const hasil = await service.execute({
      productId, targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY", userId: agentId,
    });

    // Harga produk berubah SETELAH order dibuat.
    await prisma.product.update({
      where: { id: productId },
      data: { providerPrice: 99_000, margin: 50_000, sellingPrice: 149_000 },
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { orderCode: hasil.orderCode } });
    expect(Number(order.amount)).toBe(11_200);
    expect(Number(order.basePrice)).toBe(10_000);
    expect(Number(order.markup)).toBe(1_200);
  });

  it("nominal yang dikirim ke gateway sama dengan yang dicatat di order", async () => {
    const hasil = await service.execute({
      productId, targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY", userId: agentId,
    });

    expect(gateway.permintaan).toHaveLength(1);
    expect(gateway.permintaan[0].amount).toBe(hasil.amount);
  });
});

describe("produk yang tidak layak dijual", () => {
  it("menolak produk yang tidak aktif", async () => {
    await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
    await expect(checkoutTamu()).rejects.toThrow();
    expect(await prisma.order.count()).toBe(0);
  });

  it("menolak produk yang stoknya habis", async () => {
    await prisma.product.update({ where: { id: productId }, data: { stock: false } });
    await expect(checkoutTamu()).rejects.toThrow();
    expect(await prisma.order.count()).toBe(0);
  });

  it("menolak produk yang tidak ada", async () => {
    await expect(
      service.execute({ productId: "tidak-ada", targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY" }),
    ).rejects.toThrow();
  });

  it("menolak input yang tidak lengkap", async () => {
    await expect(
      service.execute({ productId: "", targetNumber: "0812", paymentMethod: "PAYMENT_GATEWAY" }),
    ).rejects.toThrow();
    await expect(
      service.execute({ productId, targetNumber: "", paymentMethod: "PAYMENT_GATEWAY" }),
    ).rejects.toThrow();
  });
});

describe("saldo wallet tidak cukup", () => {
  it("ditolak, dan tidak meninggalkan order maupun ledger", async () => {
    await prisma.wallet.create({ data: { userId: memberId, balance: 5_000 } });

    await expect(
      service.execute({ productId, targetNumber: "0812", paymentMethod: "WALLET", userId: memberId }),
    ).rejects.toThrow();

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
    // Saldo tidak tersentuh sama sekali.
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: memberId } });
    expect(Number(wallet.balance)).toBe(5_000);
  });

  it("pengguna tanpa dompet sama sekali juga ditolak", async () => {
    await expect(
      service.execute({ productId, targetNumber: "0812", paymentMethod: "WALLET", userId: memberId }),
    ).rejects.toThrow();
    expect(await prisma.order.count()).toBe(0);
  });
});
