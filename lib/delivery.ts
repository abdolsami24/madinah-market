// Delivery orchestration (Stage 3) — settings, quote storage, dispatch
// after payment, and status sync for DoorDash Drive. Sits between the
// API routes and lib/doordash.ts (the raw API client).
//
// FAIL-SOFT RULE (same as the rest of this codebase): until Sami runs
// supabase/stage3-schema.sql, the delivery_quotes table and the
// orders.delivery_* columns do not exist. Every read/write here
// degrades to defaults / logged no-ops instead of throwing, so the
// live site keeps working exactly as before.

import { randomUUID } from "crypto";
import { getServiceClient } from "./supabase/server";
import { geocodeAddress, milesBetween, restaurantCoords } from "./geocode";
import {
  createDoorDashQuote,
  dispatchDoorDashDelivery,
  getDoorDashDelivery,
  mockNextStatus,
  doordashMode,
} from "./doordash";
import { computeDeliveryMarkupCents, DOORDASH_MAX_MILES, normalizeShipdayFeeCents, parseDeliveryProvider, type DeliveryProviderName } from "./deliveryPricing";
import { smsDeliveryDelivered } from "./sms";

// ---- Settings (site_settings, same pattern as the hours editor) -------------

export type DeliveryProvider = DeliveryProviderName;

export interface DeliverySettings {
  /** Site delivery radius cap in miles (food quality). Default 8. */
  max_miles: number;
  /** Minimum food subtotal for delivery orders, cents. 0 = off. */
  min_subtotal_cents: number;
  /** Extra flat fee on top of the DoorDash fee, cents. 0 = off. */
  markup_flat_cents: number;
  /** Extra fee as % of the DoorDash fee. 0 = off. */
  markup_percent: number;
  /**
   * Active delivery provider (provider switch): 'doordash' (default —
   * Stage 3 behavior) or 'shipday' (flat fee, no quote; dispatch via
   * lib/shipday.ts). Switching affects NEW paid orders only.
   */
  provider: DeliveryProvider;
  /** Flat delivery fee charged to the customer in Shipday mode, cents. */
  shipday_fee_cents: number;
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  max_miles: 8,
  min_subtotal_cents: 0,
  markup_flat_cents: 0,
  markup_percent: 0,
  provider: "doordash",
  shipday_fee_cents: 699,
};

const DELIVERY_SETTING_KEYS = [
  "delivery_max_miles",
  "delivery_min_subtotal_cents",
  "delivery_markup_flat_cents",
  "delivery_markup_percent",
  "delivery_provider",
  "shipday_delivery_fee_cents",
] as const;

function numValue(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getDeliverySettings(): Promise<DeliverySettings> {
  const settings = { ...DEFAULT_DELIVERY_SETTINGS };
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("site_settings")
      .select("key, value")
      .in("key", [...DELIVERY_SETTING_KEYS]);
    if (error) return settings;
    for (const row of data ?? []) {
      const v = (row as { value: unknown }).value;
      switch (row.key as string) {
        case "delivery_max_miles":
          settings.max_miles = Math.min(numValue(v, 8) || 8, DOORDASH_MAX_MILES);
          break;
        case "delivery_min_subtotal_cents":
          settings.min_subtotal_cents = Math.round(numValue(v, 0));
          break;
        case "delivery_markup_flat_cents":
          settings.markup_flat_cents = Math.round(numValue(v, 0));
          break;
        case "delivery_markup_percent":
          settings.markup_percent = Math.min(numValue(v, 0), 100);
          break;
        case "delivery_provider":
          settings.provider = parseDeliveryProvider(v);
          break;
        case "shipday_delivery_fee_cents":
          settings.shipday_fee_cents = normalizeShipdayFeeCents(v, settings.shipday_fee_cents);
          break;
      }
    }
  } catch {
    /* defaults */
  }
  return settings;
}

export async function setDeliverySettings(input: DeliverySettings): Promise<void> {
  const supabase = getServiceClient();
  const now = new Date().toISOString();
  const rows = [
    { key: "delivery_max_miles", value: input.max_miles, updated_at: now },
    { key: "delivery_min_subtotal_cents", value: input.min_subtotal_cents, updated_at: now },
    { key: "delivery_markup_flat_cents", value: input.markup_flat_cents, updated_at: now },
    { key: "delivery_markup_percent", value: input.markup_percent, updated_at: now },
    { key: "delivery_provider", value: parseDeliveryProvider(input.provider), updated_at: now },
    {
      key: "shipday_delivery_fee_cents",
      value: normalizeShipdayFeeCents(input.shipday_fee_cents),
      updated_at: now,
    },
  ];
  const { error } = await supabase
    .from("site_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) throw error;
}

/** Markup for a quote fee under the current settings. */
export function markupFor(feeCents: number, settings: DeliverySettings): number {
  return computeDeliveryMarkupCents(
    feeCents,
    settings.markup_flat_cents,
    settings.markup_percent
  );
}

// ---- Stored quotes --------------------------------------------------------------

export interface StoredQuote {
  id: string;
  quote_id: string;
  provider_mode: string;
  fee_cents: number;
  miles: number;
  dropoff_address: string;
  dropoff_phone: string | null;
  dropoff_name: string | null;
  expires_at: string;
  created_at: string;
}

export type QuoteOutcome =
  | {
      ok: true;
      quote: StoredQuote;
      markup_cents: number;
      estimated_dropoff_at: string | null;
    }
  | { ok: false; error: "not_found" | "far" | "unavailable"; message: string };

export async function createDeliveryQuote(input: {
  address: string;
  phone?: string;
  name?: string;
  tip_cents?: number;
  subtotal_cents?: number;
}): Promise<QuoteOutcome> {
  const settings = await getDeliverySettings();
  const geo = await geocodeAddress(input.address);
  if (!geo) {
    return {
      ok: false,
      error: "not_found",
      message: "We could not find that address. Please check it and try again.",
    };
  }
  const r = restaurantCoords();
  const miles = milesBetween(r.lat, r.lng, geo.lat, geo.lng);
  const maxMiles = Math.min(settings.max_miles || 8, DOORDASH_MAX_MILES);
  if (miles > maxMiles) {
    return {
      ok: false,
      error: "far",
      message: `Sorry — that address is outside our delivery area (about ${miles.toFixed(
        1
      )} miles away; we deliver within ${maxMiles} miles). Please choose pickup.`,
    };
  }
  // The external_delivery_id is generated HERE, at quote time (quotes
  // exist before orders do), and is bound to the order at checkout.
  // Accept / retry / status calls all reuse it — that is the
  // idempotency key DoorDash dedupes on.
  const externalId = `ddq-${randomUUID()}`;
  let created;
  try {
    created = await createDoorDashQuote({
      external_delivery_id: externalId,
      dropoff_address: input.address,
      dropoff_phone: input.phone ?? "",
      dropoff_name: input.name,
      order_value_cents: input.subtotal_cents ?? 0,
      tip_cents: input.tip_cents ?? 0,
      miles,
    });
  } catch (err) {
    console.error("[delivery] quote creation failed:", err);
    return {
      ok: false,
      error: "unavailable",
      message:
        "We could not get a delivery quote right now. Please try again in a moment, or choose pickup.",
    };
  }
  const expiresAt =
    created.expires_at ?? new Date(Date.now() + 10 * 60000).toISOString();
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("delivery_quotes")
      .insert({
        quote_id: created.external_delivery_id,
        provider_mode: created.provider_mode,
        fee_cents: created.fee_cents,
        miles: Math.round(miles * 100) / 100,
        dropoff_address: input.address,
        dropoff_phone: input.phone ?? null,
        dropoff_name: input.name ?? null,
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("quote insert failed");
    return {
      ok: true,
      quote: data as StoredQuote,
      markup_cents: markupFor(created.fee_cents, settings),
      estimated_dropoff_at: created.estimated_dropoff_at,
    };
  } catch (err) {
    // delivery_quotes missing (stage3-schema.sql not run yet) or DB down:
    // clean customer-facing error, never a crash.
    console.error("[delivery] quote could not be stored:", err);
    return {
      ok: false,
      error: "unavailable",
      message:
        "Delivery is being set up right now. Please try again shortly, or choose pickup.",
    };
  }
}

export async function loadStoredQuote(quoteRowId: string): Promise<StoredQuote | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("delivery_quotes")
      .select("*")
      .eq("id", quoteRowId)
      .maybeSingle();
    if (error || !data) return null;
    return data as StoredQuote;
  } catch {
    return null;
  }
}

export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type QuoteCheck =
  | { ok: true; quote: StoredQuote }
  | { ok: false; reason: "missing" | "expired" | "address_mismatch"; quote: StoredQuote | null };

/** Checkout-time verification: the stored quote is the ONLY fee source. */
export async function verifyQuoteForCheckout(
  quoteRowId: string,
  checkoutAddress: string
): Promise<QuoteCheck> {
  const quote = await loadStoredQuote(quoteRowId);
  if (!quote) return { ok: false, reason: "missing", quote: null };
  if (new Date(quote.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired", quote };
  }
  if (normalizeAddress(quote.dropoff_address) !== normalizeAddress(checkoutAddress)) {
    return { ok: false, reason: "address_mismatch", quote };
  }
  return { ok: true, quote };
}

// ---- Order delivery state ---------------------------------------------------------

export interface DeliveryOrderLike {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  fulfillment: string;
  delivery_address: string | null;
  items_json: { name: string; qty: number }[];
  subtotal_cents: number;
  tip_cents: number;
  delivery_external_id?: string | null;
  delivery_quote_id?: string | null;
  delivery_status?: string | null;
}

interface DeliveryPatch {
  delivery_provider?: string;
  delivery_external_id?: string;
  delivery_status?: string;
  delivery_error?: string | null;
  delivery_status_at?: string;
}

/** Writes delivery_* columns; swallows "column missing" (SQL not run). */
async function updateOrderDelivery(orderId: number, patch: DeliveryPatch): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
    if (error) {
      if (/delivery_/i.test(error.message)) {
        console.warn(
          "[delivery] orders.delivery_* columns missing — run supabase/stage3-schema.sql"
        );
      } else {
        console.error("[delivery] order update failed:", error.message);
      }
    }
  } catch (err) {
    console.error("[delivery] order update failed:", err);
  }
}

/**
 * Dispatch after payment (called from markOrderPaid and the admin
 * Retry action). Idempotent: an order that already has a
 * delivery_external_id is never dispatched twice. On failure the
 * order stays PAID with delivery_status 'pending' + delivery_error,
 * ready for the admin Retry button.
 */
export async function dispatchDeliveryForOrder(
  order: DeliveryOrderLike
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (order.fulfillment !== "delivery") return { ok: false, error: "not a delivery order" };
  if (order.delivery_external_id) return { ok: true, already: true };
  const quote = order.delivery_quote_id
    ? await loadStoredQuote(order.delivery_quote_id)
    : null;
  const externalId = quote?.quote_id ?? `order-${order.id}`;
  try {
    const result = await dispatchDoorDashDelivery({
      external_delivery_id: externalId,
      dropoff_address: order.delivery_address ?? quote?.dropoff_address ?? "",
      dropoff_phone: order.customer_phone ?? quote?.dropoff_phone ?? "",
      dropoff_name: order.customer_name ?? undefined,
      order_value_cents: order.subtotal_cents,
      tip_cents: order.tip_cents,
      miles: quote?.miles ?? 0,
      items: (order.items_json ?? []).map((i) => ({ name: i.name, qty: i.qty })),
    });
    await updateOrderDelivery(order.id, {
      delivery_provider: "doordash",
      delivery_external_id: result.external_delivery_id,
      delivery_status: result.delivery_status,
      delivery_error: null,
      delivery_status_at: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delivery dispatch failed";
    await updateOrderDelivery(order.id, {
      delivery_provider: "doordash",
      delivery_status: "pending",
      delivery_error: message.slice(0, 500),
      delivery_status_at: new Date().toISOString(),
    });
    console.error(`[delivery] dispatch for order #${order.id} failed:`, message);
    return { ok: false, error: message };
  }
}

/**
 * Applies a raw DoorDash status to an order (webhook + refresh share
 * this). Sends the "delivered" SMS exactly once, on the transition.
 */
export async function applyDeliveryStatus(
  order: { id: number; customer_phone: string | null; fulfillment: string; delivery_status?: string | null },
  rawStatus: string
): Promise<void> {
  const status = rawStatus.toLowerCase().trim();
  if (!status) return;
  const previous = (order.delivery_status ?? "").toLowerCase();
  if (previous === status) return;
  await updateOrderDelivery(order.id, {
    delivery_status: status,
    delivery_status_at: new Date().toISOString(),
  });
  if (status === "delivered" && previous !== "delivered") {
    try {
      await smsDeliveryDelivered(order);
    } catch (err) {
      console.error("[delivery] delivered SMS failed:", err);
    }
  }
}

/** Finds the order for a DoorDash external id and applies a status. */
export async function applyDeliveryStatusByExternalId(
  externalId: string,
  rawStatus: string
): Promise<boolean> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer_phone, fulfillment, delivery_status")
      .eq("delivery_external_id", externalId)
      .maybeSingle();
    if (error || !data) return false;
    await applyDeliveryStatus(data as DeliveryOrderLike, rawStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shipday webhook counterpart of applyDeliveryStatusByExternalId:
 * finds the order by its Shipday id (falling back to Shipday's
 * order_number, which is OUR order id), records the raw Shipday text
 * on shipday_status, and applies the canonical status through the
 * shared path (so the delivered SMS fires exactly once, as with
 * DoorDash). An order explicitly recorded as a DoorDash order is
 * never touched. Returns false when nothing matched.
 */
export async function applyShipdayStatus(input: {
  shipdayId: string;
  orderNumber: string;
  rawStatus: string;
  canonical: string;
}): Promise<boolean> {
  try {
    const supabase = getServiceClient();
    let order: Record<string, unknown> | null = null;
    if (input.shipdayId) {
      const { data } = await supabase
        .from("orders")
        .select("id, customer_phone, fulfillment, delivery_status, delivery_provider")
        .eq("shipday_order_id", input.shipdayId)
        .maybeSingle();
      order = (data as Record<string, unknown>) ?? null;
    }
    if (!order && input.orderNumber && /^\d+$/.test(input.orderNumber)) {
      const { data } = await supabase
        .from("orders")
        .select("id, customer_phone, fulfillment, delivery_status, delivery_provider")
        .eq("id", Number(input.orderNumber))
        .maybeSingle();
      const candidate = (data as Record<string, unknown>) ?? null;
      if (
        candidate &&
        candidate.fulfillment === "delivery" &&
        candidate.delivery_provider !== "doordash"
      ) {
        order = candidate;
      }
    }
    if (!order) return false;
    if (input.rawStatus) {
      try {
        await supabase
          .from("orders")
          .update({ shipday_status: `Shipday: ${input.rawStatus}`.slice(0, 200) })
          .eq("id", order.id as number);
      } catch {
        /* the canonical status below is what matters */
      }
    }
    await applyDeliveryStatus(
      order as { id: number; customer_phone: string | null; fulfillment: string; delivery_status?: string | null },
      input.canonical
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Staff "Refresh status": live mode asks DoorDash for the current
 * status; mock mode advances the simulated lifecycle one step.
 * Returns the latest raw status (or null when nothing changed).
 */
export async function refreshDeliveryStatus(
  order: DeliveryOrderLike
): Promise<{ ok: boolean; status: string | null; error?: string }> {
  if (!order.delivery_external_id) {
    return { ok: false, status: null, error: "No delivery has been created for this order yet." };
  }
  if (doordashMode() === "live") {
    try {
      const current = await getDoorDashDelivery(order.delivery_external_id);
      if (!current) return { ok: false, status: null, error: "DoorDash returned no status." };
      await applyDeliveryStatus(order, current.delivery_status);
      return { ok: true, status: current.delivery_status };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : "Status refresh failed",
      };
    }
  }
  const next = mockNextStatus(order.delivery_status ?? "created");
  if (!next) return { ok: true, status: order.delivery_status ?? null };
  await applyDeliveryStatus(order, next);
  return { ok: true, status: next };
}
