"use client";

// Madinah Market menu page: category sidebar + search, dish
// grid, per-dish options popup, cart (localStorage), pickup/delivery
// toggle, live delivery-fee quote, tip selector, live price breakdown
// and the two-step checkout. The server recomputes every total — the
// numbers here are only for display.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatCents, type MenuItem, type SelectedOption } from "@/lib/menu";
import { getBrowserClient } from "@/lib/supabase/client";
import {
  loadCart,
  saveCart,
  clearCart,
  lineKey,
  type CartLine,
} from "@/lib/cartClient";
import DishPopup from "./DishPopup";
import {
  PICKUP_HOURS,
  DELIVERY_HOURS,
  DEFAULT_HOURS_CONFIG,
  pickupWindows,
  deliveryWindows,
  formatWindow,
  pickupWindowToday,
  denverParts,
  denverTimeTodayToISO,
  validatePickupTime,
  minutesToInputValue,
  type HoursConfig,
} from "@/lib/hours";

type FeeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok";
      quote_id: string;
      /** Pure DoorDash fee. */
      fee_cents: number;
      /** Restaurant's extra "Delivery service fee" (markup), if any. */
      service_fee_cents: number;
      label: string;
      expires_at: string;
    }
  | { kind: "far"; message: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "expired" };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

function taxFor(subtotal: number): number {
  return Math.round(subtotal * 0.08);
}

interface SiteState {
  settings: {
    ordering_enabled: boolean;
    pickup_enabled: boolean;
    delivery_enabled: boolean;
  };
  unavailable: string[];
  promotions: { id: number; title: string; body: string; item_id: string | null }[];
  photos: Record<string, string>;
  hours?: HoursConfig;
}

interface DisplayLine {
  key: string;
  cartLine: CartLine;
  item: MenuItem;
  qty: number;
  unit_cents: number;
  line_total_cents: number;
}

export default function Storefront({
  testMode,
  menu,
  categories,
}: {
  testMode: boolean;
  menu: MenuItem[];
  categories: string[];
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [popupItem, setPopupItem] = useState<MenuItem | null>(null);
  const [activeCat, setActiveCat] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [showCheckout, setShowCheckout] = useState(false);
  const [fulfillment, setFulfillment] = useState<"pickup" | "delivery">("pickup");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [fee, setFee] = useState<FeeState>({ kind: "idle" });
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [tipPercent, setTipPercent] = useState(0);
  const [tipCustom, setTipCustom] = useState("");
  const [error, setError] = useState("");
  const [placing, setPlacing] = useState(false);
  const [successOrder, setSuccessOrder] = useState<number | null>(null);
  const [qrSource, setQrSource] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [guestChosen, setGuestChosen] = useState(false);
  const [siOpen, setSiOpen] = useState(false);
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");
  const [siBusy, setSiBusy] = useState(false);
  const [siError, setSiError] = useState("");
  // Loyalty (signed-in customers only).
  const [pointsBalance, setPointsBalance] = useState<number | null>(null);
  const [usePoints, setUsePoints] = useState(false);
  // Admin-controlled site state (switches, sold-out dishes, promotions,
  // uploaded photos). Defaults keep the site fully open until loaded.
  const [siteState, setSiteState] = useState<SiteState | null>(null);
  // Scheduled pickup.
  const [pickupWhen, setPickupWhen] = useState<"asap" | "later">("asap");
  const [pickupTime, setPickupTime] = useState("");
  const feeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feeSeq = useRef(0);

  // Load cart + URL state once on mount.
  useEffect(() => {
    setCart(loadCart());
    setCartLoaded(true);
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "qr") setQrSource(true);
    const orderParam = Number(params.get("order"));
    if (orderParam && params.get("paid") === "1") {
      setSuccessOrder(orderParam);
      setCart([]);
      clearCart();
    }
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    if (cartLoaded) saveCart(cart);
  }, [cart, cartLoaded]);

  // Admin-controlled site state: switches, sold-out dishes, promotions,
  // uploaded dish photos. Loaded once; the site fails open (all ordering
  // on, everything available) if it cannot be reached.
  useEffect(() => {
    fetch("/api/admin")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SiteState | null) => {
        if (data) setSiteState(data);
      })
      .catch(() => {});
  }, []);

  const orderingClosed = siteState !== null && !siteState.settings.ordering_enabled;
  const pickupOff = siteState !== null && !siteState.settings.pickup_enabled;
  const deliveryOff = siteState !== null && !siteState.settings.delivery_enabled;
  const unavailableSet = new Set(siteState?.unavailable ?? []);
  const promos = siteState?.promotions ?? [];
  const dishPhotos = siteState?.photos ?? {};
  // Admin-editable hours (fall back to the built-in defaults until the
  // site state loads or if the server does not send them).
  const hoursCfg = siteState?.hours ?? DEFAULT_HOURS_CONFIG;
  const pickupWins = siteState?.hours ? pickupWindows(hoursCfg) : PICKUP_HOURS;
  const deliveryWins = siteState?.hours ? deliveryWindows(hoursCfg) : DELIVERY_HOURS;

  // If the admin turned the selected fulfillment type off, switch over.
  useEffect(() => {
    if (fulfillment === "pickup" && pickupOff && !deliveryOff) setFulfillment("delivery");
    if (fulfillment === "delivery" && deliveryOff && !pickupOff) setFulfillment("pickup");
  }, [fulfillment, pickupOff, deliveryOff]);

  // Load the signed-in customer's profile: greet them and prefill the
  // checkout form from their saved details (only into fields still empty).
  async function loadAccountFromToken(token: string) {
    try {
      const res = await fetch("/api/account/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const me = await res.json();
      const p = me.profile ?? {};
      setAccountName(p.display_name || me.email || "My account");
      setAccountEmail(me.email ?? null);
      if (p.display_name) {
        const parts = p.display_name.trim().split(/\s+/);
        setFirstName((prev) => prev || parts[0] || "");
        if (parts.length > 1)
          setLastName((prev) => prev || parts.slice(1).join(" "));
      }
      if (p.phone) setPhone((prev) => prev || p.phone);
      if (p.default_address) setAddress((prev) => prev || p.default_address);
      // Loyalty balance for the checkout points box (rides along with /me).
      if (me.points && typeof me.points.balance === "number") {
        setPointsBalance(me.points.balance);
      }
    } catch {
      /* guest checkout is unaffected */
    }
  }

  useEffect(() => {
    const client = getBrowserClient();
    if (!client) return;
    client.auth
      .getSession()
      .then(async ({ data }) => {
        const token = data.session?.access_token;
        if (token) await loadAccountFromToken(token);
        // Returning from Google sign-in: re-open the checkout panel.
        try {
          if (token && sessionStorage.getItem("mm_open_checkout") === "1") {
            sessionStorage.removeItem("mm_open_checkout");
            setShowCheckout(true);
            setTimeout(
              () => document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" }),
              80
            );
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sign in without leaving checkout (the "Sign in or continue as guest"
  // choice at the top of the checkout panel).
  async function inlineSignIn() {
    setSiError("");
    setSiBusy(true);
    try {
      const client = getBrowserClient();
      if (!client) throw new Error("Sign-in is not available right now.");
      const { data, error } = await client.auth.signInWithPassword({
        email: siEmail.trim(),
        password: siPassword,
      });
      if (error) throw new Error(error.message);
      const token = data.session?.access_token;
      if (token) await loadAccountFromToken(token);
      setSiOpen(false);
      setSiPassword("");
    } catch (e) {
      setSiError(e instanceof Error ? e.message : "Sign-in failed. Please try again.");
    } finally {
      setSiBusy(false);
    }
  }

  // Google sign-in leaves the site and comes back; remember to re-open
  // the checkout panel on return (the cart itself survives in localStorage).
  async function googleSignIn() {
    setSiError("");
    try {
      const client = getBrowserClient();
      if (!client) throw new Error("unavailable");
      try {
        sessionStorage.setItem("mm_open_checkout", "1");
      } catch {
        /* ignore */
      }
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/menu` },
      });
      if (error) throw new Error(error.message);
    } catch {
      setSiError(
        "Google sign-in is not switched on yet — please use email sign-in or continue as guest."
      );
    }
  }

  async function inlineSignOut() {
    const client = getBrowserClient();
    if (client) await client.auth.signOut().catch(() => {});
    setAccountName(null);
    setAccountEmail(null);
    setGuestChosen(false);
    setPointsBalance(null);
    setUsePoints(false);
  }

  const menuById = useMemo(
    () => Object.fromEntries(menu.map((m) => [m.id, m])),
    [menu]
  );

  const lines: DisplayLine[] = useMemo(() => {
    const out: DisplayLine[] = [];
    for (const cl of cart) {
      const item = menuById[cl.id];
      if (!item) continue;
      const unit =
        item.price_cents +
        cl.options.reduce((s, o) => s + (o.price_delta_cents || 0), 0);
      out.push({
        key: lineKey(cl),
        cartLine: cl,
        item,
        qty: cl.qty,
        unit_cents: unit,
        line_total_cents: unit * cl.qty,
      });
    }
    return out;
  }, [cart, menuById]);

  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.line_total_cents, 0);
  // Loyalty preview: whole 100-point blocks ($5.00 each), capped by the
  // subtotal. The server recomputes this authoritatively at checkout.
  const redeemBlocks =
    usePoints && pointsBalance !== null
      ? Math.min(Math.floor(pointsBalance / 100), Math.floor(subtotal / 500))
      : 0;
  const discountPreview = redeemBlocks * 500;
  const tax = taxFor(subtotal - discountPreview);
  const tipCustomCents = tipCustom ? Math.round(Number(tipCustom) * 100) : NaN;
  const tip =
    tipCustom && Number.isFinite(tipCustomCents)
      ? Math.min(Math.max(tipCustomCents, 0), 20000)
      : Math.round((subtotal * Math.min(Math.max(tipPercent, 0), 30)) / 100);
  const deliveryFee =
    fulfillment === "delivery" && fee.kind === "ok"
      ? fee.fee_cents + fee.service_fee_cents
      : 0;
  const total = subtotal - discountPreview + tax + deliveryFee + tip;

  // Add (or merge) a cart line: same dish + same options + same
  // instructions merges; anything different stays a separate line.
  const addLine = useCallback(
    (item: MenuItem, qty: number, options: SelectedOption[], instructions: string) => {
      const incoming: CartLine = { id: item.id, qty, options, instructions };
      const key = lineKey(incoming);
      setCart((prev) => {
        const idx = prev.findIndex((l) => lineKey(l) === key);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], qty: Math.min(next[idx].qty + qty, 50) };
        return next;
      });
    },
    []
  );

  // Quantity of the plain (no options, no instructions) line of a dish —
  // used by the simple Add/stepper controls on dishes without options.
  const plainQty = useCallback(
    (itemId: string) =>
      cart.find((l) => l.id === itemId && l.options.length === 0 && !l.instructions)
        ?.qty ?? 0,
    [cart]
  );

  const setPlainQty = useCallback((item: MenuItem, qty: number) => {
    setCart((prev) => {
      const idx = prev.findIndex(
        (l) => l.id === item.id && l.options.length === 0 && !l.instructions
      );
      if (qty <= 0) {
        return idx === -1 ? prev : prev.filter((_, i) => i !== idx);
      }
      if (idx === -1) {
        return [...prev, { id: item.id, qty: Math.min(qty, 50), options: [], instructions: "" }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], qty: Math.min(qty, 50) };
      return next;
    });
  }, []);

  const setLineQty = useCallback((key: string, qty: number) => {
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => lineKey(l) !== key)
        : prev.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(qty, 50) } : l))
    );
  }, []);

  const totalQtyFor = useCallback(
    (itemId: string) =>
      cart.filter((l) => l.id === itemId).reduce((s, l) => s + l.qty, 0),
    [cart]
  );

  // Debounced DoorDash delivery quote while the address is typed
  // (Stage 3: /api/delivery-quote stores the quote server-side; the
  // quote id goes to checkout, which re-loads the fee from the store —
  // the browser's numbers are never trusted). The tip is an input
  // because tipping the driver lowers the DoorDash fee.
  useEffect(() => {
    if (fulfillment !== "delivery") return;
    if (feeTimer.current) clearTimeout(feeTimer.current);
    const trimmed = address.trim();
    if (trimmed.length < 6) {
      setFee({ kind: "idle" });
      return;
    }
    setFee({ kind: "loading" });
    const seq = ++feeSeq.current;
    feeTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/delivery-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: trimmed,
            phone: phone.trim() || undefined,
            tip_cents: tip,
            subtotal_cents: subtotal,
          }),
        });
        const data = await res.json();
        if (seq !== feeSeq.current) return; // a newer quote is in flight
        if (data.error === "far") {
          setFee({ kind: "far", message: String(data.message ?? "That address is outside our delivery area.") });
        } else if (data.error === "not_found") {
          setFee({ kind: "not_found" });
        } else if (data.error) {
          setFee({
            kind: "error",
            message: String(data.message ?? "We could not get a delivery quote right now."),
          });
        } else {
          const eta = data.estimated_dropoff_at
            ? `Arrives about ${new Date(data.estimated_dropoff_at).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}`
            : "";
          setFee({
            kind: "ok",
            quote_id: String(data.quote_id),
            fee_cents: Number(data.fee_cents) || 0,
            service_fee_cents: Number(data.service_fee_cents) || 0,
            label: eta,
            expires_at: String(data.expires_at),
          });
        }
      } catch {
        if (seq === feeSeq.current) {
          setFee({
            kind: "error",
            message: "We could not get a delivery quote right now. Please try again.",
          });
        }
      }
    }, 700);
    return () => {
      if (feeTimer.current) clearTimeout(feeTimer.current);
    };
  }, [address, fulfillment, phone, tip, quoteNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quote expiry: when the stored quote lapses, refresh it and show
  // the (possibly changed) fee before the customer pays — a changed
  // total is never charged silently.
  useEffect(() => {
    if (fee.kind !== "ok") return;
    const ms = new Date(fee.expires_at).getTime() - Date.now();
    const fire = () => {
      setFee({ kind: "expired" });
      setQuoteNonce((n) => n + 1);
    };
    if (ms <= 0) {
      fire();
      return;
    }
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  }, [fee]);

  const checkoutBlocked = fulfillment === "delivery" && fee.kind !== "ok";

  // Checkout is a two-step flow (Sami's spec): first the customer chooses
  // Sign in / Sign in with Google / Continue as guest — only then does the
  // details form (name, phone, tip…) appear, prefilled when signed in.
  const formOpen = !!accountEmail || guestChosen;
  const fullName = `${firstName} ${lastName}`.trim();

  async function placeOrder() {
    setError("");
    if (lines.length === 0) return setError("Your cart is empty.");
    if (fullName.length < 2) return setError("Please enter your name.");
    if (phone.replace(/\D/g, "").length < 7) return setError("Please enter your phone number.");
    if (fulfillment === "delivery" && fee.kind !== "ok") {
      return setError("Please enter a delivery address inside our delivery area first.");
    }
    // Scheduled pickup ("pickup for later") — validated again on the server.
    let scheduledFor: string | undefined;
    if (fulfillment === "pickup" && pickupWhen === "later") {
      const iso = pickupTime ? denverTimeTodayToISO(pickupTime) : null;
      if (!iso) return setError("Please choose a pickup time.");
      const problem = validatePickupTime(iso, new Date(), hoursCfg);
      if (problem) return setError(problem);
      scheduledFor = iso;
    }
    setPlacing(true);
    try {
      // Attach the account session (if any) so the order is saved to the
      // customer's history. Guests send no header and stay anonymous.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      try {
        const client = getBrowserClient();
        const { data } = client ? await client.auth.getSession() : { data: { session: null } };
        const token = data.session?.access_token;
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch {
        /* proceed as guest */
      }
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: lines.map((l) => ({
            id: l.item.id,
            qty: l.qty,
            ...(l.cartLine.options.length > 0
              ? {
                  options: l.cartLine.options.map((o) => ({
                    group: o.group,
                    name: o.name,
                  })),
                }
              : {}),
            ...(l.cartLine.instructions
              ? { instructions: l.cartLine.instructions }
              : {}),
          })),
          customer_name: fullName,
          customer_phone: phone.trim(),
          fulfillment,
          delivery_address: fulfillment === "delivery" ? address.trim() : undefined,
          delivery_quote_id:
            fulfillment === "delivery" && fee.kind === "ok" ? fee.quote_id : undefined,
          note: note.trim() || undefined,
          ...(tipCustom && Number.isFinite(tipCustomCents)
            ? { tip_custom_cents: tipCustomCents }
            : { tip_percent: tipPercent }),
          ...(usePoints ? { use_points: true } : {}),
          ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok && data.code === "quote_expired") {
        // Refresh the quote so the customer sees and confirms the new
        // total before paying — never charge a silently changed fee.
        setQuoteNonce((n) => n + 1);
        throw new Error(
          "The delivery quote expired — we refreshed the fee. Please review the new total, then place the order again."
        );
      }
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      if (data.url) {
        window.location.href = data.url as string;
        return;
      }
      if (data.test_mode) {
        const payRes = await fetch("/api/test-pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: data.order_id }),
        });
        if (!payRes.ok) throw new Error("Test payment failed");
        setSuccessOrder(data.order_id as number);
        setCart([]);
        clearCart();
        setShowCheckout(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  // ---- menu filtering (sidebar + search) -----------------------------------
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (m: MenuItem) =>
    !searching ||
    m.name.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q);
  const visibleByCat = (cat: string) =>
    menu.filter((m) => m.category === cat && matches(m));

  function renderCard(m: MenuItem) {
    const soldOut = unavailableSet.has(m.id);
    const hasOptions = (m.option_groups?.length ?? 0) > 0;
    const qty = plainQty(m.id);
    const inCart = totalQtyFor(m.id);
    return (
      <article className="card" key={m.id}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dishPhotos[m.id] ?? m.image}
          alt={m.name}
          loading="lazy"
          onClick={hasOptions ? () => setPopupItem(m) : undefined}
          style={hasOptions ? { cursor: "pointer" } : undefined}
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        <div className="card-body">
          <h3>
            {m.number && <span className="num">{m.number}</span>}
            {m.name}
          </h3>
          <p>{m.description}</p>
          {hasOptions && <p className="has-options">✦ Has add-ons &amp; options</p>}
          <div className="price-row">
            <span className="price">
              {hasOptions && <span className="from">from </span>}
              {formatCents(m.price_cents)}
            </span>
            {soldOut ? (
              <>
                <span className="soldout-badge">Sold out</span>
                {qty > 0 && (
                  <span className="qty-controls">
                    <button type="button" onClick={() => setPlainQty(m, qty - 1)} aria-label="Remove one">
                      −
                    </button>
                    <span className="count">{qty}</span>
                  </span>
                )}
              </>
            ) : hasOptions ? (
              <button type="button" className="add-btn" onClick={() => setPopupItem(m)}>
                {inCart > 0 ? `Add more · ${inCart} in cart` : "+ Add"}
              </button>
            ) : orderingClosed && qty === 0 ? (
              <button type="button" className="add-btn" disabled>
                Closed
              </button>
            ) : qty === 0 ? (
              <button type="button" className="add-btn" onClick={() => setPlainQty(m, 1)}>
                + Add
              </button>
            ) : (
              <span className="qty-controls">
                <button type="button" onClick={() => setPlainQty(m, qty - 1)} aria-label="Remove one">
                  −
                </button>
                <span className="count">{qty}</span>
                <button type="button" onClick={() => setPlainQty(m, qty + 1)} aria-label="Add one">
                  +
                </button>
              </span>
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <>
      {testMode && (
        <div className="testmode-banner">
          TEST MODE — no real payment is taken. Orders are marked “test paid”.
        </div>
      )}

      {orderingClosed && (
        <div className="closed-banner">
          🔴 Online ordering is closed right now — please call us at{" "}
          <a href="tel:+17207630786">720-763-0786</a>. You can still browse the menu.
        </div>
      )}

      {promos.map((p) => {
        const dish = p.item_id ? menu.find((m) => m.id === p.item_id) : null;
        return (
          <div className="promo-box" key={p.id}>
            {dish && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={dishPhotos[dish.id] ?? dish.image} alt={dish.name} />
            )}
            <div className="promo-text">
              <strong>🎁 {p.title}</strong>
              {p.body && <span>{p.body}</span>}
              {dish && (
                <span className="promo-dish">
                  {dish.name} · {formatCents(dish.price_cents)}
                </span>
              )}
            </div>
          </div>
        );
      })}

      <main className="wrap">
        {successOrder !== null && (
          <div className="success-banner">
            ✅ <strong>Order #{successOrder} received!</strong> Thank you — we are on it.
            <br />
            <Link href={`/track?order=${successOrder}`}>Track your order →</Link>
          </div>
        )}

        {qrSource && (
          <div className="qr-note">👋 Order here — no app download needed. Pay online, we’ll handle the rest.</div>
        )}

        {installEvent && (
          <div className="install-row">
            <button
              type="button"
              onClick={async () => {
                await installEvent.prompt();
                setInstallEvent(null);
              }}
            >
              📲 Install the Madinah app
            </button>
          </div>
        )}

        <div className="menu-layout">
          <aside className="menu-sidebar">
            <h2 className="sidebar-title">Menu</h2>
            <button
              type="button"
              className={activeCat === "All" ? "active" : ""}
              onClick={() => setActiveCat("All")}
            >
              All dishes
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={activeCat === c ? "active" : ""}
                onClick={() => setActiveCat(c)}
              >
                {c}
              </button>
            ))}
            <div className="sidebar-account">
              {accountName ? (
                <Link href="/account">👤 {accountName}</Link>
              ) : (
                <Link href="/account">👤 Log in</Link>
              )}
            </div>
          </aside>

          <div className="menu-main">
            <div className="menu-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="🔍 Search the menu — try “kabob” or “falafel”"
                aria-label="Search the menu"
              />
            </div>

            {searching ? (
              <section>
                <h2 className="category-title">
                  Results for “{query.trim()}” ({menu.filter(matches).length})
                </h2>
                <div className="menu-grid">{menu.filter(matches).map(renderCard)}</div>
                {menu.filter(matches).length === 0 && (
                  <p>No dishes match — try another word, or browse the categories.</p>
                )}
              </section>
            ) : activeCat !== "All" ? (
              <section>
                <h2 className="category-title">{activeCat}</h2>
                <div className="menu-grid">{visibleByCat(activeCat).map(renderCard)}</div>
              </section>
            ) : (
              categories.map((category) => (
                <section key={category}>
                  <h2 className="category-title">{category}</h2>
                  <div className="menu-grid">{visibleByCat(category).map(renderCard)}</div>
                </section>
              ))
            )}
          </div>
        </div>

        {showCheckout && (
          <section className="panel" id="checkout">
            <h3>Your order</h3>
            {lines.map((l) => (
              <div className="cart-line-wrap" key={l.key}>
                <div className="cart-line">
                  <span>
                    {l.qty} × {l.item.name}
                  </span>
                  <span>{formatCents(l.line_total_cents)}</span>
                </div>
                {l.cartLine.options.length > 0 && (
                  <div className="line-options">
                    {l.cartLine.options.map((o) => (
                      <span key={`${o.group}::${o.name}`}>
                        • {o.name}
                        {o.price_delta_cents > 0
                          ? ` (+${formatCents(o.price_delta_cents)})`
                          : ""}
                      </span>
                    ))}
                  </div>
                )}
                {l.cartLine.instructions && (
                  <div className="line-note">“{l.cartLine.instructions}”</div>
                )}
                <div className="line-controls">
                  <span className="qty-controls small">
                    <button type="button" onClick={() => setLineQty(l.key, l.qty - 1)} aria-label="One less">
                      −
                    </button>
                    <span className="count">{l.qty}</span>
                    <button type="button" onClick={() => setLineQty(l.key, l.qty + 1)} aria-label="One more">
                      +
                    </button>
                  </span>
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => setLineQty(l.key, 0)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            {!formOpen ? (
              <div className="auth-box">
                <strong>Sign in or continue as guest</strong>
                <div className="toggle-row">
                  <button
                    type="button"
                    className={siOpen ? "active" : ""}
                    onClick={() => setSiOpen(true)}
                  >
                    🔑 Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGuestChosen(true);
                      setSiOpen(false);
                    }}
                  >
                    👤 Continue as guest
                  </button>
                </div>
                <button type="button" className="google-btn" onClick={googleSignIn}>
                  Sign in with Google
                </button>
                {siOpen && (
                  <div>
                    <div className="field">
                      <label htmlFor="si-email">Email</label>
                      <input
                        id="si-email"
                        type="email"
                        value={siEmail}
                        onChange={(e) => setSiEmail(e.target.value)}
                        autoComplete="email"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="si-password">Password</label>
                      <input
                        id="si-password"
                        type="password"
                        value={siPassword}
                        onChange={(e) => setSiPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </div>
                    {siError && <div className="fee-msg err">{siError}</div>}
                    <button
                      type="button"
                      className="checkout-btn"
                      disabled={siBusy || !siEmail || !siPassword}
                      onClick={inlineSignIn}
                    >
                      {siBusy ? "Signing in…" : "Sign in & continue"}
                    </button>
                    <div className="fee-msg">
                      New here? <Link href="/account">Create an account</Link> — it takes 30
                      seconds.
                    </div>
                  </div>
                )}
              </div>
            ) : accountEmail ? (
              <div className="auth-box">
                <div className="fee-msg ok">
                  ✓ Signed in as {accountEmail} — your saved details are filled in below, and
                  this order will be saved to your account.
                </div>
                <button type="button" className="auth-link" onClick={inlineSignOut}>
                  Not you? Log out
                </button>
              </div>
            ) : (
              <div className="auth-box">
                <span>👤 Checking out as guest · </span>
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => setGuestChosen(false)}
                >
                  ← Back
                </button>
              </div>
            )}

            {formOpen && (
              <>
            <div className="toggle-row">
              <button
                type="button"
                className={fulfillment === "pickup" ? "active" : ""}
                onClick={() => setFulfillment("pickup")}
                disabled={pickupOff}
              >
                🏃 Pickup{pickupOff ? " (off)" : ""}
              </button>
              <button
                type="button"
                className={fulfillment === "delivery" ? "active" : ""}
                onClick={() => setFulfillment("delivery")}
                disabled={deliveryOff}
              >
                🛵 Delivery{deliveryOff ? " (off)" : ""}
              </button>
            </div>
            <div className="fee-msg">
              {fulfillment === "pickup"
                ? `Pickup today: ${formatWindow(pickupWins[denverParts(new Date()).dayIndex])}`
                : `Delivery today: ${formatWindow(deliveryWins[denverParts(new Date()).dayIndex])}`}
            </div>

            {fulfillment === "pickup" && (
              <div className="field">
                <label>Pickup time</label>
                <div className="toggle-row">
                  <button
                    type="button"
                    className={pickupWhen === "asap" ? "active" : ""}
                    onClick={() => setPickupWhen("asap")}
                  >
                    ⚡ As soon as possible
                  </button>
                  <button
                    type="button"
                    className={pickupWhen === "later" ? "active" : ""}
                    onClick={() => setPickupWhen("later")}
                  >
                    ⏰ Later today
                  </button>
                </div>
                {pickupWhen === "later" && (
                  <>
                    <input
                      type="time"
                      value={pickupTime}
                      min={minutesToInputValue(pickupWindowToday(new Date(), hoursCfg).open)}
                      max={minutesToInputValue(pickupWindowToday(new Date(), hoursCfg).close)}
                      onChange={(e) => setPickupTime(e.target.value)}
                    />
                    <div className="fee-msg">
                      Pick any time today inside pickup hours (
                      {formatWindow(pickupWindowToday(new Date(), hoursCfg))}) — e.g. in 2 or 3 hours.
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="co-first">First name</label>
              <input
                id="co-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="field">
              <label htmlFor="co-last">Last name</label>
              <input
                id="co-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className="field">
              <label htmlFor="co-phone">Phone number</label>
              <input
                id="co-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>

            {fulfillment === "delivery" ? (
              <div className="field">
                <label htmlFor="co-address">Delivery address</label>
                <input
                  id="co-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street address, city, ZIP"
                  autoComplete="street-address"
                />
                {fee.kind === "loading" && <div className="fee-msg">Checking delivery fee…</div>}
                {fee.kind === "ok" && (
                  <div className="fee-msg ok">
                    ✅ Delivery fee {formatCents(fee.fee_cents)} (DoorDash)
                    {fee.service_fee_cents > 0 &&
                      ` + ${formatCents(fee.service_fee_cents)} service fee`}
                    {fee.label ? ` — ${fee.label}` : ""}
                  </div>
                )}
                {fee.kind === "far" && <div className="fee-msg err">{fee.message}</div>}
                {fee.kind === "not_found" && (
                  <div className="fee-msg err">We could not find that address — please check it.</div>
                )}
                {fee.kind === "expired" && (
                  <div className="fee-msg">Your delivery quote expired — refreshing the fee…</div>
                )}
                {fee.kind === "error" && (
                  <div className="fee-msg err">
                    {fee.message}{" "}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setQuoteNonce((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="co-note">Pickup note (optional)</label>
                <input
                  id="co-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. ready in 20 minutes"
                />
              </div>
            )}

            <div className="field">
              <label>Add a tip (thank you!)</label>
              <div className="tip-row">
                {[0, 10, 15, 20].map((pct) => (
                  <button
                    type="button"
                    key={pct}
                    className={!tipCustom && tipPercent === pct ? "active" : ""}
                    onClick={() => {
                      setTipPercent(pct);
                      setTipCustom("");
                    }}
                  >
                    {pct === 0 ? "No tip" : `${pct}%`}
                  </button>
                ))}
              </div>
              <input
                className="tip-custom"
                type="number"
                min="0"
                step="0.5"
                placeholder="Custom $"
                value={tipCustom}
                onChange={(e) => setTipCustom(e.target.value)}
              />
            </div>

            {accountEmail && pointsBalance !== null && (
              <div className="auth-box">
                {pointsBalance >= 100 ? (
                  <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={usePoints}
                      onChange={(e) => setUsePoints(e.target.checked)}
                    />
                    <span>
                      ⭐ Use my points — you have <strong>{pointsBalance} pts</strong>
                      {redeemBlocks > 0 && usePoints
                        ? ` · ${formatCents(discountPreview)} off applied`
                        : ` · ${formatCents(Math.min(Math.floor(pointsBalance / 100) * 500, Math.floor(subtotal / 500) * 500))} off available`}
                    </span>
                  </label>
                ) : (
                  <span>
                    ⭐ You have <strong>{pointsBalance} points</strong> — earn{" "}
                    {100 - pointsBalance} more for $5.00 off.
                  </span>
                )}
              </div>
            )}

            <div className="breakdown">
              <div className="row">
                <span>Subtotal</span>
                <span>{formatCents(subtotal)}</span>
              </div>
              {discountPreview > 0 && (
                <div className="row">
                  <span>⭐ Loyalty discount ({redeemBlocks * 100} pts)</span>
                  <span>−{formatCents(discountPreview)}</span>
                </div>
              )}
              <div className="row">
                <span>Sales tax (8%)</span>
                <span>{formatCents(tax)}</span>
              </div>
              {fulfillment === "delivery" && (
                <div className="row">
                  <span>Delivery fee (DoorDash)</span>
                  <span>{fee.kind === "ok" ? formatCents(fee.fee_cents) : "—"}</span>
                </div>
              )}
              {fulfillment === "delivery" && fee.kind === "ok" && fee.service_fee_cents > 0 && (
                <div className="row">
                  <span>Delivery service fee</span>
                  <span>{formatCents(fee.service_fee_cents)}</span>
                </div>
              )}
              {tip > 0 && (
                <div className="row">
                  <span>Tip</span>
                  <span>{formatCents(tip)}</span>
                </div>
              )}
              <div className="row grand">
                <span>TOTAL</span>
                <span>{formatCents(total)}</span>
              </div>
            </div>

            {error && <div className="form-error">{error}</div>}
            <button
              type="button"
              className="checkout-btn"
              disabled={placing || checkoutBlocked || orderingClosed || lines.length === 0}
              onClick={placeOrder}
            >
              {placing
                ? "Placing order…"
                : testMode
                  ? `Place ${fulfillment === "delivery" ? "Delivery" : "Pickup"} Order (TEST — no charge)`
                  : `Pay on Stripe & Place ${fulfillment === "delivery" ? "Delivery" : "Pickup"} Order`}
            </button>
              </>
            )}
          </section>
        )}
      </main>

      <footer className="site-footer">
        Madinah Market · 3126 S Parker Rd, Aurora, CO 80014 ·{" "}
        <a href="tel:+17207630786">720-763-0786</a>
        <br />
        🏃 Pickup: Mon–Sat {formatWindow(pickupWins[1])} · Sun {formatWindow(pickupWins[0])}
        <br />
        🛵 Delivery: Mon–Sat {formatWindow(deliveryWins[1])} · Sun {formatWindow(deliveryWins[0])}
        <br />
        Aurora, Colorado · 100% Halal · Kabob, Turkish, Afghan Persian &amp; Middle Eastern
      </footer>

      {popupItem && (
        <DishPopup
          item={popupItem}
          photo={dishPhotos[popupItem.id] ?? popupItem.image}
          soldOut={unavailableSet.has(popupItem.id)}
          orderingClosed={orderingClosed}
          onClose={() => setPopupItem(null)}
          onAdd={(qty, options, instructions) =>
            addLine(popupItem, qty, options, instructions)
          }
        />
      )}

      {itemCount > 0 && !showCheckout && (
        <div className="cart-bar">
          <span className="total">
            🛒 {itemCount} item{itemCount === 1 ? "" : "s"} · {formatCents(subtotal)}
          </span>
          {orderingClosed ? (
            <span>🔴 Ordering closed</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setShowCheckout(true);
                setTimeout(() => document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" }), 50);
              }}
            >
              Checkout →
            </button>
          )}
        </div>
      )}
      {showCheckout && (
        <div className="cart-bar">
          <span className="total">Total {formatCents(total)}</span>
          <button type="button" onClick={() => setShowCheckout(false)}>
            ← Back to menu
          </button>
        </div>
      )}
    </>
  );
}
