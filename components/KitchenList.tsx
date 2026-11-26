"use client";

// Kitchen LIST view — the default face of /kitchen (owner's design,
// 2026-11-26, GloriaFood-style orders list): one big tappable row per
// order under All · In progress · Ready tabs, tap a row for the full
// order detail, with the board's one-tap Ready and a bridge Reprint.
//
// It deliberately mirrors KitchenBoard's plumbing — the same Supabase
// Auth login gate, the same GET /api/kitchen/orders feed (5 s poll +
// realtime bonus), the same single ding + fresh highlight for newly
// seen paid orders, the same POST /api/kitchen/status completion —
// so the two faces can never disagree about an order. Differences
// from the board, by design:
// - NO tablet-side auto-print toggle here: the list's printing is
//   the bridge (paid orders auto-print through it; Reprint queues
//   into the same pipeline via POST /api/kitchen/reprint). Nothing
//   in this file calls window.print — the kitchen tablet runs Fully
//   Kiosk, which blocks the browser print flow.
// - The List | Board toggle in the header flips to the card board
//   (rendered by KitchenHome); the choice persists in localStorage.
// - Clearing comes in both sizes (owner, 2026-11-26): the header ⋮
//   menu clears ALL on-screen orders at once, and each order can
//   also be cleared on its own — a confirmed "🧹 Clear order" button
//   in the detail view, plus a two-tap quick-clear on Ready rows.
//   Both POST to the same /api/kitchen/clear route (all = every id,
//   single = one id); cleared orders stay in Admin and reports.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { formatCents } from "@/lib/menu";
import { formatDenverTime } from "@/lib/hours";
import QrCode from "@/components/QrCode";
import KitchenOptionsMenu from "@/components/KitchenOptionsMenu";
import type { Session } from "@supabase/supabase-js";

interface KitchenOrder {
  id: number;
  customer_name: string | null;
  customer_phone: string | null;
  items_json: {
    name: string;
    qty: number;
    line_total_cents: number;
    options?: { group: string; name: string; price_delta_cents: number }[];
    instructions?: string;
  }[];
  subtotal_cents: number;
  discount_cents: number;
  service_fee_cents?: number;
  tax_cents: number;
  delivery_fee_cents: number;
  delivery_markup_cents?: number;
  free_delivery?: boolean;
  tip_cents: number;
  total_cents: number;
  fulfillment: string;
  delivery_address: string | null;
  car_description?: string | null;
  customer_here_at?: string | null;
  note?: string | null;
  scheduled_for: string | null;
  payment_status: string;
  kitchen_status: string;
  shipday_order_id: string | null;
  shipday_status: string | null;
  delivery_provider?: string | null;
  driver_token?: string | null;
  delivery_status?: string | null;
  created_at: string;
}

type Tab = "all" | "progress" | "ready";

function isPaid(o: KitchenOrder): boolean {
  return o.payment_status === "paid" || o.payment_status === "test_paid";
}

function isInProgress(o: KitchenOrder): boolean {
  return isPaid(o) && o.kitchen_status !== "completed" && o.kitchen_status !== "cancelled";
}

function fulfillmentLabel(o: KitchenOrder): string {
  if (o.fulfillment === "delivery") {
    return o.delivery_provider === "house" ? "🏠 HOUSE DELIVERY" : "🛵 DELIVERY";
  }
  if (o.fulfillment === "curbside") return "🚗 CURBSIDE";
  return "🏃 PICKUP";
}

/** Elapsed waiting time as M:SS (or H:MM:SS past an hour). */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// One single "ding" — played exactly once when a new order arrives
// (identical to the board's).
function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    osc.start(start);
    gain.gain.setValueAtTime(0.3, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
    osc.stop(start + 0.95);
  } catch {
    /* audio is best-effort */
  }
}

export default function KitchenList({
  testMode,
  view = "list",
  onSwitchView,
}: {
  testMode: boolean;
  view?: "list" | "board";
  onSwitchView?: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [alertsOn, setAlertsOn] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Reprint feedback for the detail view: a short note under the
  // button plus a brief disable window (one tap = one job).
  const [reprintNote, setReprintNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [reprintBusyUntil, setReprintBusyUntil] = useState(0);
  // Per-order clear state: the detail view's confirm dialog, and the
  // Ready rows' two-tap guard (armed id auto-disarms after ~3 s).
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [armedClearId, setArmedClearId] = useState<number | null>(null);
  const [rowClearBusyId, setRowClearBusyId] = useState<number | null>(null);
  const [listMsg, setListMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenPaidRef = useRef<Set<number>>(new Set());
  const freshRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef(true);

  // ---- auth (same gate as the board) ---------------------------------------
  useEffect(() => {
    const supabase = getBrowserClient();
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setAlertsOn(localStorage.getItem("madinah_alerts_on") === "1");
  }, []);

  // Live waiting timers tick every second.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Never leave the quick-clear arm timer dangling after unmount.
  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    const supabase = getBrowserClient();
    if (!supabase) return setLoginError("Supabase is not configured on this site yet.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setLoginError("Login failed — check the email and password.");
  }

  // ---- order feed (same feed + arrival behavior as the board) ---------------
  const fetchOrders = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch("/api/kitchen/orders", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { orders: KitchenOrder[] };
      const list = data.orders ?? [];
      const fresh = list.filter((o) => isPaid(o) && !seenPaidRef.current.has(o.id));
      for (const o of list) {
        if (isPaid(o)) seenPaidRef.current.add(o.id);
      }
      if (!firstLoadRef.current && fresh.length > 0) {
        for (const o of fresh) {
          if (o.kitchen_status !== "completed" && o.kitchen_status !== "cancelled") {
            freshRef.current.add(o.id);
          }
        }
        if (
          alertsOn &&
          fresh.some(
            (o) => o.kitchen_status !== "completed" && o.kitchen_status !== "cancelled"
          )
        ) {
          chime();
        }
      }
      firstLoadRef.current = false;
      setOrders(list);
    } catch {
      /* next poll retries */
    }
  }, [session, alertsOn]);

  useEffect(() => {
    if (!session) return;
    fetchOrders();
    const poll = setInterval(fetchOrders, 5000);
    const supabase = getBrowserClient();
    let channel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
    if (supabase) {
      channel = supabase
        .channel("kitchen-orders-list")
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
          fetchOrders();
        })
        .subscribe();
    }
    return () => {
      clearInterval(poll);
      if (supabase && channel) supabase.removeChannel(channel);
    };
  }, [session, fetchOrders]);

  // ---- actions ---------------------------------------------------------------
  async function setStatus(order: KitchenOrder, status: string) {
    if (!session) return;
    await fetch("/api/kitchen/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ order_id: order.id, status }),
    }).catch(() => undefined);
    fetchOrders();
  }

  // The board's one tap, in a button: optimistic completion, then the
  // same status POST (server fires the ready SMS / TV side effects).
  async function completeOrder(order: KitchenOrder) {
    freshRef.current.delete(order.id);
    setOrders((prev) =>
      prev.map((o) => (o.id === order.id ? { ...o, kitchen_status: "completed" } : o))
    );
    await setStatus(order, "completed");
  }

  async function reprint(order: KitchenOrder) {
    if (!session) return;
    setReprintNote(null);
    setReprintBusyUntil(Date.now() + 4000);
    try {
      const res = await fetch("/api/kitchen/reprint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ order_id: order.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        already_queued?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setReprintNote({
          ok: false,
          text: data.error ?? "Could not queue the reprint — try again.",
        });
        return;
      }
      setReprintNote({
        ok: true,
        text: data.already_queued
          ? "Already on its way to the printer ✓"
          : "Sent to printer ✓",
      });
    } catch {
      setReprintNote({ ok: false, text: "Could not reach the server — try again." });
    }
  }

  // ---- per-order clear -------------------------------------------------------
  // One POST shape for both single-clear buttons: one id to the same
  // /api/kitchen/clear route the ⋮ menu's clear-all uses with every
  // id. Returns an error string (shown verbatim — including the
  // friendly pre-SQL "not switched on yet" message, so a single
  // clear fails soft in exactly the same way) or null on success.
  async function clearOne(order: KitchenOrder): Promise<string | null> {
    if (!session) return "Kitchen login required.";
    try {
      const res = await fetch("/api/kitchen/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ order_ids: [order.id] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        return data.error ?? "Could not clear the order — try again.";
      }
      return null;
    } catch {
      return "Could not reach the server — try again.";
    }
  }

  // Detail view: the confirm dialog's action. On success the detail
  // closes and the list comes back on the same tab, order gone.
  async function clearFromDetail(order: KitchenOrder) {
    setClearBusy(true);
    setClearError(null);
    const err = await clearOne(order);
    setClearBusy(false);
    if (err) {
      setClearError(err);
      return;
    }
    setClearConfirmOpen(false);
    setDetailId(null);
    setOrders((prev) => prev.filter((o) => o.id !== order.id));
    fetchOrders();
  }

  // Ready-row quick clear: first tap arms the button ("Sure?") for
  // ~3 seconds, second tap clears — no modal, no accidental clears.
  // Only Ready rows render this button; live orders are cleared from
  // the detail view, deliberately.
  function armOrClearRow(order: KitchenOrder) {
    if (rowClearBusyId !== null) return;
    if (armedClearId !== order.id) {
      setArmedClearId(order.id);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setArmedClearId(null), 3000);
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedClearId(null);
    setRowClearBusyId(order.id);
    setListMsg(null);
    void (async () => {
      const err = await clearOne(order);
      setRowClearBusyId(null);
      if (err) {
        setListMsg({ ok: false, text: err });
        return;
      }
      setListMsg({ ok: true, text: `Order #${order.id} cleared ✓` });
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      fetchOrders();
    })();
  }

  function turnOnAlerts() {
    setAlertsOn(true);
    localStorage.setItem("madinah_alerts_on", "1");
    chime();
  }

  // ---- render ------------------------------------------------------------------
  if (!authReady) {
    return (
      <div className="kitchen-body">
        <div className="kitchen-wrap">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="kitchen-body">
        <form className="k-login" onSubmit={login}>
          <h1 style={{ color: "var(--gold-soft)", marginTop: 0 }}>🍳 Kitchen Login</h1>
          <p>Madinah Market staff only.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {loginError && <p style={{ color: "#fca5a5" }}>{loginError}</p>}
          <button type="submit">Log in</button>
        </form>
      </div>
    );
  }

  const header = (
    <div className="kitchen-head">
      <h1>
        🍳 Kitchen — Madinah Market{" "}
        {testMode && <span style={{ color: "#fca5a5" }}>(TEST MODE)</span>}
      </h1>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        {onSwitchView && (
          <div className="k-viewtoggle" role="group" aria-label="Kitchen view">
            <button
              type="button"
              className={view === "list" ? "on" : ""}
              onClick={() => {
                if (view !== "list") onSwitchView();
              }}
            >
              ☰ List
            </button>
            <button
              type="button"
              className={view === "board" ? "on" : ""}
              onClick={() => {
                if (view !== "board") onSwitchView();
              }}
            >
              ▦ Board
            </button>
          </div>
        )}
        {!alertsOn && (
          <button type="button" className="k-btn warn" onClick={turnOnAlerts}>
            🔊 Turn on order alerts
          </button>
        )}
        <KitchenOptionsMenu
          accessToken={session.access_token}
          orderIds={orders.map((o) => o.id)}
          onCleared={() => {
            // The server has stamped these orders 'cleared' and the
            // feed no longer returns them — empty locally at once,
            // close any open detail, then refetch to confirm.
            setDetailId(null);
            setClearConfirmOpen(false);
            setOrders([]);
            fetchOrders();
          }}
        />
      </div>
    </div>
  );

  // ---- detail view -------------------------------------------------------------
  const detail = detailId !== null ? orders.find((o) => o.id === detailId) : undefined;
  if (detailId !== null) {
    return (
      <div className="kitchen-body">
        <div className="kitchen-wrap">
          {header}
          <button
            type="button"
            className="k-btn kl-back"
            onClick={() => {
              setDetailId(null);
              setReprintNote(null);
            }}
          >
            ← All orders
          </button>
          {!detail ? (
            <p style={{ marginTop: "1.5rem" }}>
              This order is no longer on today&apos;s board.
            </p>
          ) : (
            <div className="kl-detail">
              <h2 className="kl-detail-title">
                #{detail.id}{" "}
                <span
                  className={`k-badge ${
                    detail.fulfillment === "delivery"
                      ? "delivery"
                      : detail.fulfillment === "curbside"
                        ? "curbside"
                        : "pickup"
                  }`}
                >
                  {fulfillmentLabel(detail)}
                </span>
                <span className={`k-badge ${detail.payment_status === "unpaid" ? "unpaid" : "paid"}`}>
                  {detail.payment_status === "test_paid"
                    ? "TEST PAID"
                    : detail.payment_status.toUpperCase()}
                </span>
              </h2>
              <div className="kl-detail-status">
                {detail.kitchen_status === "cancelled" ? (
                  <span className="kl-pill cancelled">✖ Cancelled</span>
                ) : detail.kitchen_status === "completed" ? (
                  <span className="kl-pill ready">✔ Ready</span>
                ) : isPaid(detail) ? (
                  <>
                    <span className="kl-pill progress">✔ Accepted</span>{" "}
                    <span className={`kl-timer${nowMs - Date.parse(detail.created_at) >= 15 * 60 * 1000 ? " late" : ""}`}>
                      ⏱ {formatElapsed(nowMs - Date.parse(detail.created_at))}
                    </span>
                  </>
                ) : (
                  <span className="kl-pill unpaid">⏳ Awaiting payment</span>
                )}
                <span className="kl-detail-time">
                  {new Date(detail.created_at).toLocaleString()}
                </span>
              </div>
              {detail.scheduled_for && (
                <div className="kl-scheduled">
                  ⏰ PICKUP AT {formatDenverTime(detail.scheduled_for)}
                </div>
              )}
              <div className="kl-customer">
                <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>
                  {detail.customer_name ?? ""}
                </div>
                {detail.customer_phone && (
                  <div>
                    📞{" "}
                    <a className="kl-phone" href={`tel:${detail.customer_phone}`}>
                      {detail.customer_phone}
                    </a>
                  </div>
                )}
                {detail.fulfillment === "curbside" && detail.car_description && (
                  <div style={{ fontWeight: 700 }}>🚗 {detail.car_description}</div>
                )}
                {detail.fulfillment === "curbside" && detail.customer_here_at && (
                  <div className="k-here-banner">
                    🚗 CUSTOMER IS HERE — since{" "}
                    {new Date(detail.customer_here_at).toLocaleTimeString()}
                  </div>
                )}
                {detail.note?.trim() && (
                  <div style={{ fontWeight: 700 }}>📝 NOTE: {detail.note}</div>
                )}
              </div>
              {detail.fulfillment === "delivery" && detail.delivery_provider === "house" && (
                <div style={{ marginTop: "0.4rem" }}>
                  📍 {detail.delivery_address ?? ""}
                  <div style={{ marginTop: "0.4rem" }}>
                    🏠 <strong>House delivery</strong> — driver scans the QR on
                    the printed ticket
                    {detail.delivery_status === "delivered" ? " · ✓ DELIVERED" : ""}
                  </div>
                  {detail.driver_token && (
                    <div style={{ marginTop: "0.4rem" }}>
                      <QrCode
                        text={`${typeof window !== "undefined" ? window.location.origin : ""}/d/${detail.driver_token}`}
                        size={110}
                      />
                    </div>
                  )}
                </div>
              )}
              {detail.fulfillment === "delivery" && detail.delivery_provider !== "house" && (
                <div style={{ marginTop: "0.4rem" }}>
                  📍 {detail.delivery_address ?? ""}
                  <br />
                  Shipday:{" "}
                  {detail.shipday_order_id
                    ? `sent #${detail.shipday_order_id} · ${detail.shipday_status ?? ""}`
                    : (detail.shipday_status ?? "not sent")}
                </div>
              )}
              <ul className="k-items">
                {(detail.items_json ?? []).map((l, i) => (
                  <li key={i}>
                    {l.qty} × {l.name} — {formatCents(l.line_total_cents)}
                    {(l.options ?? []).map((opt) => (
                      <div className="k-opt" key={`${opt.group}::${opt.name}`}>
                        + {opt.name}
                        {opt.price_delta_cents > 0
                          ? ` (${formatCents(opt.price_delta_cents)})`
                          : ""}
                      </div>
                    ))}
                    {l.instructions && (
                      <div className="k-opt k-note">📝 {l.instructions}</div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="k-money">
                <div className="row">
                  <span>Subtotal</span>
                  <span>{formatCents(detail.subtotal_cents)}</span>
                </div>
                {detail.discount_cents > 0 && (
                  <div className="row">
                    <span>⭐ Loyalty discount</span>
                    <span>−{formatCents(detail.discount_cents)}</span>
                  </div>
                )}
                {(detail.service_fee_cents ?? 0) > 0 && (
                  <div className="row">
                    <span>Service fee</span>
                    <span>{formatCents(detail.service_fee_cents ?? 0)}</span>
                  </div>
                )}
                <div className="row">
                  <span>Tax</span>
                  <span>{formatCents(detail.tax_cents)}</span>
                </div>
                {detail.fulfillment === "delivery" &&
                  (detail.free_delivery ||
                    detail.delivery_fee_cents + (detail.delivery_markup_cents ?? 0) > 0) && (
                    <div className="row">
                      <span>Delivery fee</span>
                      <span>
                        {detail.free_delivery
                          ? "FREE"
                          : formatCents(
                              detail.delivery_fee_cents + (detail.delivery_markup_cents ?? 0)
                            )}
                      </span>
                    </div>
                  )}
                {detail.tip_cents > 0 && (
                  <div className="row">
                    <span>Tip</span>
                    <span>{formatCents(detail.tip_cents)}</span>
                  </div>
                )}
                <div className="row grand">
                  <span>TOTAL</span>
                  <span>{formatCents(detail.total_cents)}</span>
                </div>
              </div>
              <div className="kl-detail-actions">
                {isPaid(detail) && detail.kitchen_status !== "completed" && detail.kitchen_status !== "cancelled" && (
                  <button
                    type="button"
                    className="kl-ready-btn"
                    onClick={() => completeOrder(detail)}
                  >
                    ✔ READY — tap when the food is ready
                  </button>
                )}
                {detail.kitchen_status === "completed" && (
                  <div className="kl-done-note">✔ This order is ready / completed.</div>
                )}
                {isPaid(detail) && detail.kitchen_status !== "cancelled" && (
                  <>
                    <button
                      type="button"
                      className="kl-reprint-btn"
                      disabled={Date.now() < reprintBusyUntil}
                      onClick={() => reprint(detail)}
                    >
                      🖨 Reprint ticket
                    </button>
                    {reprintNote && (
                      <div className={reprintNote.ok ? "kl-reprint-ok" : "kl-reprint-err"}>
                        {reprintNote.text}
                      </div>
                    )}
                  </>
                )}
                {!isPaid(detail) && (
                  <div className="kl-done-note">
                    ⏳ Awaiting payment — the ticket prints automatically when
                    the order is paid.
                  </div>
                )}
                {detail.kitchen_status !== "cancelled" && (
                  <button
                    type="button"
                    className="kl-clear-btn"
                    onClick={() => {
                      setClearError(null);
                      setClearConfirmOpen(true);
                    }}
                  >
                    🧹 Clear order — remove from this screen
                  </button>
                )}
              </div>
            </div>
          )}
          {clearConfirmOpen && detail && (
            <div className="k-confirm-backdrop">
              <div
                className="k-confirm"
                role="alertdialog"
                aria-label={`Clear order #${detail.id}`}
              >
                <p className="k-confirm-title">Clear order #{detail.id}?</p>
                <p>
                  Remove this order from the kitchen screen? It stays in
                  Admin and reports — nothing is deleted.
                </p>
                {clearError && <p className="k-confirm-err">{clearError}</p>}
                <div className="k-confirm-actions">
                  <button
                    type="button"
                    className="k-btn"
                    disabled={clearBusy}
                    onClick={() => setClearConfirmOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="k-btn warn"
                    disabled={clearBusy}
                    onClick={() => clearFromDetail(detail)}
                  >
                    {clearBusy ? "Clearing…" : "Clear order"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- list view -----------------------------------------------------------------
  const base = orders.filter((o) => o.kitchen_status !== "cancelled");
  const inProgress = base.filter(isInProgress);
  const readyList = base.filter((o) => o.kitchen_status === "completed");
  const byNewest = (a: KitchenOrder, b: KitchenOrder) =>
    Date.parse(b.created_at) - Date.parse(a.created_at);
  const shown =
    tab === "progress"
      ? [...inProgress].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      : tab === "ready"
        ? [...readyList].sort(byNewest)
        : [...base].sort(byNewest);
  const counts: Record<Tab, number> = {
    all: base.length,
    progress: inProgress.length,
    ready: readyList.length,
  };
  const emptyText =
    tab === "progress"
      ? "No orders in progress."
      : tab === "ready"
        ? "No ready orders yet today."
        : "No orders yet today.";

  return (
    <div className="kitchen-body">
      <div className="kitchen-wrap">
        {header}
        <div className="kl-tabs" role="tablist" aria-label="Order lists">
          {(
            [
              ["all", "All"],
              ["progress", "In progress"],
              ["ready", "Ready"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`kl-tab${tab === key ? " on" : ""}`}
              onClick={() => {
                setTab(key);
                setArmedClearId(null);
                setListMsg(null);
              }}
            >
              {label} <span className="kl-count">{counts[key]}</span>
            </button>
          ))}
        </div>

        {listMsg && (
          <div className={`kl-list-msg ${listMsg.ok ? "ok" : "err"}`}>{listMsg.text}</div>
        )}

        {shown.length === 0 && <p style={{ marginTop: "1.5rem" }}>{emptyText}</p>}

        <div className="kl-list">
          {shown.map((o) => {
            const customerHere =
              o.fulfillment === "curbside" && Boolean(o.customer_here_at);
            const elapsedMs = nowMs - Date.parse(o.created_at);
            const late = isPaid(o) && o.kitchen_status !== "completed" && elapsedMs >= 15 * 60 * 1000;
            return (
              <div
                key={o.id}
                className={`kl-row${freshRef.current.has(o.id) ? " is-new" : ""}${
                  customerHere ? " customer-here" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-label={`Order #${o.id} — view details`}
                onClick={() => {
                  setReprintNote(null);
                  setDetailId(o.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setReprintNote(null);
                    setDetailId(o.id);
                  }
                }}
              >
                <div className="kl-row-main">
                  <div className="kl-row-top">
                    <span className="kl-id">#{o.id}</span>
                    <span className="kl-name">{o.customer_name ?? "—"}</span>
                    {freshRef.current.has(o.id) && <span className="kl-pill new">NEW</span>}
                  </div>
                  <div className="kl-row-sub">
                    <span
                      className={`k-badge ${
                        o.fulfillment === "delivery"
                          ? "delivery"
                          : o.fulfillment === "curbside"
                            ? "curbside"
                            : "pickup"
                      }`}
                    >
                      {fulfillmentLabel(o)}
                    </span>
                    {o.kitchen_status === "completed" ? (
                      <span className="kl-pill ready">✔ Ready</span>
                    ) : isPaid(o) ? (
                      <span className="kl-pill progress">✔ Accepted</span>
                    ) : (
                      <span className="kl-pill unpaid">⏳ Awaiting payment</span>
                    )}
                    {o.fulfillment === "curbside" && o.car_description && (
                      <span>🚗 {o.car_description}</span>
                    )}
                    {o.fulfillment === "delivery" &&
                      o.delivery_provider === "house" &&
                      o.delivery_status === "delivered" && <span>✓ DELIVERED</span>}
                  </div>
                  {customerHere && (
                    <div className="k-here-banner">
                      🚗 CUSTOMER IS HERE
                      {o.customer_here_at
                        ? ` — since ${new Date(o.customer_here_at).toLocaleTimeString()}`
                        : ""}
                    </div>
                  )}
                  {o.note?.trim() && (
                    <div style={{ fontWeight: 700 }}>📝 {o.note}</div>
                  )}
                  {o.scheduled_for && (
                    <div className="kl-scheduled">
                      ⏰ PICKUP AT {formatDenverTime(o.scheduled_for)}
                    </div>
                  )}
                </div>
                <div className="kl-row-side">
                  <span className="kl-total">{formatCents(o.total_cents)}</span>
                  {o.kitchen_status === "completed" ? (
                    <span className="kl-row-time">
                      {new Date(o.created_at).toLocaleTimeString()}
                    </span>
                  ) : (
                    <span className={`kl-timer${late ? " late" : ""}`}>
                      ⏱ {formatElapsed(elapsedMs)}
                    </span>
                  )}
                  {tab === "ready" && (
                    <button
                      type="button"
                      className={`kl-row-clear${armedClearId === o.id ? " armed" : ""}`}
                      disabled={rowClearBusyId === o.id}
                      aria-label={`Clear order #${o.id} from this screen`}
                      onClick={(e) => {
                        e.stopPropagation();
                        armOrClearRow(o);
                      }}
                    >
                      {rowClearBusyId === o.id
                        ? "Clearing…"
                        : armedClearId === o.id
                          ? "Sure?"
                          : "🧹 Clear"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
