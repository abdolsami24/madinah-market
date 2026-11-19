// POST /api/track-order  { order_id, phone }
// Customer tracking. The order is returned ONLY when the phone's last 10
// digits match the phone used at checkout. The response is a sanitized
// view: no Stripe ids, no other customers' data, ever.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function last10(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.slice(-10);
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  let orderId = 0;
  let phone = "";
  try {
    const body = (await req.json()) as { order_id?: number; phone?: string };
    orderId = Math.floor(Number(body.order_id));
    phone = String(body.phone ?? "");
  } catch {
    /* handled below */
  }
  if (!orderId || last10(phone).length < 10) {
    return NextResponse.json({ found: false }, { status: 400 });
  }
  const supabase = getServiceClient();
  // Stage 3 columns are selected when they exist; until
  // supabase/stage3-schema.sql runs, fall back to the legacy list.
  const baseCols =
    "id, customer_phone, items_json, subtotal_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents, fulfillment, delivery_address, payment_status, kitchen_status, shipday_status, created_at";
  let { data: order } = await supabase
    .from("orders")
    .select(
      `${baseCols}, delivery_provider, delivery_status, delivery_markup_cents`
    )
    .eq("id", orderId)
    .maybeSingle();
  if (!order) {
    ({ data: order } = await supabase
      .from("orders")
      .select(baseCols)
      .eq("id", orderId)
      .maybeSingle());
  }
  const full = (order ?? null) as (typeof order & {
    delivery_provider?: string | null;
    delivery_status?: string | null;
    delivery_markup_cents?: number;
  }) | null;

  if (!full || last10(String(full.customer_phone ?? "")) !== last10(phone)) {
    // Same answer for "no such order" and "wrong phone" — never leak which.
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    order: {
      id: full.id,
      items: full.items_json,
      subtotal_cents: full.subtotal_cents,
      tax_cents: full.tax_cents,
      delivery_fee_cents: full.delivery_fee_cents,
      delivery_markup_cents: full.delivery_markup_cents ?? 0,
      tip_cents: full.tip_cents,
      total_cents: full.total_cents,
      fulfillment: full.fulfillment,
      delivery_address: full.fulfillment === "delivery" ? full.delivery_address : null,
      payment_status: full.payment_status,
      kitchen_status: full.kitchen_status,
      shipday_status: full.shipday_status,
      // Stage 3: DoorDash delivery state for the tracking timeline.
      delivery_provider: full.delivery_provider ?? null,
      delivery_status: full.delivery_status ?? null,
      created_at: full.created_at,
    },
  });
}
