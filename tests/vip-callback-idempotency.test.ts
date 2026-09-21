/**
 * Idempotensi callback VIP.
 *
 * Kode sebelumnya menjaga diri dengan `if (order.status === FAILED) return` —
 * baca lalu periksa di JavaScript, persis pola yang dilarang konstitusi §2.1.
 * Dua callback beriringan sama-sama melihat status belum terminal, keduanya
 * lanjut, dan releaseWalletHold — yang TIDAK punya penjaga sendiri, ia hanya
 * increment saldo — dipanggil dua kali.
 *
 * Tidak butuh penyerang untuk memicunya. Cukup dua kiriman ulang dari VIP.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { handleVipCallback } from "@/lib/vip-callback";

const prisma = new PrismaClient();

const PARALEL = 10;
const NOMINAL = 50_000;

let userId: string;
let productId: string;

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  await prisma.webhookEvent.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { email: `vip-${Date.now()}@contoh.test`, name: "Uji", role: "MEMBER" },
  });
  userId = user.id;
  // Saldo 0: HOLD saat checkout sudah memotongnya. RELEASE mengembalikannya.
  await prisma.wallet.create({ data: { userId, balance: 0 } });

  const product = await prisma.product.create({
    data: {
      provider: "VIP_RESELLER", providerCode: "VIP-1", name: "Produk Uji",
      category: "UJI", brand: "UJI", type: "PREPAID",
      providerPrice: 0, sellingPrice: 0,
    },
  });
  productId = product.id;
});

const buatOrder = (providerRef: string, status = "PROCESSING_PROVIDER") =>
  prisma.order.create({
    data: {
      orderCode: `WP-VIP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      productId, userId, provider: "VIP_RESELLER",
      targetNumber: "0812", amount: NOMINAL,
      status, paymentMethod: "WALLET", providerRef,
    },
  });

const callbackGagal = (trxid: string) => ({
  result: true,
  data: [{ trxid, status: "error", note: "stok habis" }],
});

const callbackSukses = (trxid: string) => ({
  result: true,
  data: [{ trxid, status: "success", note: "SN-999" }],
});

const saldo = async () =>
  Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).balance);

describe("callback error bersamaan", () => {
  /**
   * Barisnya WebhookEvent sengaja DIBUAT LEBIH DULU dalam keadaan belum selesai.
   *
   * Tanpa itu, sepuluh pemanggil bersamaan berebut membuat baris dengan eventId
   * yang sama, dan constraint @unique pada kolom itu menggugurkan sembilan di
   * antaranya sebelum mereka menyentuh uang — sehingga yang teruji adalah
   * constraint, bukan klaim status. Test seperti itu lulus baik dengan maupun
   * tanpa perbaikan, jadi ia tidak membuktikan apa pun (konstitusi §13).
   *
   * Keadaan di bawah ini bukan rekaan: baris yang belum selesai persis itulah
   * yang ditinggalkan percobaan yang gagal, dan konstitusi §2.1b mewajibkan
   * kiriman ulang berikutnya tetap boleh masuk.
   */
  it(`${PARALEL} kiriman ulang bersamaan hanya boleh melepas hold SEKALI`, async () => {
    const trxid = `TRX-${Date.now()}`;
    await buatOrder(trxid);

    await prisma.webhookEvent.create({
      data: {
        source: "VIP_RESELLER",
        eventId: `vip:${trxid}:error`,
        eventType: "error",
        payload: { percobaan: "sebelumnya gagal" },
        processed: false,
        errorMessage: "percobaan sebelumnya gagal",
      },
    });

    await Promise.allSettled(
      Array.from({ length: PARALEL }, () => handleVipCallback(callbackGagal(trxid))),
    );

    const barisRelease = await prisma.ledgerEntry.count({ where: { type: "RELEASE" } });
    console.log(
      `\n  baris RELEASE=${barisRelease}  saldo=${await saldo()}` +
        `  (seharusnya 1 / ${NOMINAL})\n`,
    );

    expect(barisRelease).toBe(1);
    expect(await saldo()).toBe(NOMINAL);
  });

  /**
   * success dan error beriringan untuk order yang sama.
   *
   * eventId-nya berbeda (`:success` dan `:error`), jadi lapis WebhookEvent tidak
   * menggugurkan satu pun — keduanya sampai ke order. Hanya klaim status yang
   * bisa memutuskan siapa menang.
   *
   * Tanpa klaim: jalur sukses menulis DEBIT, jalur gagal menulis RELEASE, dan
   * saldo bertambah untuk order yang barangnya sudah terkirim.
   */
  it("success dan error beriringan hanya boleh menghasilkan SATU akibat uang", async () => {
    const trxid = `TRX-RACE2-${Date.now()}`;
    await buatOrder(trxid);

    await Promise.allSettled([
      handleVipCallback(callbackSukses(trxid)),
      handleVipCallback(callbackGagal(trxid)),
    ]);

    const release = await prisma.ledgerEntry.count({ where: { type: "RELEASE" } });
    const debit = await prisma.ledgerEntry.count({ where: { type: "DEBIT" } });
    console.log(`\n  RELEASE=${release}  DEBIT=${debit}  (jumlahnya seharusnya 1)\n`);

    expect(release + debit).toBe(1);
  });
});

describe("kiriman ulang berurutan", () => {
  it("callback yang sama dua kali tidak melepas hold dua kali", async () => {
    const trxid = `TRX-SEQ-${Date.now()}`;
    await buatOrder(trxid);

    const pertama = await handleVipCallback(callbackGagal(trxid));
    const kedua = await handleVipCallback(callbackGagal(trxid));

    expect(pertama.action).toBe("claimed");
    expect(kedua.action).toBe("duplicate");
    expect(await prisma.ledgerEntry.count({ where: { type: "RELEASE" } })).toBe(1);
    expect(await saldo()).toBe(NOMINAL);
  });

  it("callback sukses dua kali hanya menulis satu DEBIT", async () => {
    const trxid = `TRX-OK-${Date.now()}`;
    const order = await buatOrder(trxid);

    await handleVipCallback(callbackSukses(trxid));
    await handleVipCallback(callbackSukses(trxid));

    expect(await prisma.ledgerEntry.count({ where: { type: "DEBIT" } })).toBe(1);
    const akhir = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(akhir.status).toBe("SUCCESS");
    expect(akhir.serialNumber).toBe("SN-999");
  });
});

describe("order belum ditemukan", () => {
  it("TIDAK menandai event selesai, sehingga kiriman ulang masih bisa menuntaskan", async () => {
    const trxid = `TRX-RACE-${Date.now()}`;

    // VIP mendahului kita: callback datang sebelum providerRef tersimpan.
    const pertama = await handleVipCallback(callbackGagal(trxid));
    expect(pertama.action).toBe("order_not_found");

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { eventId: `vip:${trxid}:error` },
    });
    expect(event.processed).toBe(false);

    // Order menyusul, VIP mengirim ulang.
    await buatOrder(trxid);
    const kedua = await handleVipCallback(callbackGagal(trxid));

    expect(kedua.action).toBe("claimed");
    expect(await saldo()).toBe(NOMINAL);
  });
});

describe("status yang diabaikan", () => {
  it("status interim tidak mencatat WebhookEvent", async () => {
    const trxid = `TRX-WAIT-${Date.now()}`;
    await buatOrder(trxid);

    const hasil = await handleVipCallback({
      result: true, data: [{ trxid, status: "processing", note: "" }],
    });

    expect(hasil.action).toBe("ignored");
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("payload tanpa data diabaikan tanpa melempar", async () => {
    const hasil = await handleVipCallback({ result: false });
    expect(hasil.action).toBe("ignored");
  });
});
