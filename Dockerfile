# Image produksi bisabayar.
#
# VPS TIDAK PERNAH menjalankan `docker build` — image dibangun di laptop atau CI
# lalu di-push ke GHCR. Lihat docs/DEPLOYMENT.md.
#
# `prisma generate` sengaja dijalankan di dalam stage alpine: schema.prisma tidak
# menyetel binaryTargets, jadi engine yang terbentuk mengikuti platform tempat
# generate berjalan. Kalau digenerate di luar (glibc) lalu disalin ke alpine
# (musl), Prisma gagal saat runtime dengan pesan yang menyesatkan.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
# openssl dibutuhkan Prisma; libc6-compat untuk binary yang menganggap glibc.
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` memicu postinstall → prisma generate, karena itu prisma/ disalin dulu.
RUN npm ci

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* sengaja TIDAK dikirim sebagai build arg. Semua pemakainya ada di
# kode server dan punya fallback ke APP_URL yang dibaca saat runtime, jadi ganti
# domain cukup mengubah .env di VPS tanpa membangun ulang image.
RUN npm run build

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# public/ tidak ikut ke standalone — harus disalin sendiri.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma CLI dan migrasinya TIDAK ikut tertelusur ke standalone, padahal
# `migrate deploy` saat rilis membutuhkannya. Disalin eksplisit.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Dibuat lebih dulu supaya kepemilikannya benar ketika volume host di-mount
# ke sini oleh compose.
RUN mkdir -p /app/logs /app/public/uploads \
  && chown -R nextjs:nodejs /app/logs /app/public/uploads

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
