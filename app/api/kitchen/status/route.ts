// POST /api/kitchen/status  { order_id, status }
// KITCHEN ONLY. Requires a valid Supabase Auth access token.
// Moves an order through: new -> accepted -> preparing -> ready ->
// completed (plus cancelled).

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { reversePointsForCancelledOrder } from "@/lib/points";
import { smsPickupReady } from "@/lib/sms";

export const dynamic = "force-dynamic";

const ALLOWED = ["new", "accepted", "preparing", "ready", "completed", "cancelled"];

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Kitchen login required." }, { status: 401 });
  }
  let orderId = 0;
  let status = "";
  try {
    const body = (await req.json()) as { order_id?: number; status?: string };
    orderId = Math.floor(Number(body.order_id));
    status = String(body.status ?? "");
  } catch {
    /* handled below */
  }
  if (!orderId || !ALLOWED.includes(status)) {
    return NextResponse.json({ error: "Bad order_id or status." }, { status: 400 });
  }
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("orders")
    .update({ kitchen_status: status })
    .eq("id", orderId);
  if (error) {
    console.error("[kitchen/status] update failed:", error);
    return NextResponse.json({ error: "Could not update the order." }, { status: 500 });
  }
  // SMS: a pickup order marked ready texts the customer (best-effort;
  // no-op until Twilio is configured).
  if (status === "ready") {
    try {
      const { data: order } = await supabase
        .from("orders")
        .select("id, customer_phone, fulfillment")
        .eq("id", orderId)
        .maybeSingle();
      if (order && order.fulfillment === "pickup") {
        await smsPickupReady(order);
      }
    } catch (err) {
      console.error("[kitchen/status] ready SMS failed:", err);
    }
  }
  // Loyalty: a cancelled order refunds its redeemed points and reverses
  // its earned points (best-effort, idempotent).
  if (status === "cancelled") {
    try {
      await reversePointsForCancelledOrder(orderId);
    } catch (err) {
      console.error("[kitchen/status] points reversal failed:", err);
    }
  }
  return NextResponse.json({ ok: true });
}
