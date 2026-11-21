// Pure delivery-pricing math for DoorDash Drive — NO imports, so the
// numbers can be unit-checked with plain node + tsc (see the Stage 3
// verification notes). All money is integer cents.
//
// MOCK rate card = DoorDash's PUBLISHED Drive API rates, verified
// 2026-11-18 on developer.doordash.com (Drive "Pricing & payment"):
//   $9.75 base for deliveries within 5 miles
//   + $0.75 per additional mile, up to a 15-mile maximum
//   − $2.75 off the base rate when the customer can tip and 100% of the
//     tip is passed through to the Dasher.
// Mock mode exists ONLY until Sami's real DoorDash credentials are in
// Vercel; mock quotes are always stored/flagged provider_mode='mock'.

export const DOORDASH_MAX_MILES = 15;
export const DOORDASH_BASE_MILES = 5;
export const DOORDASH_BASE_FEE_CENTS = 975;
export const DOORDASH_PER_MILE_CENTS = 75;
export const DOORDASH_TIP_DISCOUNT_CENTS = 275;
/** A delivery fee never drops below $1.00, even after the tip discount. */
export const MOCK_MIN_FEE_CENTS = 100;

/**
 * Mock DoorDash fee for a straight-line distance. Returns null when the
 * distance is beyond DoorDash's 15-mile maximum (no quote possible).
 * Fractional miles beyond 5 are prorated, then rounded to the cent.
 */
export function mockDeliveryFeeCents(miles: number, tipCents: number): number | null {
  if (!Number.isFinite(miles) || miles < 0 || miles > DOORDASH_MAX_MILES) return null;
  const extraMiles = Math.max(0, miles - DOORDASH_BASE_MILES);
  let fee = DOORDASH_BASE_FEE_CENTS + Math.round(extraMiles * DOORDASH_PER_MILE_CENTS);
  if (tipCents > 0) fee -= DOORDASH_TIP_DISCOUNT_CENTS;
  return Math.max(fee, MOCK_MIN_FEE_CENTS);
}

/**
 * The restaurant's own extra charge on top of the DoorDash fee
 * (admin settings delivery_markup_flat_cents + delivery_markup_percent).
 * Since the Service Fee update (2026-11-18, spec Part C) the customer
 * sees ONE merged "Delivery fee" line (quote fee + this markup, via
 * customerDeliveryCents in lib/feePricing.ts); the split stays stored
 * on the order and visible in the admin panel only.
 */
export function computeDeliveryMarkupCents(
  quoteFeeCents: number,
  flatCents: number,
  percent: number
): number {
  const flat = Number.isFinite(flatCents) ? Math.max(0, Math.round(flatCents)) : 0;
  const pct = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  return flat + Math.round((Math.max(0, quoteFeeCents) * pct) / 100);
}

// ---- Delivery provider switch (DoorDash Drive vs Shipday) -------------------
// Admin → Operations picks ONE active provider (site_settings key
// delivery_provider, default 'doordash'). DoorDash mode is the Stage 3
// behavior: a stored quote is required at checkout and the customer
// pays the quoted fee + markup. Shipday mode has NO quote: the
// customer pays one flat fee (shipday_delivery_fee_cents, default
// $6.99) and Shipday bills the restaurant per delivery on its own
// account. These helpers are pure so the branch decisions can be
// unit-checked exactly like the fee math above.

export type DeliveryProviderName = "doordash" | "shipday";

/** Default flat delivery fee charged to the customer in Shipday mode. */
export const DEFAULT_SHIPDAY_FEE_CENTS = 699;

/** Anything that is not exactly 'shipday' means DoorDash (the default). */
export function parseDeliveryProvider(value: unknown): DeliveryProviderName {
  return value === "shipday" ? "shipday" : "doordash";
}

/** Clamps a stored/admin-entered Shipday flat fee to a sane cent amount. */
export function normalizeShipdayFeeCents(value: unknown, fallback = DEFAULT_SHIPDAY_FEE_CENTS): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n), 100000);
}

/** Only DoorDash mode needs a stored quote before checkout. */
export function needsDeliveryQuote(provider: DeliveryProviderName): boolean {
  return provider === "doordash";
}
