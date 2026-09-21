# Provider Management System

Sistem manajemen provider untuk Whuzpay PPOB yang mengikuti arsitektur **Ports & Adapters** dan **Service Layer Pattern** sesuai dengan WHUZPAY_CONSTITUTION.md.

## Fitur

### 1. Multi Provider Support
- **Digiflazz** - Provider PPOB utama
- **VIP Reseller** - Provider PPOB alternatif

### 2. Environment-based Switching
Setiap provider dapat dijalankan dalam mode:
- **Mock Mode** - Simulasi untuk development tanpa konsumsi saldo
- **Real Mode** - Koneksi ke provider nyata

### 3. Provider Management
- ✅ Cek saldo real-time
- ✅ Health check & latency monitoring
- ✅ Ambil daftar produk/layanan
- ✅ Status monitoring (Online/Offline/Degraded)

### 4. Mock Simulation
Mock provider mendukung berbagai scenario:
- `success` - Transaksi berhasil
- `failed` - Transaksi gagal
- `pending` - Transaksi tertunda
- `pending_then_success` - Tertunda lalu berhasil
- `random` - Random scenario

## Struktur Folder

```
src/
├── core/
│   ├── domain/
│   │   ├── enums/
│   │   │   └── provider.enum.ts        # Provider types & status
│   │   └── errors/
│   │       └── provider.errors.ts      # Domain errors
│   ├── ports/
│   │   └── provider.port.ts            # Provider interface
│   └── services/
│       └── provider/
│           └── provider-management.service.ts  # Business logic
│
└── infra/
    └── providers/
        ├── digiflazz/
        │   └── digiflazz.adapter.ts    # Digiflazz implementation
        ├── vip/
        │   └── vip.adapter.ts          # VIP Reseller implementation
        ├── mock/
        │   └── mock-provider.adapter.ts # Mock implementation
        └── provider.factory.ts          # Factory pattern
```

## API Endpoints

### 1. Get All Providers Info
```
GET /api/admin/providers
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "type": "DIGIFLAZZ",
      "mode": "mock",
      "balance": {
        "amount": 8500000,
        "currency": "IDR",
        "lastUpdated": "2026-02-17T10:30:00Z"
      },
      "health": {
        "status": "ONLINE",
        "latency": 420,
        "lastCheck": "2026-02-17T10:30:00Z",
        "message": "Provider is healthy"
      }
    }
  ]
}
```

### 2. Get Specific Provider Info
```
GET /api/admin/providers/{type}
```

Example: `/api/admin/providers/digiflazz`

### 3. Get All Products
```
GET /api/admin/providers/products
```

### 4. Get Provider Products
```
GET /api/admin/providers/{type}/products
```

Example: `/api/admin/providers/digiflazz/products`

## Environment Variables

```env
# Provider Mode
PROVIDER_DIGIFLAZZ_MODE=mock    # mock | real
PROVIDER_VIP_MODE=mock          # mock | real

# Mock Simulation
MOCK_PROVIDER_SCENARIO=success  # random | success | failed | pending | pending_then_success
MOCK_PROVIDER_DELAY_MS=1000     # Delay simulasi (ms)

# Digiflazz (Real Mode)
DIGIFLAZZ_USERNAME=your_username
DIGIFLAZZ_API_KEY=your_api_key
DIGIFLAZZ_BASE_URL=https://api.digiflazz.com/v1

# VIP Reseller (Real Mode)
VIP_API_ID=your_api_id
VIP_API_KEY=your_api_key
VIP_SIGN=your_sign_key
VIP_BASE_URL=https://vip-reseller.co.id/api
```

## Usage

### 1. Development dengan Mock
```env
PROVIDER_DIGIFLAZZ_MODE=mock
PROVIDER_VIP_MODE=mock
MOCK_PROVIDER_SCENARIO=success
```

### 2. Staging dengan Mix Mode
```env
PROVIDER_DIGIFLAZZ_MODE=real
PROVIDER_VIP_MODE=mock
```

### 3. Production
```env
PROVIDER_DIGIFLAZZ_MODE=real
PROVIDER_VIP_MODE=real
```

## Admin UI

Akses halaman provider management:
```
http://localhost:3000/admin/providers
```

Fitur UI:
- 📊 Real-time saldo & health monitoring
- 🔄 Refresh data dengan satu klik
- 🔌 Status koneksi per provider
- 📦 Daftar produk dengan filter
- 🏷️ Mode indicator (Mock/Real)
- ⚡ Latency monitoring

## Keamanan

✅ **Clean Separation**: UI tidak contain business logic
✅ **Service Layer**: Semua logic di service layer
✅ **Port Interface**: Provider tidak directly coupled
✅ **Error Handling**: Domain errors dengan friendly message
✅ **Testable**: Mock mode untuk testing tanpa konsumsi saldo

## Testing

### Manual Test
1. Akses `/admin/providers`
2. Klik "Refresh" untuk update data
3. Klik "Lihat Produk" untuk filter produk provider
4. Klik "Test Koneksi" untuk health check

### Development Tips
- Gunakan `MOCK_PROVIDER_SCENARIO=random` untuk simulate berbagai kondisi
- Set `MOCK_PROVIDER_DELAY_MS` sesuai kebutuhan testing
- Monitor latency untuk optimasi performance

## Integrasi dengan Transaction Flow

Provider system ini akan digunakan oleh:
- ✅ Checkout Service - untuk validasi produk
- ✅ Provider Purchase Job - untuk eksekusi transaksi
- ✅ Webhook Handler - untuk update status
- ✅ Admin Dashboard - untuk monitoring

## Roadmap

- [ ] Provider balance alert/notification
- [ ] Auto-failover antar provider
- [ ] Provider log history
- [ ] Product sync scheduler
- [ ] Price comparison tool
- [ ] Provider performance analytics

---

**Built with Clean Architecture principles**  
Mengikuti WHUZPAY_CONSTITUTION.md dan WHUZPAY_PROJECT.md

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

Lapis kedua tidak bisa dihilangkan. `releaseWalletHold` tidak punya penjaga
idempotensi sendiri — ia hanya menambah saldo — jadi yang melindunginya adalah
klaim itu. Tanpanya, sepuluh kiriman ulang beriringan menghasilkan sepuluh ledger
`RELEASE` untuk satu order; angka itu terukur di
`tests/vip-callback-idempotency.test.ts`.

Bila webhook VIP tiba-tiba tertolak 401 setelah deploy, kemungkinan besar VIP tidak
mengirim header. Setel `VIP_WEBHOOK_SIGNATURE_REQUIRED` ke `false` lewat
`/admin/settings` — berlaku seketika, tanpa deploy. Selama jendela itu order tetap
terpenuhi oleh sapuan rekonsiliasi.

Rancangan lengkap beserta risiko yang diterima:
`docs/superpowers/specs/2026-09-21-vip-webhook-auth-design.md`
