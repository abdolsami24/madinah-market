// POST /api/kitchen/reprint  { order_id }
// KITCHEN ONLY. Requires a valid Supabase Auth access token
// (Authorization: Bearer ...) for a staff profile — the exact same
// gate as /api/kitchen/orders and /api/kitchen/status. Without it the
// route refuses (401): a ticket reprint is never public.
//
// Queues ONE reprint of a paid order's ticket into the existing
// bridge print pipeline (lib/printer.ts queueReprint): the bridge
// picks it up on its next poll and the Madinah Printer app prints it,
// exactly like the first print. This route NEVER touches
// window.print (the kitchen tablet runs Fully Kiosk, which blocks
// the browser print flow) and never prints anything itself.
//
// Refusals the kitchen screen shows verbatim:
// - printer switch OFF (Admin → Operations → Kitchen printer)
// - order missing / unpaid / cancelled — only a paid, live order's
//   ticket can be reprinted.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { queueReprint } from "@/lib/printer";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Kitchen login required." }, { status: 401 });
  }
  let orderId = 0;
  try {
    const body = (await req.json()) as { order_id?: number };
    orderId = Math.floor(Number(body.order_id));
  } catch {
    /* handled below */
  }
  if (!orderId) {
    return NextResponse.json({ error: "Bad order_id." }, { status: 400 });
  }
  const supabase = getServiceClient();
  const { data: order, error: readError } = await supabase
    .from("orders")
    .select("id, payment_status, kitchen_status")
    .eq("id", orderId)
    .maybeSingle();
  if (readError) {
    console.error("[kitchen/reprint] order read failed:", readError);
    return NextResponse.json({ error: "Could not load the order." }, { status: 500 });
  }
  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (order.payment_status !== "paid" && order.payment_status !== "test_paid") {
    return NextResponse.json(
      { error: "Only paid orders can be reprinted." },
      { status: 400 }
    );
  }
  if (order.kitchen_status === "cancelled") {
    return NextResponse.json(
      { error: "This order was cancelled — its ticket is not reprinted." },
      { status: 400 }
    );
  }
  try {
    const { already_queued } = await queueReprint(orderId);
    // Same audit trail as the kitchen status route (best-effort).
    await logAudit(user.email ?? user.id, "order.reprint", {
      order_id: orderId,
      already_queued,
      via: "kitchen-list",
    });
    return NextResponse.json({ ok: true, already_queued });
  } catch (err) {
    // queueReprint's messages are written for the kitchen screen
    // (printer off, queue full) — pass them through verbatim.
    const message =
      err instanceof Error ? err.message : "Could not queue the reprint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
