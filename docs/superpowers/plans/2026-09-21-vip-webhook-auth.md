# VIP Webhook Auth & Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tutup empat cacat autentikasi dan idempotensi pada webhook VIP Reseller sehingga callback palsu ditolak dan callback berulang tidak dapat memindahkan uang lebih dari sekali.

**Architecture:** Logika webhook dipindah dari route handler ke `lib/vip-callback.ts`, meniru struktur `lib/poppay-callback.ts` yang sudah terbukti. Route menjadi tipis: parse → verifikasi → delegasi. Idempotensi ditegakkan dua lapis: baris `WebhookEvent` di hulu, dan klaim status atomik (`updateMany` + periksa `count`) tepat sebelum setiap sentuhan uang.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma 5 + MySQL 8.4, Vitest (test integrasi terhadap MySQL sekali pakai), pino.

**Spec:** [`docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md`](../specs/2026-09-21-vip-webhook-auth-design.md)

## Global Constraints

- Konstitusi project berlaku penuh: [`docs/WHUZPAY_CONSTITUTION.md`](../../WHUZPAY_CONSTITUTION.md). Yang paling relevan: §2.1 (penjaga idempotensi wajib ditegakkan database, bukan diperiksa di JavaScript), §2.1b (event yang belum tuntas dibiarkan terbuka), §2.3 (disiplin state machine), §9.3 (webhook gateway tidak dibatasi rate limit).
- `tsc --noEmit` harus lulus. Repo saat ini bersih — jangan menurunkannya.
- ESLint melarang `console` di `app/`, `lib/`, `src/`. Gunakan `getLogger()` dari `@/lib/logger`.
- Nama berkas `kebab-case.ts`.
- Commit memakai conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.
- Test adalah test **integrasi** terhadap MySQL sekali pakai, bukan unit dengan tiruan. Alasannya di [`docs/TESTING.md`](../../TESTING.md).
- Menjalankan test butuh database uji hidup:
  ```bash
  npm run test:db:up && npm run test:db:push
  ```
  `tests/setup.ts` menolak jalan bila `DATABASE_URL` bukan `whuz_test` di port `3399`.
- Jangan menyentuh `updateStatus()`, `releaseWalletHold()`, atau `refundPaidOrderToWallet()` yang sudah ada. Keduanya punya pemanggil lain dan berada di luar ruang lingkup. Lihat §8 spec.
- Penegakan IP allowlist **sengaja tidak dibangun** (keputusan D7). IP hanya dicatat.

---

## Task 1: Ekstrak pembanding signature ke `lib/webhook-signature.ts`

`safeEqualHex` saat ini adalah fungsi privat di dalam route Poppay. Webhook VIP membutuhkan perbandingan yang sama. Mengangkatnya lebih dulu berarti Task 3 tinggal mengimpor.

**Files:**
- Create: `lib/webhook-signature.ts`
- Create: `tests/webhook-signature.test.ts`
- Modify: `app/api/webhook/poppay/route.ts` (hapus fungsi lokal baris 27-40, ganti dengan impor)

**Interfaces:**
- Produces: `safeEqualHex(left: string, right: string): boolean`

- [ ] **Step 1: Tulis test yang gagal**

Buat `tests/webhook-signature.test.ts`:

```ts
/**
 * Perbandingan digest signature webhook.
 *
 * Kasus yang paling penting ada di test "dua string kosong": kredensial yang
 * belum diisi menghasilkan digest kosong di KEDUA sisi, dan perbandingan naif
 * akan menyatakannya cocok — artinya konfigurasi yang belum lengkap justru
 * meloloskan semua orang.
 */
import { describe, expect, it } from "vitest";
import { safeEqualHex } from "@/lib/webhook-signature";

describe("safeEqualHex", () => {
  it("menerima digest yang sama persis", () => {
    const digest = "a".repeat(32);
    expect(safeEqualHex(digest, digest)).toBe(true);
  });

  it("mengabaikan beda huruf besar-kecil dan spasi di tepi", () => {
    expect(safeEqualHex("ABCDEF0123456789", "  abcdef0123456789 ")).toBe(true);
  });

  it("menolak digest yang berbeda", () => {
    expect(safeEqualHex("a".repeat(32), "b".repeat(32))).toBe(false);
  });

  it("menolak dua string kosong", () => {
    expect(safeEqualHex("", "")).toBe(false);
  });

  it("menolak bila salah satu sisi kosong", () => {
    expect(safeEqualHex("a".repeat(32), "")).toBe(false);
    expect(safeEqualHex("", "a".repeat(32))).toBe(false);
  });

  it("menolak panjang yang berbeda tanpa melempar", () => {
    expect(safeEqualHex("abc", "abcdef")).toBe(false);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

```bash
npm test -- tests/webhook-signature.test.ts
```

Harapan: GAGAL dengan `Failed to resolve import "@/lib/webhook-signature"`.

- [ ] **Step 3: Buat `lib/webhook-signature.ts`**

Isinya dipindahkan apa adanya dari `app/api/webhook/poppay/route.ts` baris 27-40 — nol perubahan perilaku:

```ts
/**
 * Perbandingan signature webhook.
 *
 * Diangkat dari app/api/webhook/poppay/route.ts supaya webhook Poppay dan VIP
 * memakai pembanding yang sama. Keduanya membandingkan digest heksadesimal.
 */
import crypto from "crypto";

/**
 * Bandingkan dua digest hex tanpa membocorkan posisi byte yang berbeda lewat
 * waktu eksekusi.
 *
 * Nilai kosong SELALU gagal. Ini disengaja: kredensial yang belum diisi
 * menghasilkan digest kosong di kedua sisi, dan memperlakukannya sebagai cocok
 * akan mengubah konfigurasi yang belum lengkap menjadi pintu terbuka.
 */
export function safeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft.length !== normalizedRight.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(normalizedLeft, "utf8"),
      Buffer.from(normalizedRight, "utf8")
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

```bash
npm test -- tests/webhook-signature.test.ts
```

Harapan: 6 test lulus.

- [ ] **Step 5: Alihkan route Poppay ke fungsi bersama**

Di `app/api/webhook/poppay/route.ts`, hapus seluruh definisi `function safeEqualHex(...)` (baris 27-40) dan tambahkan impor di antara impor yang sudah ada:

```ts
import { safeEqualHex } from "@/lib/webhook-signature";
```

Jangan ubah apa pun yang lain di berkas itu. `import crypto from "crypto"` tetap dipakai oleh `computeHmacSha256` dan `computeSha256`.

- [ ] **Step 6: Pastikan jalur Poppay tidak berubah**

```bash
npx tsc --noEmit
npm test -- tests/webhook-idempotency.test.ts
```

Harapan: `tsc` keluar tanpa output, test idempotensi Poppay lulus seperti sebelumnya.

- [ ] **Step 7: Commit**

```bash
git add lib/webhook-signature.ts tests/webhook-signature.test.ts app/api/webhook/poppay/route.ts
git commit -m "refactor: angkat safeEqualHex ke lib/webhook-signature.ts

Webhook VIP akan memakai pembanding yang sama. Tidak ada perubahan
perilaku pada jalur Poppay.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `claimStatusTransition()` pada OrderRepository

Ini fondasi perbaikannya. `updateStatus()` yang ada menerima transisi apa pun dan tidak memberi tahu pemanggil apakah DIALAH yang memindahkan status. Tanpa itu, tidak ada cara aman memutuskan siapa yang boleh menyentuh uang.

**Files:**
- Modify: `src/infra/db/repositories/order.repository.ts` (sisipkan setelah `updateStatus`, yang berakhir di baris 139)
- Create: `tests/order-status-claim.test.ts`

**Interfaces:**
- Consumes: `OrderStatus` dari `@/src/core/domain/enums/order.enum`
- Produces: `OrderRepository.claimStatusTransition(orderId: string, from: OrderStatus[], to: OrderStatus, extra?: { serialNumber?: string; providerRef?: string; notes?: string }): Promise<boolean>` — `true` hanya untuk pemanggil yang benar-benar memindahkan baris

- [ ] **Step 1: Tulis test yang gagal**

Buat `tests/order-status-claim.test.ts`:

```ts
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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

```bash
npm run test:db:up && npm run test:db:push
npm test -- tests/order-status-claim.test.ts
```

Harapan: GAGAL dengan `repo.claimStatusTransition is not a function`.

- [ ] **Step 3: Tambahkan metodenya**

Di `src/infra/db/repositories/order.repository.ts`, sisipkan tepat setelah `updateStatus` (yang berakhir di baris 139), sebelum komentar `// ── Payment Invoice ──`:

```ts
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
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

```bash
npm test -- tests/order-status-claim.test.ts
```

Harapan: 4 test lulus, dan log mencetak `pemenang klaim=1`.

- [ ] **Step 5: Commit**

```bash
git add src/infra/db/repositories/order.repository.ts tests/order-status-claim.test.ts
git commit -m "feat(db): claimStatusTransition untuk transisi status atomik

Pemanggil kini bisa mengetahui apakah DIA yang memindahkan status, bukan
sekadar bahwa statusnya kini benar. Itu syarat untuk memutuskan siapa yang
boleh menyentuh uang. Konstitusi §2.1, §2.3.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `verifyVipWebhookAuth()`

Menutup cacat 1.1 dan 1.2: bypass signature dan kredensial dari sumber yang salah.

**Files:**
- Create: `lib/vip-callback.ts` (bagian autentikasi saja; `handleVipCallback` menyusul di Task 4)
- Create: `tests/vip-webhook-auth.test.ts`

**Interfaces:**
- Consumes: `safeEqualHex` dari Task 1, `getSiteConfigValue` dari `@/lib/site-config`
- Produces:
  ```ts
  export type VipAuthVerdict =
    | { ok: true; mode: "verified" | "skipped" }
    | { ok: false; reason: string };

  export async function verifyVipWebhookAuth(headers: Headers): Promise<VipAuthVerdict>;
  ```

**Catatan penting:** `getSiteConfigValue(key)` sudah jatuh ke `process.env[key]` ketika kunci belum ada di `site_configs` (lihat `lib/site-config.ts` baris 68-73). Jadi cukup `getSiteConfigValue("VIP_API_ID")` — jangan tambahkan fallback env manual. Ini juga bentuk yang dipakai `vip.adapter.ts`.

Nilainya di-cache 10 detik di `globalThis`. `setSiteConfig()` sudah memanggil `invalidateSiteConfigCache()`, jadi test wajib menulis lewat `setSiteConfig`, bukan `prisma.siteConfig.create`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `tests/vip-webhook-auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

```bash
npm test -- tests/vip-webhook-auth.test.ts
```

Harapan: GAGAL dengan `Failed to resolve import "@/lib/vip-callback"`.

- [ ] **Step 3: Buat `lib/vip-callback.ts` dengan bagian autentikasi**

```ts
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
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

```bash
npm test -- tests/vip-webhook-auth.test.ts
```

Harapan: 8 test lulus.

- [ ] **Step 5: Commit**

```bash
git add lib/vip-callback.ts tests/vip-webhook-auth.test.ts
git commit -m "fix(webhook): tegakkan signature VIP dan baca kredensial dari site_configs

Tanpa header X-Client-Signature, pemeriksaan lama tidak pernah dievaluasi
dan permintaan lolos. Kredensial juga dibaca dari process.env sementara
adapter memakai site_configs, sehingga pemeriksaan mati di produksi.

Jalan keluar VIP_WEBHOOK_SIGNATURE_REQUIRED=false tersedia lewat
/admin/settings bila VIP ternyata tidak mengirim header.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `handleVipCallback()` — WebhookEvent dan klaim atomik

Menutup cacat 1.3 dan 1.4. Ini task yang membuktikan lubang uangnya tertutup.

**Files:**
- Modify: `lib/vip-callback.ts` (tambah di bawah `verifyVipWebhookAuth`)
- Create: `tests/vip-callback-idempotency.test.ts`

**Interfaces:**
- Consumes: `OrderRepository.claimStatusTransition` (Task 2), `findOrCreateWebhookEvent`, `markWebhookProcessed`, `findByProviderRef`, `findById`, `creditSellerCommission`, `finalizeDebitLedger`, `releaseWalletHold`; `checkAndUpgradeUserTier` dari `@/lib/pricing`; `WebhookSource`, `OrderStatus` dari `@/src/core/domain/enums/order.enum`
- Produces:
  ```ts
  export interface VipCallbackPayload { data?: unknown; [key: string]: unknown }

  export type VipCallbackResult =
    | { action: "ignored"; reason: string }
    | { action: "duplicate" }
    | { action: "order_not_found" }
    | { action: "already_terminal"; orderId: string }
    | { action: "claimed"; status: "SUCCESS" | "FAILED"; orderId: string };

  export async function handleVipCallback(payload: VipCallbackPayload): Promise<VipCallbackResult>;
  ```

- [ ] **Step 1: Tulis test yang gagal**

Buat `tests/vip-callback-idempotency.test.ts`:

```ts
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
  it(`${PARALEL} callback error bersamaan hanya boleh melepas hold SEKALI`, async () => {
    const trxid = `TRX-${Date.now()}`;
    await buatOrder(trxid);

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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

```bash
npm test -- tests/vip-callback-idempotency.test.ts
```

Harapan: GAGAL dengan `handleVipCallback is not a function` (atau tidak diekspor).

- [ ] **Step 3: Tambahkan implementasinya ke `lib/vip-callback.ts`**

Tambahkan impor berikut di bagian atas berkas, di bawah impor yang sudah ada:

```ts
import type { Prisma } from "@prisma/client";
import { OrderRepository } from "@/src/infra/db/repositories/order.repository";
import { OrderStatus, WebhookSource } from "@/src/core/domain/enums/order.enum";
import { checkAndUpgradeUserTier } from "@/lib/pricing";
```

Lalu tambahkan di bawah `verifyVipWebhookAuth`:

```ts
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
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

```bash
npm test -- tests/vip-callback-idempotency.test.ts
```

Harapan: 6 test lulus. Log mencetak `baris RELEASE=1  saldo=50000`.

- [ ] **Step 5: Commit**

```bash
git add lib/vip-callback.ts tests/vip-callback-idempotency.test.ts
git commit -m "fix(webhook): idempotensi callback VIP lewat WebhookEvent dan klaim atomik

Penjaga lama adalah baca-lalu-periksa di JavaScript, yang dilarang
konstitusi §2.1. Dua callback beriringan sama-sama lolos dan
releaseWalletHold — yang tidak punya penjaga sendiri — dipanggil dua kali.

Order yang belum ditemukan sengaja tidak ditandai selesai, supaya kiriman
ulang VIP masih bisa menuntaskannya. Konstitusi §2.1b.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Pangkas route handler

**Files:**
- Modify: `app/api/webhook/vip/route.ts` (ganti seluruh isi)
- Modify: `tests/vip-webhook-auth.test.ts` (tambah blok describe di akhir)

**Interfaces:**
- Consumes: `verifyVipWebhookAuth`, `handleVipCallback`, `VipCallbackPayload` (Task 3 & 4); `clientIp` dari `@/lib/rate-limit`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di akhir `tests/vip-webhook-auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

```bash
npm test -- tests/vip-webhook-auth.test.ts
```

Harapan: tiga test pertama di blok baru GAGAL — route lama membalas 200 untuk permintaan tanpa header.

- [ ] **Step 3: Ganti seluruh isi `app/api/webhook/vip/route.ts`**

```ts
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

/** IP resmi VIP Reseller. Dicatat saja — lihat §7.2 spec. */
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

  // Penegakan IP sengaja TIDAK dilakukan — keputusan pemilik project, §7.2 spec.
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
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

```bash
npm test -- tests/vip-webhook-auth.test.ts
```

Harapan: 12 test lulus (8 dari Task 3 + 4 yang baru).

- [ ] **Step 5: Jalankan seluruh test dan lint**

```bash
npx tsc --noEmit
npm test
npx eslint app/api/webhook/vip/route.ts lib/vip-callback.ts lib/webhook-signature.ts
```

Harapan: `tsc` tanpa output; seluruh test lulus; eslint tanpa temuan pada tiga berkas itu.

Kalau `npm test` menunjukkan kegagalan di berkas test LAIN yang tidak kamu sentuh, hentikan dan laporkan — jangan perbaiki sambil jalan.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhook/vip/route.ts tests/vip-webhook-auth.test.ts
git commit -m "refactor(webhook): pangkas route VIP jadi parse, verifikasi, delegasi

Logikanya kini di lib/vip-callback.ts. Kegagalan autentikasi membalas 401,
bukan 200 seperti sebelumnya. Pencatatan IP dipindah ke clientIp() yang
mendahulukan x-real-ip; penegakannya tetap tidak dilakukan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Dokumentasi konfigurasi

Kunci `VIP_WEBHOOK_SIGNATURE_REQUIRED` adalah jalan keluar operasional. Kalau tidak terdokumentasi, ia tidak akan ditemukan saat dibutuhkan — yaitu saat webhook VIP sedang tertolak.

**Files:**
- Modify: `.env.example` (blok PROVIDER PPOB, setelah baris `VIP_BASE_URL`)
- Modify: `docs/PROVIDER_SYSTEM.md`
- Modify: `docs/WHUZPAY_PROJECT.md` (bagian 8, "Yang masih menjadi pekerjaan")

- [ ] **Step 1: Tambahkan kunci ke `.env.example`**

Sisipkan tepat setelah baris `VIP_BASE_URL="https://vip-reseller.co.id/api"`:

```
# Verifikasi signature callback VIP. Bawaannya "true" — callback tanpa header
# X-Client-Signature yang sah ditolak 401.
#
# Setel "false" HANYA bila VIP ternyata tidak mengirim header itu. Nilai di
# site_configs menimpa yang di sini, jadi ubahnya lewat /admin/settings supaya
# berlaku tanpa deploy.
#
# Perlu diketahui: signature VIP adalah md5(API_ID + API_KEY) — statis dan tidak
# terikat payload, jadi ia membuktikan pengirim tahu kredensial, bukan bahwa
# pesannya baru. Perlindungan kiriman ulang datang dari WebhookEvent.
VIP_WEBHOOK_SIGNATURE_REQUIRED=true
```

- [ ] **Step 2: Dokumentasikan di `docs/PROVIDER_SYSTEM.md`**

Tambahkan bagian baru di akhir berkas:

```markdown
## Webhook VIP Reseller

`POST /api/webhook/vip` menerima notifikasi status dari VIP.

| Hal | Nilai |
|---|---|
| Header signature | `X-Client-Signature: md5(API_ID + API_KEY)` |
| IP resmi VIP | `178.248.73.218` — dicatat, TIDAK ditegakkan |
| Kredensial | `site_configs` (`VIP_API_ID`, `VIP_API_KEY`), env sebagai cadangan |
| Penegakan signature | `VIP_WEBHOOK_SIGNATURE_REQUIRED`, bawaan `true` |

Signature VIP **statis** — sama untuk setiap permintaan dan tidak terikat payload.
Itu batasan protokol VIP, bukan pilihan kita. Ia membuktikan pengirim mengetahui
kredensial, bukan bahwa pesan ini baru.

Yang menahan pengiriman ulang karena itu bukan signature, melainkan:

1. Baris `WebhookEvent` dengan `eventId = vip:<trxid>:<status>` — menahan kiriman
   ulang yang pemrosesannya sudah tuntas.
2. `claimStatusTransition` — menahan callback yang datang beriringan. Hanya
   pemenang klaim yang boleh menyentuh uang.

Bila webhook VIP tiba-tiba tertolak 401 setelah deploy, kemungkinan besar VIP tidak
mengirim header. Setel `VIP_WEBHOOK_SIGNATURE_REQUIRED` ke `false` lewat
`/admin/settings` — berlaku seketika, tanpa deploy. Selama jendela itu order tetap
terpenuhi oleh sapuan rekonsiliasi.

Rancangan lengkap beserta risiko yang diterima:
`docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md`
```

- [ ] **Step 3: Perbarui daftar pekerjaan di `docs/WHUZPAY_PROJECT.md`**

Di bagian 8 "Yang masih menjadi pekerjaan", tambahkan satu butir:

```markdown
- **IP allowlist webhook VIP belum ditegakkan.** IP dicatat tetapi tidak menolak.
  Karena signature VIP statis dan replayable, penegakan IP adalah lapis berikutnya
  yang paling bernilai. Lihat §7.2 pada
  `docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/PROVIDER_SYSTEM.md docs/WHUZPAY_PROJECT.md
git commit -m "docs: konfigurasi dan batasan webhook VIP

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verifikasi akhir

- [ ] **Jalankan semuanya dari keadaan bersih**

```bash
npm run test:db:down && npm run test:db:up && npm run test:db:push
npx tsc --noEmit
npm test
npx eslint .
```

Harapan: `tsc` tanpa output. Seluruh test lulus — 8 berkas lama ditambah 4 berkas baru. Jumlah temuan eslint tidak boleh lebih banyak daripada sebelum pekerjaan ini (52 error, 19 warning pada berkas-berkas yang tidak disentuh).

- [ ] **Periksa kembali apa yang sebenarnya berubah**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Harapan: 6 commit. Berkas yang berubah persis: 3 berkas `lib/` baru/ubah, 1 route ditulis ulang, 1 route Poppay hanya berubah impor, 1 metode repository bertambah, 4 berkas test baru, 3 berkas dokumentasi.

---

## Catatan untuk pelaksana

**Yang paling mudah salah dalam pekerjaan ini:**

1. **Jangan mengubah `releaseWalletHold`.** Menambahkan penjaga di dalamnya terasa menggoda dan memang benar — tapi ia dipanggil dari lima tempat, dan mengubahnya membutuhkan cakupan test yang lebih luas. Itu tugas terpisah. Di sini yang melindunginya adalah klaim status atomik.

2. **Backfill komisi wajib membaca ulang order.** Snapshot `order` diambil sebelum klaim. Bila klaim kalah, status sebenarnya bisa `FAILED`, dan membayar komisi atas order gagal jauh lebih buruk daripada melewatkan backfill.

3. **Test harus menulis `site_configs` lewat `setSiteConfig()`.** Menulis langsung dengan `prisma.siteConfig.create` melewati `invalidateSiteConfigCache()`, dan cache 10 detik di `globalThis` akan membuat test lulus atau gagal tergantung urutan jalannya.

4. **Test integrasi tidak berjalan paralel.** `vitest.config.mts` menyetel `fileParallelism: false` karena semua berkas memakai satu database. Jangan mengubahnya.

5. **Status interim sengaja tidak mencatat `WebhookEvent`.** Kalau kamu tergoda mencatatnya demi kelengkapan: itu menumpuk baris untuk kejadian yang bukan keputusan, dan salah satu test mengunci perilaku ini.
