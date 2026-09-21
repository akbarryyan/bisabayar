/**
 * Klaim transisi status order harus atomik.
 *
 * updateStatus() menerima transisi apa pun dan selalu "berhasil", jadi pemanggil
 * tidak bisa membedakan "saya yang memindahkan status" dari "statusnya kebetulan
 * sudah benar". Pembedaan itulah yang menentukan siapa yang boleh menyentuh uang.
 *
 * Tanpa klaim atomik, sepuluh callback bersamaan sama-sama merasa menang.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { OrderRepository } from "@/src/infra/db/repositories/order.repository";
import { OrderStatus } from "@/src/core/domain/enums/order.enum";

const prisma = new PrismaClient();
const repo = new OrderRepository();

const PARALEL = 10;

let productId: string;

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();

  const product = await prisma.product.create({
    data: {
      provider: "VIP_RESELLER", providerCode: "KLAIM-1", name: "Produk Uji",
      category: "UJI", brand: "UJI", type: "PREPAID",
      providerPrice: 0, sellingPrice: 0,
    },
  });
  productId = product.id;
});

const buatOrder = (status: string) =>
  prisma.order.create({
    data: {
      orderCode: `WP-KLAIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      productId, targetNumber: "0812", amount: 10_000,
      status, paymentMethod: "WALLET",
    },
  });

describe("claimStatusTransition", () => {
  it(`${PARALEL} klaim bersamaan hanya boleh dimenangkan SATU pemanggil`, async () => {
    const order = await buatOrder("PROCESSING_PROVIDER");

    const hasil = await Promise.all(
      Array.from({ length: PARALEL }, () =>
        repo.claimStatusTransition(
          order.id,
          [OrderStatus.PAID, OrderStatus.PROCESSING_PROVIDER],
          OrderStatus.FAILED,
          { notes: "uji" },
        ),
      ),
    );

    const menang = hasil.filter(Boolean).length;
    console.log(`\n  pemenang klaim=${menang}  (seharusnya 1)\n`);
    expect(menang).toBe(1);

    const akhir = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(akhir.status).toBe("FAILED");
  });

  it("menolak klaim bila status saat ini di luar daftar `from`", async () => {
    const order = await buatOrder("SUCCESS");

    const menang = await repo.claimStatusTransition(
      order.id,
      [OrderStatus.PAID, OrderStatus.PROCESSING_PROVIDER],
      OrderStatus.FAILED,
    );

    expect(menang).toBe(false);
    const akhir = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(akhir.status).toBe("SUCCESS");
  });

  it("menulis serialNumber dan notes saat klaim menang", async () => {
    const order = await buatOrder("PAID");

    const menang = await repo.claimStatusTransition(
      order.id,
      [OrderStatus.PAID, OrderStatus.PROCESSING_PROVIDER],
      OrderStatus.SUCCESS,
      { serialNumber: "SN-123", notes: "VIP webhook: success | SN: SN-123" },
    );

    expect(menang).toBe(true);
    const akhir = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(akhir.status).toBe("SUCCESS");
    expect(akhir.serialNumber).toBe("SN-123");
    expect(akhir.notes).toBe("VIP webhook: success | SN: SN-123");
  });

  it("tidak menimpa serialNumber yang ada bila extra tidak diisi", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `WP-KLAIM-SN-${Date.now()}`,
        productId, targetNumber: "0812", amount: 10_000,
        status: "PAID", paymentMethod: "WALLET", serialNumber: "SN-LAMA",
      },
    });

    await repo.claimStatusTransition(order.id, [OrderStatus.PAID], OrderStatus.FAILED);

    const akhir = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(akhir.serialNumber).toBe("SN-LAMA");
  });
});
