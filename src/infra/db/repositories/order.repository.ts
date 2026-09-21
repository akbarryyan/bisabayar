import { prisma } from "@/src/infra/db/prisma";
import { Prisma } from "@prisma/client";
import { OrderStatus, InvoiceStatus } from "@/src/core/domain/enums/order.enum";
import { getLogger } from "@/lib/logger";

const log = getLogger("db");

// ─── Input Types ────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  orderCode: string;
  userId?: string;
  productId: string;
  sellerId?: string;
  sellerProductId?: string;
  provider: string;       // DIGIFLAZZ | VIP_RESELLER
  targetNumber: string;
  targetData?: Prisma.InputJsonValue;
  whatsapp?: string;
  basePrice: number;
  markup: number;
  fee: number;
  discount?: number;       // Voucher discount applied
  voucherCode?: string;   // Voucher code used
  amount: number;
  sellerGrossProfit?: number;
  sellerFeeAmount?: number;
  sellerCommission?: number;
  status: OrderStatus;
  paymentMethod: string;
  viewTokenHash?: string; // guest only — raw token never stored
}

export interface CreateInvoiceInput {
  orderId: string;
  gatewayName: string;
  invoiceId: string;
  amount: number;
  fee: number;
  totalPayment: number;
  method?: string;
  paymentNumber?: string;
  paymentUrl?: string;
  expiredAt?: Date;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class OrderRepository {
  // ── Order CRUD ──────────────────────────────────────────────────────────

  async create(input: CreateOrderInput) {
    return prisma.order.create({
      data: {
        orderCode: input.orderCode,
        userId: input.userId ?? null,
        productId: input.productId,
        sellerId: input.sellerId ?? null,
        sellerProductId: input.sellerProductId ?? null,
        provider: input.provider,
        targetNumber: input.targetNumber,
        targetData: input.targetData ?? undefined,
        whatsapp: input.whatsapp ?? null,
        basePrice: input.basePrice,
        markup: input.markup,
        fee: input.fee,
        discount: input.discount ?? 0,
        voucherCode: input.voucherCode ?? null,
        amount: input.amount,
        sellerGrossProfit: input.sellerGrossProfit ?? 0,
        sellerFeeAmount: input.sellerFeeAmount ?? 0,
        sellerCommission: input.sellerCommission ?? 0,
        status: input.status,
        paymentMethod: input.paymentMethod,
        viewTokenHash: input.viewTokenHash ?? null,
      },
      include: { product: true, seller: true, sellerProduct: true },
    });
  }

  async findByCode(orderCode: string) {
    return prisma.order.findUnique({
      where: { orderCode },
      include: { product: true, paymentInvoice: true, user: true, seller: true, sellerProduct: true },
    });
  }

  async findById(id: string) {
    return prisma.order.findUnique({
      where: { id },
      include: { product: true, paymentInvoice: true, user: true, seller: true, sellerProduct: true },
    });
  }

  async findByProviderRef(providerRef: string) {
    return prisma.order.findFirst({
      where: { providerRef },
      include: { product: true, paymentInvoice: true, user: true, seller: true, sellerProduct: true },
    });
  }

  async findByViewTokenHash(hash: string) {
    return prisma.order.findUnique({
      where: { viewTokenHash: hash },
      include: { product: true, paymentInvoice: true, seller: true, sellerProduct: true },
    });
  }

  /**
   * Atomic claim: transitions order from PAID → PROCESSING_PROVIDER.
   * Uses updateMany with WHERE status check so only ONE caller wins the race.
   * Returns true if this caller successfully claimed the order.
   */
  async claimForProcessing(orderId: string): Promise<boolean> {
    const result = await prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: [OrderStatus.PAID, OrderStatus.CREATED] },
      },
      data: { status: OrderStatus.PROCESSING_PROVIDER },
    });
    return result.count > 0;
  }

  async updateStatus(orderId: string, status: OrderStatus, extra?: {
    serialNumber?: string;
    providerRef?: string;
    notes?: string;
  }) {
    return prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(extra?.serialNumber !== undefined && { serialNumber: extra.serialNumber }),
        ...(extra?.providerRef !== undefined && { providerRef: extra.providerRef }),
        ...(extra?.notes !== undefined && { notes: extra.notes }),
      },
    });
  }

  /**
   * Klaim atomik sebuah transisi status.
   *
   * `updateStatus` di atas menerima transisi apa pun — database tidak tahu
   * apa-apa soal state machine di konstitusi §2.3 — dan selalu "berhasil",
   * sehingga pemanggil tidak bisa membedakan "saya yang memindahkan status"
   * dari "statusnya kebetulan sudah benar".
   *
   * Pembedaan itu yang menentukan siapa boleh menyentuh uang. Pola yang dipakai
   * sama persis dengan `claimForProcessing`: `updateMany` dengan syarat status,
   * lalu periksa `count`. MySQL mengevaluasi klausa where dengan kunci baris
   * saat UPDATE berjalan, jadi dari sekian pemanggil bersamaan hanya satu yang
   * bisa mengubah baris — dan hanya dia yang menerima `true`.
   */
  async claimStatusTransition(
    orderId: string,
    from: OrderStatus[],
    to: OrderStatus,
    extra?: { serialNumber?: string; providerRef?: string; notes?: string },
  ): Promise<boolean> {
    const hasil = await prisma.order.updateMany({
      where: { id: orderId, status: { in: from } },
      data: {
        status: to,
        ...(extra?.serialNumber !== undefined && { serialNumber: extra.serialNumber }),
        ...(extra?.providerRef !== undefined && { providerRef: extra.providerRef }),
        ...(extra?.notes !== undefined && { notes: extra.notes }),
      },
    });
    return hasil.count > 0;
  }

  // ── Payment Invoice ──────────────────────────────────────────────────────

  async createInvoice(input: CreateInvoiceInput) {
    return prisma.paymentInvoice.create({
      data: {
        orderId: input.orderId,
        gatewayName: input.gatewayName,
        invoiceId: input.invoiceId,
        amount: input.amount,
        fee: input.fee,
        totalPayment: input.totalPayment,
        method: input.method ?? null,
        paymentNumber: input.paymentNumber ?? null,
        paymentUrl: input.paymentUrl ?? null,
        status: InvoiceStatus.PENDING,
        expiredAt: input.expiredAt ?? null,
      },
    });
  }

  async findInvoiceByInvoiceId(invoiceId: string) {
    return prisma.paymentInvoice.findUnique({ where: { invoiceId } });
  }

  async updateInvoiceStatus(
    invoiceId: string,
    status: InvoiceStatus,
    extra?: { paidAt?: Date; rawPayload?: Prisma.InputJsonValue | typeof Prisma.JsonNull }
  ) {
    return prisma.paymentInvoice.update({
      where: { invoiceId },
      data: {
        status,
        ...(extra?.paidAt && { paidAt: extra.paidAt }),
        ...(extra?.rawPayload !== undefined && { rawPayload: extra.rawPayload }),
      },
    });
  }

  // ── Webhook Idempotency ──────────────────────────────────────────────────

  /** Returns existing event if already processed; creates new record if not */
  async findOrCreateWebhookEvent(data: {
    source: string;
    eventId: string;
    eventType: string;
    payload: Prisma.InputJsonValue;
  }) {
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId: data.eventId },
    });

    // `alreadyProcessed` — BUKAN sekadar "barisnya sudah ada".
    //
    // Baris ini dibuat sebelum pemrosesan dimulai, jadi keberadaannya hanya
    // berarti "pernah dicoba". Memperlakukan itu sebagai duplikat membuat
    // percobaan yang GAGAL ikut terkunci: gateway mengirim ulang callback,
    // kita menolaknya sebagai duplikat, dan order tertinggal di status PAID
    // tanpa ada yang menyelesaikannya.
    //
    // Pemrosesan ulang aman karena setiap jalur hilir menjaga idempotensinya
    // sendiri di dalam satu transaksi: topup dijaga walletTopup.status,
    // order dijaga OrderStatus, penarikan dijaga status permintaan beserta
    // ledger WITHDRAW_PAID/WITHDRAW_RELEASE, dan eksekusi provider dijaga
    // claimForProcessing.
    if (existing) return { event: existing, alreadyProcessed: existing.processed };

    const event = await prisma.webhookEvent.create({
      data: {
        source: data.source,
        eventId: data.eventId,
        eventType: data.eventType,
        payload: data.payload,
        processed: false,
      },
    });
    return { event, alreadyProcessed: false };
  }

  async markWebhookProcessed(eventId: string, error?: string) {
    return prisma.webhookEvent.update({
      where: { eventId },
      data: {
        processed: !error,
        processedAt: new Date(),
        errorMessage: error ?? null,
      },
    });
  }

  // ── Provider Logs ────────────────────────────────────────────────────────

  async logProviderAction(data: {
    orderId: string;
    provider: string;
    action: string;
    request?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    response?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    success: boolean;
    errorMessage?: string;
  }) {
    try {
      return await prisma.orderProviderLog.create({
        data: {
          orderId: data.orderId,
          provider: data.provider,
          action: data.action,
          request: data.request ?? undefined,
          response: data.response ?? undefined,
          success: data.success,
          errorMessage: data.errorMessage ?? null,
        },
      });
    } catch (err) {
      // Logging failure must not break the flow
      log.error({ err }, "failed to log provider action");
    }
  }

  // ── Wallet ───────────────────────────────────────────────────────────────

  async getWalletByUserId(userId: string) {
    return prisma.wallet.findUnique({ where: { userId } });
  }

  /**
   * HOLD saldo. Mengembalikan wallet bila berhasil, null bila saldo tidak cukup.
   *
   * Pemeriksaan kecukupan dan pengurangan saldo WAJIB terjadi dalam satu
   * pernyataan UPDATE. Versi sebelumnya membaca saldo, memeriksanya di
   * JavaScript, lalu menulis kembali nilai absolut hasil hitungan itu —
   * membungkusnya dengan $transaction tidak menolong, karena findUnique
   * menghasilkan SELECT tanpa kunci dan di bawah REPEATABLE READ setiap
   * transaksi membaca snapshot yang sama. Sepuluh checkout bersamaan atas
   * saldo yang hanya cukup untuk satu semuanya lolos, dan saldo akhirnya
   * tetap terlihat wajar karena semua menulis nilai akhir yang identik.
   * Lihat tests/wallet-hold-concurrency.test.ts.
   *
   * `updateMany` dipakai karena `update` melempar bila tidak ada baris cocok,
   * sedangkan di sini "tidak cocok" adalah hasil normal: saldo tidak cukup.
   * Klausa `balance: { gte: amount }` dievaluasi ulang oleh MySQL saat UPDATE
   * dijalankan dengan kunci baris, bukan terhadap snapshot pembacaan awal.
   */
  async holdWalletBalance(userId: string, amount: number, orderId: string) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error("Wallet not found");

      const { count } = await tx.wallet.updateMany({
        where: { userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });

      // Nol baris berubah = saldo tidak mencukupi saat UPDATE dijalankan.
      if (count === 0) return null;

      // Baca ulang setelah UPDATE: baris sudah terkunci oleh transaksi ini,
      // jadi nilainya pasti dan tidak bisa disalip transaksi lain.
      const updated = await tx.wallet.findUniqueOrThrow({
        where: { userId },
        select: { balance: true },
      });
      const balanceAfter = Number(updated.balance);
      const balanceBefore = balanceAfter + amount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: "HOLD",
          amount,
          balanceBefore,
          balanceAfter,
          reference: orderId,
          description: `HOLD for order ${orderId}`,
        },
      });

      return wallet;
    });
  }

  /** Finalize debit (after SUCCESS) — balance already reduced by HOLD; just record ledger */
  async finalizeDebitLedger(userId: string, amount: number, orderId: string) {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return;
    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        type: "DEBIT",
        amount,
        balanceBefore: Number(wallet.balance),
        balanceAfter: Number(wallet.balance),
        reference: orderId,
        description: `DEBIT finalized for order ${orderId}`,
      },
    });
  }

  /** Release hold (after FAILED) — restore balance, record ledger */
  async releaseWalletHold(userId: string, amount: number, orderId: string) {
    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) return;

      // increment atomik: nilai akhir dihitung MySQL dari baris terkini,
      // bukan dari snapshot yang mungkin sudah basi saat UPDATE dijalankan.
      const updated = await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      const balanceAfter = Number(updated.balance);
      const balanceBefore = balanceAfter - amount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: "RELEASE",
          amount,
          balanceBefore,
          balanceAfter,
          reference: orderId,
          description: `HOLD released for order ${orderId}`,
        },
      });
    });
  }

  /** Refund paid gateway order back to member wallet; idempotent per orderId */
  async refundPaidOrderToWallet(userId: string, amount: number, orderId: string) {
    return prisma.$transaction(async (tx) => {
      let wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId, balance: 0 },
        });
      }

      // Penjaga lapis pertama untuk data lama: bila ledger REFUND sudah ada
      // tetapi penanda di order belum sempat terisi backfill, hentikan di sini.
      const existingRefund = await tx.ledgerEntry.findFirst({
        where: {
          walletId: wallet.id,
          type: "REFUND",
          reference: orderId,
        },
        select: { id: true },
      });

      if (existingRefund) {
        return { duplicated: true, balanceAfter: Number(wallet.balance) };
      }

      // Penjaga sesungguhnya: klaim atomik pada Order. findFirst di atas
      // dibaca tanpa kunci, jadi dua pemanggil bersamaan bisa sama-sama
      // melewatinya. Hanya satu yang bisa mengubah refundedAt dari null.
      // Jalur ini terjangkau lewat reconcile, yang dipicu endpoint order publik.
      const klaimRefund = await tx.order.updateMany({
        where: { id: orderId, refundedAt: null },
        data: { refundedAt: new Date() },
      });

      if (klaimRefund.count === 0) {
        return { duplicated: true, balanceAfter: Number(wallet.balance) };
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      const balanceAfter = Number(updated.balance);
      const balanceBefore = balanceAfter - amount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: "REFUND",
          amount,
          balanceBefore,
          balanceAfter,
          reference: orderId,
          description: `Refund order ${orderId} setelah provider gagal`,
        },
      });

      return { duplicated: false, balanceAfter };
    });
  }

  async creditSellerCommission(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderCode: true,
          sellerId: true,
          sellerCommission: true,
          sellerCommissionCreditedAt: true,
        },
      });

      if (!order || !order.sellerId) return null;

      const commissionAmount = Number(order.sellerCommission ?? 0);
      if (commissionAmount <= 0) return null;

      // Klaim atomik. Membaca sellerCommissionCreditedAt lalu memeriksanya di
      // JavaScript memberi celah yang sama seperti bug saldo: dua pemanggil
      // bersamaan sama-sama melihat null dan keduanya membayar komisi.
      // Jalurnya terjangkau — creditSellerCommission dipanggil dari eksekusi
      // provider, dari reconcile (yang bisa dipicu endpoint order publik), dan
      // dari dua tempat di webhook VIP.
      //
      // updateMany mengembalikan jumlah baris yang benar-benar berubah, dan
      // MySQL mengevaluasi klausa where dengan kunci baris saat UPDATE berjalan.
      // Hanya satu pemanggil yang bisa mengubahnya dari null.
      const klaim = await tx.order.updateMany({
        where: { id: order.id, sellerCommissionCreditedAt: null },
        data: { sellerCommissionCreditedAt: new Date() },
      });
      if (klaim.count === 0) return null;

      let wallet = await tx.wallet.findUnique({ where: { userId: order.sellerId } });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId: order.sellerId, balance: 0 },
        });
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: commissionAmount } },
        select: { balance: true },
      });
      const balanceAfter = Number(updated.balance);
      const balanceBefore = balanceAfter - commissionAmount;

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          type: "COMMISSION",
          amount: commissionAmount,
          balanceBefore,
          balanceAfter,
          reference: order.id,
          description: `Komisi seller untuk order ${order.orderCode}`,
        },
      });

      return {
        sellerId: order.sellerId,
        commissionAmount,
        balanceBefore,
        balanceAfter,
      };
    });
  }

  // ── Admin & reconcile helpers ────────────────────────────────────────────

  /** Get orders stuck in PROCESSING_PROVIDER or PAID for reconciliation */
  /**
   * Order yang tersangkut di PAID / PROCESSING_PROVIDER lebih lama dari ambang.
   *
   * `limit` wajib diperhatikan: setiap order yang dikembalikan akan memicu satu
   * panggilan ke API provider saat direkonsiliasi. Tanpa batas, satu tumpukan
   * besar bisa membanjiri provider dalam satu sapuan.
   */
  async findPendingProviderOrders(olderThanMinutes = 5, limit = 100) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PROCESSING_PROVIDER, OrderStatus.PAID] },
        updatedAt: { lt: cutoff },
      },
      include: { product: true },
      orderBy: { updatedAt: "asc" }, // yang paling lama tersangkut lebih dulu
      take: limit,
    });
  }
}
