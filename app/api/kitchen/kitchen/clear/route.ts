// POST /api/kitchen/clear  { order_ids: number[] }
// KITCHEN ONLY. Requires a valid Supabase Auth access token
// (Authorization: Bearer ...) for a staff profile — the exact same
// gate as /api/kitchen/orders, /api/kitchen/status and
// /api/kitchen/reprint. Without it the route refuses (401).
//
// GloriaFood-style "Clear orders" (owner's request, 2026-11-26): the
// kitchen screen's options menu (⋮) sends the ids of every order the
// feed just returned; those orders are stamped kitchen_status =
// 'cleared' and /api/kitchen/orders stops returning them, so the
// screen empties on every staff device and stays empty after a
// reload. The order ROWS are untouched in every other respect — they
// stay in Admin and reports; nothing is ever deleted. Orders placed
// AFTER the clear carry later ids / timestamps and arrive normally.
//
// The same route also serves PER-ORDER clears (owner's refinement,
// later the same day): the list detail's "🧹 Clear order" button and
// the Ready tab's quick-clear button POST a single id here. The
// route never assumed "all" — any subset of ids works — and the
// audit entry below records the exact ids + a scope flag, so a
// single-order clear is identifiable as such in the trail.
//
// Bounds kept on purpose:
// - Only today's orders (the feed's own window) can be cleared.
// - Cancelled orders are NOT restamped: their status is a record the
//   owner relies on (points reversal, admin), and they are already
//   invisible on the kitchen screen.
// - 'cleared' needs supabase/kitchen-clear-schema.sql (it widens the
//   kitchen_status CHECK constraint). Until Sami runs it, the update
//   fails with a check violation and this route answers with a
//   friendly "not switched on yet" message the kitchen screen shows
//   verbatim — nothing crashes, nothing is half-cleared.

import { NextResponse } from "next/server";
import { getServiceClient, supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Kitchen login required." }, { status: 401 });
  }
  let ids: number[] = [];
  try {
    const body = (await req.json()) as { order_ids?: unknown };
    if (Array.isArray(body.order_ids)) {
      ids = [
        ...new Set(
          body.order_ids
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n > 0)
        ),
      ].slice(0, MAX_IDS);
    }
  } catch {
    /* handled below */
  }
  if (ids.length === 0) {
    // Nothing on screen — clearing an empty screen is a no-op success.
    return NextResponse.json({ ok: true, cleared: 0 });
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("orders")
    .update({ kitchen_status: "cleared" })
    .in("id", ids)
    .gte("created_at", startOfDay.toISOString())
    .neq("kitchen_status", "cancelled")
    .neq("kitchen_status", "cleared")
    .select("id");
  if (error) {
    console.error("[kitchen/clear] update failed:", error);
    // Pre-SQL state: the database still rejects 'cleared' with a CHECK
    // violation (Postgres 23514). Translate it into the one message
    // staff can act on; the screen shows it verbatim.
    const msg = `${error.code ?? ""} ${error.message ?? ""}`;
    if (msg.includes("23514") || msg.toLowerCase().includes("check constraint")) {
      return NextResponse.json(
        {
          error:
            "Clear orders is not switched on yet — run the one-time database update (kitchen-clear-schema.sql) in Supabase first. Nothing was cleared.",
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Could not clear the orders — try again." },
      { status: 500 }
    );
  }
  const cleared = data?.length ?? 0;
  if (cleared > 0) {
    // Same audit trail as the other kitchen actions (best-effort).
    await logAudit(user.email ?? user.id, "order.clear_orders", {
      count: cleared,
      scope: cleared === 1 ? "single" : "all",
      order_ids: (data ?? []).map((r) => r.id),
      via: "kitchen",
    });
  }
  return NextResponse.json({ ok: true, cleared });
}
