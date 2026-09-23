// Seed: reference data only (no products). Idempotent — safe to re-run.
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  // Payment methods — COD-first launch. Flip in admin, not code.
  const methods = [
    { method: "COD", displayName: "Cash on Delivery", isEnabled: true, sortOrder: 1, maxOrderValue: 5000 }, // placeholder cap — set yours
    { method: "WHATSAPP_UPI", displayName: "Pay via UPI on WhatsApp", isEnabled: true, sortOrder: 2 },
    { method: "UPI", displayName: "UPI", isEnabled: false, sortOrder: 3 },
    { method: "CARD", displayName: "Credit / Debit Card", isEnabled: false, sortOrder: 4 },
    { method: "NETBANKING", displayName: "Netbanking", isEnabled: false, sortOrder: 5 },
    { method: "WALLET", displayName: "Wallets", isEnabled: false, sortOrder: 6 },
    { method: "EMI", displayName: "EMI", isEnabled: false, sortOrder: 7 },
  ] as const;
  for (const m of methods) {
    await prisma.paymentMethodSetting.upsert({ where: { method: m.method }, update: {}, create: { ...m } });
  }

  const ageGroups = [
    ["0-3M", "0–3 months", 0, 3], ["3-6M", "3–6 months", 3, 6], ["6-12M", "6–12 months", 6, 12],
    ["12-18M", "12–18 months", 12, 18], ["18-24M", "18–24 months", 18, 24],
    ["2-3Y", "2–3 years", 24, 36], ["3-4Y", "3–4 years", 36, 48], ["4-5Y", "4–5 years", 48, 60],
  ] as const;
  for (const [i, [code, label, minMonths, maxMonths]] of ageGroups.entries()) {
    await prisma.ageGroup.upsert({ where: { code }, update: {}, create: { code, label, minMonths, maxMonths, sortOrder: i } });
  }

  // Muslin product types: no returns/refunds; damaged/defective/wrong item → replacement.
  const categories = [
    ...["Jhablas", "Nappies", "Frocks", "Swaddles", "Towels"].map((n) => ({ name: n, kind: "TYPE", returnPolicy: "REPLACEMENT_ONLY" })),
    ...["Newborn", "Toddler", "Boys", "Girls", "Unisex"].map((n) => ({ name: n, kind: "AUDIENCE", returnPolicy: null })),
    { name: "Gift Sets", kind: "COLLECTION", returnPolicy: "REPLACEMENT_ONLY" },
  ] as const;
  for (const [i, c] of categories.entries()) {
    const slug = c.name.toLowerCase().replace(/\s+/g, "-");
    await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { name: c.name, slug, kind: c.kind, returnPolicy: c.returnPolicy ?? undefined, sortOrder: i },
    });
  }

  const settings: Record<string, unknown> = {
    defaultReturnPolicy: "REPLACEMENT_ONLY",
    replacementWindowHours: 48,
    requireUnboxingVideo: true,
    codPincodeMode: "denylist", // "allowlist" | "denylist"
    orderPrefix: "HAP",
    usdFxRate: null, // set before enabling USD display
    instagramHandle: "haapily.in",
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.storeSetting.upsert({ where: { key }, update: {}, create: { key, value: value as any } });
  }

  for (const name of ["order", "invoice"]) {
    await prisma.counter.upsert({ where: { name }, update: {}, create: { name } });
  }
}

main().finally(() => prisma.$disconnect());
