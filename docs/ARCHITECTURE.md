# HAAPILY — Architecture & Build Plan

Status: Chunk 1 (database & models) drafted. `prisma/schema.prisma` passes Prisma 7's schema validator (41 models, 18 enums). It has **not** been migrated against a live database, and `seed.ts` has not been executed.

---

## 1. Decisions (and where this departs from the brief)

| Area | Choice | Why |
|---|---|---|
| Repo shape | **Single Next.js app**, admin under `/admin` route group. Not a monorepo. | One deploy, one CI pipeline, one env file. Built and maintained from a phone. The `lib/` boundaries below mirror the planned `packages/*`, so splitting later is mechanical. |
| Framework | Next.js 15 (App Router), TypeScript strict, Tailwind v4, shadcn/ui, Framer Motion | As briefed |
| Backend | Route handlers + Server Actions. No NestJS. | No second service to host until there's a second client (mobile app). |
| ORM / DB | Prisma 7 + Postgres (Supabase or Neon) | As briefed. Uses `prisma.config.ts` with a driver adapter. |
| Cache / queue | No Redis at launch. Upstash for rate limiting only. | Postgres and Next's cache handle this scale. |
| Auth | Auth.js v5 with Google + email magic link. Guest checkout by phone. | Staff roles live on `User.role`. |
| Payments | Razorpay Standard Checkout (hosted). Stripe behind a flag. | Card data never touches our servers, which keeps PCI scope minimal (SAQ-A). |
| Media | Cloudinary | On-the-fly resizing and AVIF/WebP. |
| Email | Resend + React Email | Order confirmation, shipped, magic link. |
| Hosting | Vercel **Pro**, or Hostinger VPS + Docker | Vercel Hobby does not allow commercial use. |

## 2. Payment architecture

```
checkout → getEnabledMethods(cartTotal, pincode)
             ├─ reads PaymentMethodSetting (admin toggles)
             ├─ COD: filtered by maxOrderValue + PincodeRule.codAllowed
             └─ online methods: hidden unless a Razorpay key exists for PAYMENT_MODE
```

- **Mode switching.** `lib/payments/config.ts` reads `PAYMENT_MODE` and picks the TEST or LIVE key pair. At boot the app asserts that the key prefix matches the mode, so live mode with `rzp_test_` keys fails loudly. Test mode shows a "Test Mode" badge at checkout. Every `Order` and `Payment` row stores the mode that was active.
- **Method toggles.** Enabled online methods are passed into Razorpay Checkout's `config.display` blocks, so a disabled method never appears.
- **COD orders** are created as `paymentStatus=PENDING_PAYMENT` with a `Payment{provider: COD}` row. The row flips to `PAID` when the admin marks it collected or courier remittance is recorded.
- **WhatsApp/UPI path.** The order is created first, then a `wa.me` link opens with the order number, items, total, and address pre-filled. Admin confirms payment manually.
- **Webhooks.** `payment.captured` and `payment.failed` are verified with HMAC and de-duplicated through `WebhookEvent(provider, eventId)`. The client-side signature is verified too, but the webhook is the source of truth.
- **GST.** With `GST_ENABLED=false`: no tax lines, invoices without GSTIN, HSN not shown. With `true`: tax is computed per line from `TaxRule` (threshold on price per piece), CGST/SGST vs IGST by `BUSINESS_STATE_CODE` vs the shipping state, and GSTIN on invoices. No code change is needed to switch.

> ⚠️ Open compliance item: inter-state sale of goods generally requires GST registration regardless of turnover (CGST Act s.24). Confirm with a CA before shipping outside your home state. Exports also need LUT/IEC.

## 3. Returns model

Policy is resolved in this order: `Product.returnPolicy` → primary TYPE `Category.returnPolicy` → `StoreSetting.defaultReturnPolicy`. The result is snapshotted onto `OrderItem`, so later policy changes never rewrite old orders.

Launch settings: all muslin categories and Gift Sets are `REPLACEMENT_ONLY`. Other dress categories can be switched to `EXCHANGE_ALLOWED` in admin when you're ready.

Draft policy copy:

> Because our muslin pieces are worn right against your baby's skin, we don't accept returns or exchanges, for hygiene reasons. We check every piece before it ships. If your order arrives damaged, defective, or isn't what you ordered, message us within 48 hours of delivery with an unboxing video and we'll send a replacement at no cost.

A replacement clause is kept rather than a flat "no refund, no exchange". Under Indian consumer law, a seller remains liable for defective goods whatever the posted policy says. The E-Commerce Rules 2020 also require the policy to be clearly displayed. Have this reviewed; this doc is not legal advice.

## 4. API surface

Public reads are served by React Server Components directly from `lib/`. Route handlers exist only where a client, webhook, or third party needs HTTP.

**Storefront (public)**
```
GET    /api/products?category&age&size&color&print&pack&fabric&min&max&occasion&sort&page
GET    /api/products/[slug]
GET    /api/search?q=
GET    /api/pincode/[code]                 serviceable, COD allowed, ETA
POST   /api/cart                           create/get guest cart (cookie)
PATCH  /api/cart/items                     add/update/remove {variantId, qty}
POST   /api/cart/coupon                    apply/remove
POST   /api/checkout/quote                 totals, shipping, tax, enabled methods
POST   /api/checkout/order                 place order (COD / WhatsApp / Razorpay init)
POST   /api/payments/razorpay/verify       client-side signature check
POST   /api/webhooks/razorpay              captured / failed / refunded
POST   /api/webhooks/stripe                (flagged)
GET    /api/orders/track?number&phone      guest order tracking
POST   /api/returns                        replacement request + evidence upload
POST   /api/reviews                        (moderated)
POST   /api/newsletter
GET|POST|DELETE /api/wishlist              (signed-in)
GET    /api/account/orders                 (signed-in)
```

**Admin** (`/api/admin/*`, role-gated, every mutation writes `AuditLog`)
```
products        GET list · POST · GET/PATCH/DELETE [id] · POST bulk-edit
variants        POST · PATCH/DELETE [id] · POST [id]/stock-adjust
images          POST sign-upload · PATCH reorder · DELETE [id]
categories      CRUD
orders          GET list/export · GET [id] · POST [id]/status · POST [id]/mark-paid
                POST [id]/shipment · POST [id]/invoice · POST manual (DM orders)
returns         GET · PATCH [id]
customers       GET list/export · GET [id]
coupons         CRUD
payment-methods GET · PATCH [method]            ← the toggles
shipping        zones CRUD · rates CRUD · pincodes bulk upload
tax-rules       CRUD
cms             pages CRUD · banners CRUD · testimonials CRUD
reviews         GET · PATCH [id] (approve/reject)
imports         POST upload · POST [id]/mapping · POST [id]/validate · POST [id]/commit
                POST [id]/rollback · GET list · GET [id]/report · GET sample.csv
reports         GET sales · top-products · low-stock · export.csv
users           GET · PATCH [id]/role              (ADMIN only)
audit-logs      GET                                (ADMIN only)
settings        GET · PATCH
```

**Role matrix**

| Role | Access |
|---|---|
| STAFF | Orders, shipments, stock adjust, reviews |
| MANAGER | STAFF + products, imports, coupons, CMS, reports |
| ADMIN | Everything, including payment toggles, users, settings, audit log |

## 5. Product import framework

1. **Upload.** CSV, XLSX, or JSON, up to 5k rows. The file is stored and an `ImportBatch` is created with status `UPLOADED`.
2. **Map.** Columns are auto-matched by header name and alias. The mapping is saved to `columnMapping`, so the next import from the same template pre-fills.
3. **Preview.** The first 20 rows are shown as they will be stored.
4. **Validate.** A Zod schema checks every row, plus cross-row and database checks:
   - duplicate SKU (within the file and against the database)
   - missing required fields
   - price or stock below 0
   - compare-at price lower than price
   - unknown age group, with aliases (e.g. `1T → 12-18M`)
   - invalid category
   - image URLs checked by HEAD request with a 5s timeout, 10 at a time
   
   Errors are recorded as `{row, field, code, message}` and are downloadable as CSV.
5. **Import.** Rows are grouped by product (same slug/title means one product with many variant rows) and written in transactions of 100. Each touched entity writes an `ImportChange` with a `before` snapshot.
6. **Report.** Created, updated, skipped, and error counts.
7. **Rollback.** Only the latest non-rolled-back batch can be rolled back. It is refused if a later edit touched the same entities (checked against `AuditLog`). Creates are deleted and updates are restored from `before`.
8. **History.** All batches, with who ran them, when, and their counts.

Also included: images uploaded as a ZIP (matched to rows by `SKU-1.jpg`, `SKU-2.jpg`) and pushed to Cloudinary, plus a downloadable sample CSV.

## 6. Folder structure

```
haapily/
├─ prisma/            schema.prisma · migrations/ · seed.ts
├─ prisma.config.ts
├─ public/            logo, og image, favicons (generated from logo)
├─ src/
│  ├─ app/
│  │  ├─ (store)/     page.tsx · shop/ · [category]/ · products/[slug]/ · cart/ · checkout/
│  │  │               account/ · track/ · why-muslin/ · pages/[slug]/
│  │  ├─ (admin)/admin/  dashboard · products · orders · imports · customers · coupons
│  │  │               shipping · payments · cms · reviews · reports · users · audit · settings
│  │  ├─ api/         (see §4)
│  │  ├─ sitemap.ts · robots.ts · opengraph-image.tsx · layout.tsx
│  ├─ components/     ui/ (shadcn) · store/ · admin/ · emails/
│  ├─ lib/            db.ts · auth.ts · rbac.ts · audit.ts · money.ts · seo.ts
│  │  ├─ payments/    config.ts · razorpay.ts · stripe.ts · cod.ts · whatsapp.ts · methods.ts
│  │  ├─ pricing/     cart-totals.ts · shipping.ts · tax.ts · coupons.ts
│  │  ├─ catalog/     queries.ts · filters.ts · return-policy.ts
│  │  ├─ import/      parse.ts · map.ts · validate.ts · commit.ts · rollback.ts · zip-images.ts
│  │  └─ invoices/    pdf.tsx · numbering.ts
│  ├─ generated/prisma/  (gitignored)
│  └─ middleware.ts   admin guard, rate limit, security headers
├─ tests/             unit (vitest) · e2e (playwright)
├─ .github/workflows/ ci.yml (typecheck · lint · test · prisma validate)
├─ Dockerfile · .env.example · README.md
```

## 7. Build plan

Each chunk ends with a check you can run before anything is pushed.

| # | Chunk | Done when |
|---|---|---|
| 1 | DB & models ✅ drafted | `prisma migrate dev` succeeds on your database; seed creates 7 payment methods (COD + WhatsApp on), 8 age groups, 11 categories |
| 2 | Auth, RBAC, audit | A STAFF user gets 403 on `/admin/payments`; every admin mutation creates an AuditLog row |
| 3 | Admin panel | Create a product with 3 variants and images from a phone; dashboard shows low stock |
| 4 | Import framework | Sample CSV imports; a bad CSV shows row-level errors; rollback restores the exact prior state (test) |
| 5 | Storefront | Lighthouse mobile ≥ 90 perf / 100 a11y; Why Muslin section uses the exact copy; JSON-LD Product validates |
| 6 | Cart & checkout | Guest COD order end to end; COD hidden above cap and for denylisted pincodes; WhatsApp link pre-filled |
| 7 | Payments & shipping | Test-mode Razorpay UPI/card succeed via webhook; replaying the same webhook is a no-op; boot fails on mode/key mismatch |
| 8 | Deploy & docs | CI green; backups on; Sentry receiving; README covers go-live checklist |

## 8. What this does not do (yet)

- No courier API integration (Shiprocket/Delhivery). AWB numbers are entered manually until you pick a carrier.
- No automatic COD remittance reconciliation. Payment is marked collected by hand.
- No multi-language content. Strings are i18n-ready, English only.
- USD shown via manual fx rate or per-variant USD price. No live FX feed.
- No blog at launch. `Page` covers About, FAQ, and policies.

## 9. Still needed from you

- Logo as transparent PNG or SVG (the bee/dragonfly mark + "SHOP FOR KIDS")
- Brand hex colors (or approval to pick from the logo and posts)
- Product list or CSV
- WhatsApp business number
- COD cap and any excluded pincodes
- Hosting choice: Vercel Pro or Hostinger VPS
- Spelling: "Jhabla" or "Jabla"
