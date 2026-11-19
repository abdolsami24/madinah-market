"use client";

// /admin — Madinah Operations panel (staff-only, same login as the
// kitchen). Mirrors the reference Operations admin: a left sidebar
// (SERVICE: Overview, Orders · MANAGE: Catalog, Operations · INSIGHT:
// Reports, Staff, Audit log, Security) with a list + editor workspace.
//
// Data: /api/admin (site state — switches, hours, promotions, menu) and
// /api/admin/panel (overview, orders, reports, staff, audit, catalog,
// security). Every call carries the staff token; the server re-checks
// the staff role on each request.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getBrowserClient } from "@/lib/supabase/client";
import { formatCents, type MenuItem } from "@/lib/menu";
import { minutesToInputValue, type HoursConfig } from "@/lib/hours";
import { deliveryStatusLabel } from "@/lib/deliveryStatus";

// ---- shared types -----------------------------------------------------------

interface Promotion {
  id: number;
  title: string;
  body: string;
  active: boolean;
  item_id: string | null;
}

interface AdminState {
  settings: {
    ordering_enabled: boolean;
    pickup_enabled: boolean;
    delivery_enabled: boolean;
  };
  unavailable: string[];
  promotions: Promotion[];
  photos: Record<string, string>;
  hours: HoursConfig;
  delivery?: {
    max_miles: number;
    min_subtotal_cents: number;
    markup_flat_cents: number;
    markup_percent: number;
  };
  fees?: {
    service_fee: {
      enabled: boolean;
      type: "percent" | "flat";
      percent: number;
      flat_cents: number;
    };
    free_delivery: { enabled: boolean; threshold_cents: number };
  };
  menu: { categories: string[]; items: MenuItem[] };
}

interface PanelOrderLine {
  id: string;
  name: string;
  qty: number;
  unit_price_cents: number;
  options?: { group: string; name: string; price_delta_cents: number }[];
  instructions?: string;
  line_total_cents: number;
}

interface PanelOrder {
  id: number;
  user_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items_json: PanelOrderLine[];
  subtotal_cents: number;
  discount_cents: number;
  points_redeemed: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  fulfillment: string;
  delivery_address: string | null;
  scheduled_for: string | null;
  payment_status: string;
  kitchen_status: string;
  shipday_status: string | null;
  created_at: string;
  // Stage 3 (DoorDash) — absent until supabase/stage3-schema.sql runs.
  delivery_provider?: string | null;
  delivery_external_id?: string | null;
  delivery_status?: string | null;
  delivery_quote_id?: string | null;
  delivery_error?: string | null;
  delivery_status_at?: string | null;
  delivery_markup_cents?: number;
  service_fee_cents?: number;
  free_delivery?: boolean;
  delivery_quote?: {
    provider_mode: string;
    fee_cents: number;
    expires_at: string;
  } | null;
}

interface OverviewData {
  today: {
    date: string;
    orders: number;
    revenue_cents: number;
    avg_order_cents: number;
    by_status: Record<string, number>;
  };
  totals: { orders: number; revenue_cents: number; avg_order_cents: number };
  recent: PanelOrder[];
}

interface ReportsData {
  days: { date: string; orders: number; revenue_cents: number }[];
  top_dishes: { name: string; qty: number; revenue_cents: number }[];
  totals: { orders: number; revenue_cents: number };
}

interface StaffData {
  people: {
    id: string;
    email: string | null;
    role: string;
    display_name: string | null;
    phone: string | null;
    created_at: string;
    last_sign_in_at: string | null;
  }[];
  emails_available: boolean;
}

interface AuditData {
  available: boolean;
  entries: {
    id: number;
    actor: string | null;
    action: string;
    detail: Record<string, unknown>;
    created_at: string;
  }[];
}

interface CatalogItem {
  id: string;
  number?: string;
  name: string;
  description: string;
  price_cents: number;
  category: string;
  image: string;
  station: string;
}

interface CatalogData {
  from_db: boolean;
  categories: { name: string; dish_count: number }[];
  items: CatalogItem[];
  unavailable: string[];
  photos: Record<string, string>;
}

interface SecurityData {
  supabase_configured: boolean;
  stripe_configured: boolean;
  test_mode: boolean;
  board_test_mode: boolean;
  shipday_configured: boolean;
  // Stage 3.
  doordash_configured?: boolean;
  doordash_mode?: string;
  doordash_webhook_secret_configured?: boolean;
  twilio_configured?: boolean;
}

type Section =
  | "Overview"
  | "Orders"
  | "Catalog"
  | "Operations"
  | "Reports"
  | "Staff"
  | "Audit log"
  | "Security";

const NAV: { group: string; items: Section[] }[] = [
  { group: "Service", items: ["Overview", "Orders"] },
  { group: "Manage", items: ["Catalog", "Operations"] },
  { group: "Insight", items: ["Reports", "Staff", "Audit log", "Security"] },
];

const STATUS_FLOW: Record<string, { next: string; label: string } | undefined> = {
  new: { next: "accepted", label: "Accept order" },
  accepted: { next: "preparing", label: "Start preparing" },
  preparing: { next: "ready", label: "Mark ready" },
  ready: { next: "completed", label: "Complete order" },
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Denver",
  });
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<Section, string> = {
  Overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  Orders: "M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21zM9 8h6M9 12h6",
  Catalog: "M4 6h16M4 12h16M4 18h10",
  Operations: "M5 7h14M5 12h14M5 17h14M8 5v4M16 10v4M11 15v4",
  Reports: "M4 20V10M10 20V4M16 20v-8M21 20H3",
  Staff: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.85M15.5 3.15a3.5 3.5 0 0 1 0 6.7",
  "Audit log": "M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6zM9 12l2 2 4-4",
  Security: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v10H6zM12 15v3",
};

// ---- main component -----------------------------------------------------------

export default function AdminPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [state, setState] = useState<AdminState | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("Overview");

  // Panel section data (loaded lazily per section).
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [reports, setReports] = useState<ReportsData | null>(null);
  const [staffData, setStaffData] = useState<StaffData | null>(null);
  const [auditData, setAuditData] = useState<AuditData | null>(null);
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [security, setSecurity] = useState<SecurityData | null>(null);

  // Orders browser.
  const [orders, setOrders] = useState<PanelOrder[] | null>(null);
  const [oStatus, setOStatus] = useState("all");
  const [oPayment, setOPayment] = useState("all");
  const [oQuery, setOQuery] = useState("");
  const [oFrom, setOFrom] = useState("");
  const [oTo, setOTo] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  // Catalog editor.
  const [catalogTab, setCatalogTab] = useState<"items" | "categories">("items");
  const [dishSearch, setDishSearch] = useState("");
  const [selectedDishId, setSelectedDishId] = useState<string | null>(null);
  const [edName, setEdName] = useState("");
  const [edNumber, setEdNumber] = useState("");
  const [edCategory, setEdCategory] = useState("");
  const [edPrice, setEdPrice] = useState("");
  const [edDesc, setEdDesc] = useState("");
  const [edStation, setEdStation] = useState("main");
  const [renameValues, setRenameValues] = useState<Record<string, string>>({});

  // Operations forms (promotions / category / hours).
  const [promoTitle, setPromoTitle] = useState("");
  const [promoBody, setPromoBody] = useState("");
  const [promoItemId, setPromoItemId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [hPickupMsOpen, setHPickupMsOpen] = useState("");
  const [hPickupMsClose, setHPickupMsClose] = useState("");
  const [hPickupSunOpen, setHPickupSunOpen] = useState("");
  const [hPickupSunClose, setHPickupSunClose] = useState("");
  const [hDeliveryMsOpen, setHDeliveryMsOpen] = useState("");
  const [hDeliveryMsClose, setHDeliveryMsClose] = useState("");
  const [hDeliverySunOpen, setHDeliverySunOpen] = useState("");
  const [hDeliverySunClose, setHDeliverySunClose] = useState("");

  // Delivery settings form (Stage 3 — DoorDash).
  const [dlMaxMiles, setDlMaxMiles] = useState("8");
  const [dlMinSubtotal, setDlMinSubtotal] = useState("0");
  const [dlMarkupFlat, setDlMarkupFlat] = useState("0");
  const [dlMarkupPercent, setDlMarkupPercent] = useState("0");

  useEffect(() => {
    if (!state?.delivery) return;
    setDlMaxMiles(String(state.delivery.max_miles));
    setDlMinSubtotal(String(state.delivery.min_subtotal_cents / 100));
    setDlMarkupFlat(String(state.delivery.markup_flat_cents / 100));
    setDlMarkupPercent(String(state.delivery.markup_percent));
  }, [state]);

  // Service Fee + Free Delivery forms.
  const [sfEnabled, setSfEnabled] = useState(false);
  const [sfType, setSfType] = useState<"percent" | "flat">("percent");
  const [sfPercent, setSfPercent] = useState("0");
  const [sfFlat, setSfFlat] = useState("0");
  const [fdEnabled, setFdEnabled] = useState(false);
  const [fdThreshold, setFdThreshold] = useState("50");

  useEffect(() => {
    if (!state?.fees) return;
    setSfEnabled(state.fees.service_fee.enabled);
    setSfType(state.fees.service_fee.type);
    setSfPercent(String(state.fees.service_fee.percent));
    setSfFlat(String(state.fees.service_fee.flat_cents / 100));
    setFdEnabled(state.fees.free_delivery.enabled);
    setFdThreshold(String(state.fees.free_delivery.threshold_cents / 100));
  }, [state]);

  useEffect(() => {
    if (!state?.hours) return;
    setHPickupMsOpen(minutesToInputValue(state.hours.pickup_mon_sat.open));
    setHPickupMsClose(minutesToInputValue(state.hours.pickup_mon_sat.close));
    setHPickupSunOpen(minutesToInputValue(state.hours.pickup_sun.open));
    setHPickupSunClose(minutesToInputValue(state.hours.pickup_sun.close));
    setHDeliveryMsOpen(minutesToInputValue(state.hours.delivery_mon_sat.open));
    setHDeliveryMsClose(minutesToInputValue(state.hours.delivery_mon_sat.close));
    setHDeliverySunOpen(minutesToInputValue(state.hours.delivery_sun.open));
    setHDeliverySunClose(minutesToInputValue(state.hours.delivery_sun.close));
  }, [state]);

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
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadState = useCallback(async (token: string) => {
    const res = await fetch("/api/admin", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as AdminState & { staff?: boolean };
      if (data.staff) setState(data);
    }
  }, []);

  useEffect(() => {
    if (session?.access_token) loadState(session.access_token);
    else setState(null);
  }, [session, loadState]);

  // ---- API helpers ----------------------------------------------------------

  const panelGet = useCallback(
    async <T,>(query: string): Promise<T | null> => {
      if (!session?.access_token) return null;
      const res = await fetch(`/api/admin/panel?${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    },
    [session]
  );

  const loadOverview = useCallback(async () => {
    const data = await panelGet<OverviewData>("section=overview");
    if (data) setOverview(data);
  }, [panelGet]);

  const loadOrders = useCallback(async () => {
    const params = new URLSearchParams({ section: "orders" });
    if (oStatus !== "all") params.set("status", oStatus);
    if (oPayment !== "all") params.set("payment", oPayment);
    if (oQuery.trim()) params.set("q", oQuery.trim());
    if (oFrom) params.set("from", new Date(`${oFrom}T00:00:00`).toISOString());
    if (oTo) params.set("to", new Date(`${oTo}T23:59:59`).toISOString());
    const data = await panelGet<{ orders: PanelOrder[] }>(params.toString());
    if (data) setOrders(data.orders);
  }, [panelGet, oStatus, oPayment, oQuery, oFrom, oTo]);

  const loadCatalog = useCallback(async () => {
    const data = await panelGet<CatalogData>("section=catalog");
    if (data) setCatalog(data);
  }, [panelGet]);

  // Load a section's data the first time it is opened.
  useEffect(() => {
    if (!state) return;
    if (section === "Overview" && !overview) loadOverview();
    if (section === "Orders" && !orders) loadOrders();
    if (section === "Catalog" && !catalog) loadCatalog();
    if (section === "Reports" && !reports) {
      panelGet<ReportsData>("section=reports").then((d) => d && setReports(d));
    }
    if (section === "Staff" && !staffData) {
      panelGet<StaffData>("section=staff").then((d) => d && setStaffData(d));
    }
    if (section === "Audit log" && !auditData) {
      panelGet<AuditData>("section=audit").then((d) => d && setAuditData(d));
    }
    if (section === "Security" && !security) {
      panelGet<SecurityData>("section=security").then((d) => d && setSecurity(d));
    }
  }, [section, state, overview, orders, catalog, reports, staffData, auditData, security, loadOverview, loadOrders, loadCatalog, panelGet]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    const supabase = getBrowserClient();
    if (!supabase) return setLoginError("Supabase is not configured on this site yet.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setLoginError("Login failed — check the email and password.");
  }

  /** POST to /api/admin (site state). Refreshes the admin state. */
  async function act(body: Record<string, unknown>, okText: string) {
    if (!session?.access_token) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setState(data as AdminState);
      setMsg(okText);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Something went wrong.");
    }
    setBusy(false);
  }

  /** POST to /api/admin/panel (panel actions). Throws on failure. */
  async function panelAct(body: Record<string, unknown>, okText: string) {
    if (!session?.access_token) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/panel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMsg(okText);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Something went wrong.");
      throw err;
    } finally {
      setBusy(false);
    }
  }

  /** POST to /api/admin/delivery-retry (DoorDash retry / status refresh). */
  async function deliveryAct(orderId: number, action: "retry" | "refresh", okText: string) {
    if (!session?.access_token) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/delivery-retry", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ order_id: orderId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMsg(okText);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Something went wrong.");
    }
    setBusy(false);
    await loadOrders();
  }

  async function uploadPhoto(itemId: string, file: File) {
    if (!session?.access_token) return;
    setBusy(true);
    setMsg("");
    try {
      const form = new FormData();
      form.set("item_id", itemId);
      form.set("file", file);
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setState(data as AdminState);
      setMsg("Photo updated.");
      await loadCatalog();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Upload failed.");
    }
    setBusy(false);
  }

  async function signOut() {
    const supabase = getBrowserClient();
    await supabase?.auth.signOut();
  }

  // ---- derived ---------------------------------------------------------------

  const selectedOrder = useMemo(
    () => orders?.find((o) => o.id === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  );

  const catalogUnavailable = useMemo(
    () => new Set(catalog?.unavailable ?? state?.unavailable ?? []),
    [catalog, state]
  );

  const selectedDish = useMemo(
    () =>
      selectedDishId && selectedDishId !== "new"
        ? (catalog?.items.find((i) => i.id === selectedDishId) ?? null)
        : null,
    [catalog, selectedDishId]
  );

  // Sync the editor form whenever the selection changes.
  useEffect(() => {
    if (selectedDishId === "new") {
      setEdName("");
      setEdNumber("");
      setEdCategory(catalog?.categories[0]?.name ?? "");
      setEdPrice("");
      setEdDesc("");
      setEdStation("main");
    } else if (selectedDish) {
      setEdName(selectedDish.name);
      setEdNumber(selectedDish.number ?? "");
      setEdCategory(selectedDish.category);
      setEdPrice((selectedDish.price_cents / 100).toFixed(2));
      setEdDesc(selectedDish.description);
      setEdStation(selectedDish.station || "main");
    }
  }, [selectedDishId, selectedDish, catalog]);

  const visibleDishes = useMemo(() => {
    const q = dishSearch.trim().toLowerCase();
    const items = catalog?.items ?? [];
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        (i.number ?? "").toLowerCase().includes(q)
    );
  }, [catalog, dishSearch]);

  // ---- gates -----------------------------------------------------------------

  if (!authReady) {
    return (
      <main className="ops-login">
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="ops-login">
        <div className="ops-login-card">
          <div className="ops-brand ops-brand-login">
            <strong>
              Madinah <span className="gold">Market</span>
            </strong>
            <small>Operations</small>
          </div>
          <p className="ops-muted">Staff sign in — same email and password as the kitchen screen.</p>
          <form onSubmit={login}>
            <div className="ops-field">
              <label htmlFor="ad-email">Email</label>
              <input
                id="ad-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="ops-field">
              <label htmlFor="ad-password">Password</label>
              <input
                id="ad-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {loginError && <div className="form-error">{loginError}</div>}
            <button type="submit" className="ops-btn primary ops-btn-block">
              Sign in
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="ops-login">
        <p>Loading admin… (If this stays, this account is not staff.)</p>
      </main>
    );
  }

  // ---- section renderers -------------------------------------------------------

  const newOrderCount = overview?.today.by_status["new"] ?? 0;

  function renderOverview() {
    if (!overview) return <p className="ops-muted">Loading overview…</p>;
    const stat = (label: string, value: string, sub?: string) => (
      <div className="ops-stat" key={label}>
        <span className="ops-stat-label">{label}</span>
        <span className="ops-stat-value">{value}</span>
        {sub && <span className="ops-stat-sub">{sub}</span>}
      </div>
    );
    return (
      <>
        <div className="ops-stats">
          {stat("Orders today", String(overview.today.orders), overview.today.date)}
          {stat("Revenue today", formatCents(overview.today.revenue_cents), "paid orders")}
          {stat("Avg order today", formatCents(overview.today.avg_order_cents), "paid orders")}
          {stat("Orders all time", String(overview.totals.orders))}
          {stat("Revenue all time", formatCents(overview.totals.revenue_cents), "paid orders")}
          {stat("Avg order all time", formatCents(overview.totals.avg_order_cents), "paid orders")}
        </div>
        <section className="ops-card">
          <h3>Today by kitchen status</h3>
          <div className="ops-chip-row">
            {Object.keys(overview.today.by_status).length === 0 && (
              <span className="ops-muted">No orders yet today.</span>
            )}
            {Object.entries(overview.today.by_status).map(([status, count]) => (
              <span className="ops-chip" key={status}>
                {status}: <strong>{count}</strong>
              </span>
            ))}
          </div>
        </section>
        <section className="ops-card">
          <h3>Recent orders</h3>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Total</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.recent.map((o) => (
                  <tr key={o.id}>
                    <td>#{o.id}</td>
                    <td>{fmtTime(o.created_at)}</td>
                    <td>{o.customer_name ?? "—"}</td>
                    <td>{o.fulfillment}</td>
                    <td className="num">{formatCents(o.total_cents)}</td>
                    <td>{o.payment_status}</td>
                    <td>{o.kitchen_status}</td>
                  </tr>
                ))}
                {overview.recent.length === 0 && (
                  <tr>
                    <td colSpan={7} className="ops-muted">No orders in the last 48 hours.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  function renderOrders() {
    const flow = selectedOrder ? STATUS_FLOW[selectedOrder.kitchen_status] : undefined;
    return (
      <>
        <div className="ops-filters">
          <select value={oStatus} onChange={(e) => setOStatus(e.target.value)} aria-label="Kitchen status">
            <option value="all">All statuses</option>
            {["new", "accepted", "preparing", "ready", "completed", "cancelled"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={oPayment} onChange={(e) => setOPayment(e.target.value)} aria-label="Payment status">
            <option value="all">All payments</option>
            {["unpaid", "paid", "test_paid"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <input
            type="date"
            value={oFrom}
            onChange={(e) => setOFrom(e.target.value)}
            aria-label="From date"
          />
          <input
            type="date"
            value={oTo}
            onChange={(e) => setOTo(e.target.value)}
            aria-label="To date"
          />
          <input
            type="search"
            placeholder="Search name, phone, order #…"
            value={oQuery}
            onChange={(e) => setOQuery(e.target.value)}
          />
          <button type="button" className="ops-btn primary" disabled={busy} onClick={() => loadOrders()}>
            Search
          </button>
        </div>
        <div className="ops-edit-layout">
          <section className="ops-card ops-list-card">
            <div className="ops-record-list">
              {(orders ?? []).map((o) => (
                <button
                  type="button"
                  key={o.id}
                  className="ops-record"
                  aria-pressed={selectedOrderId === o.id}
                  onClick={() => setSelectedOrderId(o.id)}
                >
                  <strong>
                    #{o.id} · {o.customer_name ?? "Guest"}
                  </strong>
                  <span>
                    {fmtTime(o.created_at)} · {o.fulfillment} · {formatCents(o.total_cents)}
                  </span>
                  <span>
                    {o.payment_status} · {o.kitchen_status}
                  </span>
                </button>
              ))}
              {orders && orders.length === 0 && (
                <p className="ops-muted" style={{ padding: "0.6rem" }}>No orders match.</p>
              )}
              {!orders && <p className="ops-muted" style={{ padding: "0.6rem" }}>Loading orders…</p>}
            </div>
          </section>
          <section className="ops-card">
            {!selectedOrder && <p className="ops-muted">Pick an order to see its details.</p>}
            {selectedOrder && (
              <div className="ops-editor">
                <h2>
                  Order #{selectedOrder.id}
                  <span className="ops-chip">{selectedOrder.kitchen_status}</span>
                  <span className="ops-chip">{selectedOrder.payment_status}</span>
                </h2>
                <div className="ops-detail-grid">
                  <span>Placed</span>
                  <strong>{fmtTime(selectedOrder.created_at)}</strong>
                  <span>Customer</span>
                  <strong>{selectedOrder.customer_name ?? "—"}</strong>
                  <span>Phone</span>
                  <strong>{selectedOrder.customer_phone ?? "—"}</strong>
                  <span>Fulfillment</span>
                  <strong>{selectedOrder.fulfillment}</strong>
                  {selectedOrder.fulfillment === "delivery" && (
                    <>
                      <span>Address</span>
                      <strong>{selectedOrder.delivery_address ?? "—"}</strong>
                    </>
                  )}
                  {selectedOrder.scheduled_for && (
                    <>
                      <span>Pickup at</span>
                      <strong>{fmtTime(selectedOrder.scheduled_for)}</strong>
                    </>
                  )}
                  {selectedOrder.shipday_status && (
                    <>
                      <span>Shipday (legacy)</span>
                      <strong>{selectedOrder.shipday_status}</strong>
                    </>
                  )}
                </div>
                {selectedOrder.fulfillment === "delivery" && (
                  <>
                    <h3>
                      Delivery — DoorDash Drive{" "}
                      {selectedOrder.delivery_quote?.provider_mode === "mock" && (
                        <span className="ops-chip">MOCK — simulated, not real DoorDash</span>
                      )}
                      {selectedOrder.delivery_quote?.provider_mode === "live" && (
                        <span className="ops-chip">LIVE</span>
                      )}
                    </h3>
                    <div className="ops-detail-grid">
                      <span>Provider</span>
                      <strong>
                        {selectedOrder.delivery_provider === "doordash"
                          ? "DoorDash Drive"
                          : "Not dispatched yet"}
                        {selectedOrder.delivery_quote
                          ? ` (${selectedOrder.delivery_quote.provider_mode})`
                          : ""}
                      </strong>
                      <span>Delivery ID</span>
                      <strong className="ops-mono">
                        {selectedOrder.delivery_external_id ?? "—"}
                      </strong>
                      <span>Delivery status</span>
                      <strong>
                        {selectedOrder.delivery_status
                          ? `${deliveryStatusLabel(selectedOrder.delivery_status)} (${selectedOrder.delivery_status})`
                          : "—"}
                      </strong>
                      <span>DoorDash fee</span>
                      <strong>
                        {formatCents(
                          selectedOrder.delivery_quote?.fee_cents ??
                            selectedOrder.delivery_fee_cents
                        )}
                      </strong>
                      {(selectedOrder.delivery_markup_cents ?? 0) > 0 && (
                        <>
                          <span>Extra delivery fee (markup)</span>
                          <strong>
                            {formatCents(selectedOrder.delivery_markup_cents ?? 0)}
                          </strong>
                        </>
                      )}
                      {selectedOrder.free_delivery && (
                        <>
                          <span>Free delivery promotion</span>
                          <strong>
                            Applied — customer paid $0.00 for delivery; restaurant
                            absorbed{" "}
                            {formatCents(
                              (selectedOrder.delivery_quote?.fee_cents ??
                                selectedOrder.delivery_fee_cents) +
                                (selectedOrder.delivery_markup_cents ?? 0)
                            )}
                          </strong>
                        </>
                      )}
                      {selectedOrder.delivery_quote && (
                        <>
                          <span>Quote expires</span>
                          <strong>{fmtTime(selectedOrder.delivery_quote.expires_at)}</strong>
                        </>
                      )}
                      {selectedOrder.delivery_status_at && (
                        <>
                          <span>Status updated</span>
                          <strong>{fmtTime(selectedOrder.delivery_status_at)}</strong>
                        </>
                      )}
                      {selectedOrder.delivery_error && (
                        <>
                          <span>Delivery error</span>
                          <strong className="ops-status-off">
                            {selectedOrder.delivery_error}
                          </strong>
                        </>
                      )}
                    </div>
                    <div className="ops-btn-row">
                      {(selectedOrder.payment_status === "paid" ||
                        selectedOrder.payment_status === "test_paid") &&
                        (!selectedOrder.delivery_external_id ||
                          selectedOrder.delivery_status === "pending") && (
                          <button
                            type="button"
                            className="ops-btn primary"
                            disabled={busy}
                            onClick={() =>
                              deliveryAct(
                                selectedOrder.id,
                                "retry",
                                `Delivery for order #${selectedOrder.id} dispatched to DoorDash.`
                              )
                            }
                          >
                            Retry delivery dispatch
                          </button>
                        )}
                      {selectedOrder.delivery_external_id && (
                        <button
                          type="button"
                          className="ops-btn"
                          disabled={busy}
                          onClick={() =>
                            deliveryAct(
                              selectedOrder.id,
                              "refresh",
                              `Delivery status for order #${selectedOrder.id} refreshed.`
                            )
                          }
                        >
                          Refresh delivery status
                        </button>
                      )}
                    </div>
                  </>
                )}
                <h3>Items</h3>
                <div>
                  {(selectedOrder.items_json ?? []).map((line, i) => (
                    <div className="cart-line-wrap" key={i}>
                      <div className="cart-line">
                        <span>
                          {line.qty} × {line.name}
                        </span>
                        <span className="num">{formatCents(line.line_total_cents)}</span>
                      </div>
                      {(line.options ?? []).map((opt, j) => (
                        <div className="line-options" key={j}>
                          <span>
                            + {opt.name}
                            {opt.price_delta_cents > 0
                              ? ` (${formatCents(opt.price_delta_cents)})`
                              : ""}
                          </span>
                        </div>
                      ))}
                      {line.instructions && (
                        <div className="line-options">
                          <span>“{line.instructions}”</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="breakdown">
                  <div className="row">
                    <span>Subtotal</span>
                    <span className="num">{formatCents(selectedOrder.subtotal_cents)}</span>
                  </div>
                  {selectedOrder.discount_cents > 0 && (
                    <div className="row">
                      <span>
                        Loyalty discount
                        {selectedOrder.points_redeemed > 0
                          ? ` (${selectedOrder.points_redeemed} pts)`
                          : ""}
                      </span>
                      <span className="num">−{formatCents(selectedOrder.discount_cents)}</span>
                    </div>
                  )}
                  {(selectedOrder.service_fee_cents ?? 0) > 0 && (
                    <div className="row">
                      <span>Service fee</span>
                      <span className="num">
                        {formatCents(selectedOrder.service_fee_cents ?? 0)}
                      </span>
                    </div>
                  )}
                  <div className="row">
                    <span>Tax</span>
                    <span className="num">{formatCents(selectedOrder.tax_cents)}</span>
                  </div>
                  {selectedOrder.free_delivery ? (
                    <div className="row">
                      <span>Delivery fee — FREE (promotion)</span>
                      <span className="num">{formatCents(0)}</span>
                    </div>
                  ) : (
                    <>
                      {selectedOrder.delivery_fee_cents > 0 && (
                        <div className="row">
                          <span>
                            {selectedOrder.fulfillment === "delivery"
                              ? "Delivery fee (DoorDash)"
                              : "Delivery fee"}
                          </span>
                          <span className="num">{formatCents(selectedOrder.delivery_fee_cents)}</span>
                        </div>
                      )}
                      {(selectedOrder.delivery_markup_cents ?? 0) > 0 && (
                        <div className="row">
                          <span>Extra delivery fee (markup)</span>
                          <span className="num">
                            {formatCents(selectedOrder.delivery_markup_cents ?? 0)}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {selectedOrder.tip_cents > 0 && (
                    <div className="row">
                      <span>Tip</span>
                      <span className="num">{formatCents(selectedOrder.tip_cents)}</span>
                    </div>
                  )}
                  <div className="row grand">
                    <span>Total</span>
                    <span className="num">{formatCents(selectedOrder.total_cents)}</span>
                  </div>
                </div>
                <div className="ops-btn-row">
                  {flow && (
                    <button
                      type="button"
                      className="ops-btn primary"
                      disabled={busy}
                      onClick={async () => {
                        await panelAct(
                          { action: "set_order_status", order_id: selectedOrder.id, status: flow.next },
                          `Order #${selectedOrder.id} is now ${flow.next}.`
                        ).catch(() => {});
                        await loadOrders();
                      }}
                    >
                      {flow.label}
                    </button>
                  )}
                  {selectedOrder.kitchen_status !== "cancelled" &&
                    selectedOrder.kitchen_status !== "completed" && (
                      <button
                        type="button"
                        className="ops-btn danger"
                        disabled={busy}
                        onClick={async () => {
                          if (!window.confirm(`Cancel order #${selectedOrder.id}?`)) return;
                          await panelAct(
                            { action: "set_order_status", order_id: selectedOrder.id, status: "cancelled" },
                            `Order #${selectedOrder.id} cancelled.`
                          ).catch(() => {});
                          await loadOrders();
                        }}
                      >
                        Cancel order
                      </button>
                    )}
                </div>
              </div>
            )}
          </section>
        </div>
      </>
    );
  }

  function renderCatalog() {
    if (!catalog) return <p className="ops-muted">Loading catalog…</p>;
    const isNew = selectedDishId === "new";
    const soldOut = selectedDish ? catalogUnavailable.has(selectedDish.id) : false;
    const photo = selectedDish
      ? (catalog.photos[selectedDish.id] ?? selectedDish.image)
      : null;
    return (
      <>
        <div className="ops-tabs">
          <button
            type="button"
            className={catalogTab === "items" ? "active" : ""}
            onClick={() => setCatalogTab("items")}
          >
            Items
          </button>
          <button
            type="button"
            className={catalogTab === "categories" ? "active" : ""}
            onClick={() => setCatalogTab("categories")}
          >
            Categories
          </button>
        </div>
        {!catalog.from_db && (
          <div className="fee-msg err">
            The menu is currently served from the built-in list (database menu tables are
            empty). Run supabase/admin-schema.sql in Supabase to seed the database menu —
            edits here need it.
          </div>
        )}
        {catalogTab === "categories" && (
          <section className="ops-card">
            <h3>Categories</h3>
            {catalog.categories.map((cat) => (
              <div className="ops-cat-row" key={cat.name}>
                <strong>{cat.name}</strong>
                <span className="ops-muted">{cat.dish_count} dishes</span>
                <input
                  value={renameValues[cat.name] ?? cat.name}
                  onChange={(e) =>
                    setRenameValues((prev) => ({ ...prev, [cat.name]: e.target.value }))
                  }
                  aria-label={`Rename ${cat.name}`}
                />
                <button
                  type="button"
                  className="ops-btn"
                  disabled={
                    busy ||
                    !(renameValues[cat.name] ?? cat.name).trim() ||
                    (renameValues[cat.name] ?? cat.name).trim() === cat.name
                  }
                  onClick={async () => {
                    const to = (renameValues[cat.name] ?? cat.name).trim();
                    await panelAct(
                      { action: "rename_category", from: cat.name, to },
                      `Category renamed to ${to}.`
                    ).catch(() => {});
                    await loadCatalog();
                    if (session?.access_token) loadState(session.access_token);
                  }}
                >
                  Rename
                </button>
              </div>
            ))}
            <div className="ops-field" style={{ marginTop: "1rem" }}>
              <label htmlFor="cat-new">Add a category</label>
              <div className="ops-inline">
                <input
                  id="cat-new"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="e.g. Breakfast"
                />
                <button
                  type="button"
                  className="ops-btn primary"
                  disabled={busy || !newCategory.trim()}
                  onClick={async () => {
                    await act({ action: "add_category", name: newCategory }, "Category added.");
                    setNewCategory("");
                    await loadCatalog();
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </section>
        )}
        {catalogTab === "items" && (
          <div className="ops-edit-layout">
            <section className="ops-card ops-list-card">
              <div className="ops-list-head">
                <h3>Dishes</h3>
                <button
                  type="button"
                  className="ops-btn"
                  onClick={() => setSelectedDishId("new")}
                >
                  Add
                </button>
              </div>
              <input
                className="ops-search"
                type="search"
                placeholder="Find a record…"
                value={dishSearch}
                onChange={(e) => setDishSearch(e.target.value)}
              />
              <div className="ops-record-list">
                {visibleDishes.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="ops-record"
                    aria-pressed={selectedDishId === item.id}
                    onClick={() => setSelectedDishId(item.id)}
                  >
                    <strong>
                      {item.number ? `${item.number} ` : ""}
                      {item.name}
                    </strong>
                    <span>
                      {formatCents(item.price_cents)} ·{" "}
                      {catalogUnavailable.has(item.id) ? "Sold out" : "Available"}
                    </span>
                  </button>
                ))}
                {visibleDishes.length === 0 && (
                  <p className="ops-muted" style={{ padding: "0.6rem" }}>No dishes match.</p>
                )}
              </div>
            </section>
            <section className="ops-card">
              {!selectedDishId && <p className="ops-muted">Pick a dish to edit it, or tap Add.</p>}
              {selectedDishId && (
                <div className="ops-editor">
                  <h2>{isNew ? "New dish" : edName || selectedDish?.name}</h2>
                  <div className="ops-field">
                    <label htmlFor="ed-name">Dish name</label>
                    <input id="ed-name" value={edName} onChange={(e) => setEdName(e.target.value)} />
                  </div>
                  <div className="ops-field">
                    <label htmlFor="ed-number">Menu number</label>
                    <input
                      id="ed-number"
                      value={edNumber}
                      onChange={(e) => setEdNumber(e.target.value)}
                      placeholder="#17"
                    />
                  </div>
                  <div className="ops-field">
                    <label htmlFor="ed-cat">Category</label>
                    <select id="ed-cat" value={edCategory} onChange={(e) => setEdCategory(e.target.value)}>
                      <option value="">Choose…</option>
                      {catalog.categories.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ops-field">
                    <label htmlFor="ed-price">Price ($)</label>
                    <input
                      id="ed-price"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={edPrice}
                      onChange={(e) => setEdPrice(e.target.value)}
                      placeholder="11.75"
                    />
                  </div>
                  <div className="ops-field">
                    <label htmlFor="ed-station">Kitchen station</label>
                    <input
                      id="ed-station"
                      value={edStation}
                      onChange={(e) => setEdStation(e.target.value)}
                      placeholder="main"
                    />
                  </div>
                  <div className="ops-field">
                    <label htmlFor="ed-desc">Description</label>
                    <textarea
                      id="ed-desc"
                      rows={3}
                      value={edDesc}
                      onChange={(e) => setEdDesc(e.target.value)}
                    />
                  </div>
                  {selectedDish && (
                    <>
                      <div className="ops-field">
                        <label>Availability</label>
                        <div className="ops-inline">
                          <span className={soldOut ? "ops-status-off" : "ops-status-on"}>
                            {soldOut ? "Sold out" : "Available"}
                          </span>
                          <button
                            type="button"
                            className="ops-btn"
                            disabled={busy}
                            onClick={async () => {
                              await act(
                                {
                                  action: "set_availability",
                                  item_id: selectedDish.id,
                                  available: soldOut,
                                },
                                soldOut
                                  ? `${selectedDish.name} is available again.`
                                  : `${selectedDish.name} marked sold out.`
                              );
                              await loadCatalog();
                            }}
                          >
                            {soldOut ? "Make available" : "Mark sold out"}
                          </button>
                        </div>
                      </div>
                      <div className="ops-field">
                        <label>Dish photograph</label>
                        {photo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photo} alt="" className="ops-dish-photo" />
                        )}
                        <input type="text" readOnly value={photo ?? ""} aria-label="Photo URL" />
                        <label className="ops-upload">
                          Upload a new photo
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            hidden
                            disabled={busy}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadPhoto(selectedDish.id, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                    </>
                  )}
                  <div className="ops-btn-row">
                    <button
                      type="button"
                      className="ops-btn primary"
                      disabled={busy || !edName.trim() || !edCategory || !edPrice}
                      onClick={async () => {
                        const price_cents = Math.round(Number(edPrice) * 100);
                        if (isNew) {
                          await act(
                            {
                              action: "add_item",
                              name: edName,
                              description: edDesc,
                              price_cents,
                              category: edCategory,
                              number: edNumber,
                              station: edStation || "main",
                            },
                            "Dish added to the menu."
                          );
                          setSelectedDishId(null);
                        } else if (selectedDish) {
                          await panelAct(
                            {
                              action: "update_item",
                              id: selectedDish.id,
                              name: edName,
                              number: edNumber,
                              category: edCategory,
                              price_cents,
                              description: edDesc,
                              station: edStation || "main",
                            },
                            `${edName} saved.`
                          ).catch(() => {});
                        }
                        await loadCatalog();
                        if (session?.access_token) loadState(session.access_token);
                      }}
                    >
                      {isNew ? "Add dish" : "Save changes"}
                    </button>
                    {selectedDish && (
                      <button
                        type="button"
                        className="ops-btn danger"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Delete ${selectedDish.name} from the menu? This cannot be undone.`
                            )
                          )
                            return;
                          await panelAct(
                            { action: "delete_item", id: selectedDish.id },
                            `${selectedDish.name} deleted.`
                          ).catch(() => {});
                          setSelectedDishId(null);
                          await loadCatalog();
                          if (session?.access_token) loadState(session.access_token);
                        }}
                      >
                        Delete dish
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </>
    );
  }

  function renderOperations() {
    if (!state) return null;
    const switchRow = (
      label: string,
      key: "ordering_enabled" | "pickup_enabled" | "delivery_enabled"
    ) => {
      const on = state.settings[key];
      return (
        <div className="cart-line" key={key}>
          <span>
            {label}: <strong>{on ? "ON" : "OFF"}</strong>
          </span>
          <button
            type="button"
            className="ops-btn"
            disabled={busy}
            onClick={() =>
              act({ action: "set_setting", key, value: !on }, `${label} is now ${!on ? "ON" : "OFF"}.`)
            }
          >
            Turn {on ? "OFF" : "ON"}
          </button>
        </div>
      );
    };
    const hoursRow = (
      label: string,
      openVal: string,
      setOpen: (v: string) => void,
      closeVal: string,
      setClose: (v: string) => void
    ) => (
      <div className="ops-field">
        <label>{label}</label>
        <div className="ops-inline">
          <input type="time" value={openVal} onChange={(e) => setOpen(e.target.value)} />
          <span>to</span>
          <input type="time" value={closeVal} onChange={(e) => setClose(e.target.value)} />
        </div>
      </div>
    );
    return (
      <>
        <section className="ops-card">
          <h3>Ordering switches</h3>
          {switchRow("Online ordering (whole system)", "ordering_enabled")}
          {switchRow("Pickup", "pickup_enabled")}
          {switchRow("Delivery", "delivery_enabled")}
          <p className="ops-muted">
            Changes apply to the website immediately. Turning the whole system OFF lets
            customers browse the menu but not order.
          </p>
        </section>
        <section className="ops-card">
          <h3>Opening hours</h3>
          {hoursRow("Pickup — Monday to Saturday", hPickupMsOpen, setHPickupMsOpen, hPickupMsClose, setHPickupMsClose)}
          {hoursRow("Pickup — Sunday", hPickupSunOpen, setHPickupSunOpen, hPickupSunClose, setHPickupSunClose)}
          {hoursRow("Delivery — Monday to Saturday", hDeliveryMsOpen, setHDeliveryMsOpen, hDeliveryMsClose, setHDeliveryMsClose)}
          {hoursRow("Delivery — Sunday", hDeliverySunOpen, setHDeliverySunOpen, hDeliverySunClose, setHDeliverySunClose)}
          <button
            type="button"
            className="ops-btn primary"
            disabled={busy}
            onClick={() =>
              act(
                {
                  action: "set_hours",
                  hours: {
                    hours_pickup_mon_sat_open: hPickupMsOpen,
                    hours_pickup_mon_sat_close: hPickupMsClose,
                    hours_pickup_sun_open: hPickupSunOpen,
                    hours_pickup_sun_close: hPickupSunClose,
                    hours_delivery_mon_sat_open: hDeliveryMsOpen,
                    hours_delivery_mon_sat_close: hDeliveryMsClose,
                    hours_delivery_sun_open: hDeliverySunOpen,
                    hours_delivery_sun_close: hDeliverySunClose,
                  },
                },
                "Hours saved — the website now uses the new hours."
              )
            }
          >
            Save hours
          </button>
          <p className="ops-muted">
            Denver time. The hours shown on the website and the “pickup for later” choices
            follow these times.
          </p>
        </section>
        <section className="ops-card">
          <h3>Service fee</h3>
          <div className="ops-field">
            <label>
              <input
                type="checkbox"
                checked={sfEnabled}
                onChange={(e) => setSfEnabled(e.target.checked)}
              />{" "}
              Charge a service fee on every order (pickup and delivery)
            </label>
          </div>
          <div className="ops-field">
            <label>Fee type</label>
            <div className="ops-btn-row">
              <button
                type="button"
                className={`ops-btn${sfType === "percent" ? " primary" : ""}`}
                onClick={() => setSfType("percent")}
              >
                Percent of food subtotal
              </button>
              <button
                type="button"
                className={`ops-btn${sfType === "flat" ? " primary" : ""}`}
                onClick={() => setSfType("flat")}
              >
                Flat $ per order
              </button>
            </div>
          </div>
          {sfType === "percent" ? (
            <div className="ops-field">
              <label htmlFor="sf-percent">Service fee — % of the food subtotal</label>
              <input
                id="sf-percent"
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={sfPercent}
                onChange={(e) => setSfPercent(e.target.value)}
              />
            </div>
          ) : (
            <div className="ops-field">
              <label htmlFor="sf-flat">Service fee — flat $ per order</label>
              <input
                id="sf-flat"
                type="number"
                min="0"
                step="0.25"
                value={sfFlat}
                onChange={(e) => setSfFlat(e.target.value)}
              />
            </div>
          )}
          <button
            type="button"
            className="ops-btn primary"
            disabled={busy}
            onClick={() =>
              act(
                {
                  action: "set_service_fee",
                  enabled: sfEnabled,
                  type: sfType,
                  percent: Math.min(100, Math.max(0, Number(sfPercent) || 0)),
                  flat_cents: Math.max(0, Math.round(Number(sfFlat) * 100) || 0),
                },
                "Service fee settings saved — new orders now use them."
              )
            }
          >
            Save service fee
          </button>
          <p className="ops-muted">
            The service fee appears as its own “Service fee” line next to the tax in
            every total. It is not taxed, and the Free Delivery promotion never
            removes it. It applies to new orders only.
          </p>
        </section>
        <section className="ops-card">
          <h3>Delivery — DoorDash Drive</h3>
          <div className="ops-field">
            <label htmlFor="dl-max-miles">Delivery radius (miles, max 15)</label>
            <input
              id="dl-max-miles"
              type="number"
              min="1"
              max="15"
              step="0.5"
              value={dlMaxMiles}
              onChange={(e) => setDlMaxMiles(e.target.value)}
            />
          </div>
          <div className="ops-field">
            <label htmlFor="dl-min-subtotal">Minimum food subtotal for delivery ($, 0 = off)</label>
            <input
              id="dl-min-subtotal"
              type="number"
              min="0"
              step="1"
              value={dlMinSubtotal}
              onChange={(e) => setDlMinSubtotal(e.target.value)}
            />
          </div>
          <div className="ops-field">
            <label htmlFor="dl-markup-flat">Extra service fee — flat ($, 0 = off)</label>
            <input
              id="dl-markup-flat"
              type="number"
              min="0"
              step="0.25"
              value={dlMarkupFlat}
              onChange={(e) => setDlMarkupFlat(e.target.value)}
            />
          </div>
          <div className="ops-field">
            <label htmlFor="dl-markup-percent">Extra service fee — % of the DoorDash fee (0 = off)</label>
            <input
              id="dl-markup-percent"
              type="number"
              min="0"
              max="100"
              step="1"
              value={dlMarkupPercent}
              onChange={(e) => setDlMarkupPercent(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="ops-btn primary"
            disabled={busy}
            onClick={() =>
              act(
                {
                  action: "set_delivery_settings",
                  max_miles: Number(dlMaxMiles),
                  min_subtotal_cents: Math.max(0, Math.round(Number(dlMinSubtotal) * 100) || 0),
                  markup_flat_cents: Math.max(0, Math.round(Number(dlMarkupFlat) * 100) || 0),
                  markup_percent: Math.min(100, Math.max(0, Number(dlMarkupPercent) || 0)),
                },
                "Delivery settings saved — new quotes now use them."
              )
            }
          >
            Save delivery settings
          </button>
          <p className="ops-muted">
            The customer sees ONE “Delivery fee” line: the DoorDash fee plus this
            extra fee combined. The split stays visible in each order's details
            here in the panel. It applies to new quotes; orders already placed
            keep the fee they were charged.
          </p>
        </section>
        <section className="ops-card">
          <h3>Free delivery promotion</h3>
          <div className="ops-field">
            <label>
              <input
                type="checkbox"
                checked={fdEnabled}
                onChange={(e) => setFdEnabled(e.target.checked)}
              />{" "}
              Offer free delivery on bigger delivery orders
            </label>
          </div>
          <div className="ops-field">
            <label htmlFor="fd-threshold">Free delivery when the food total reaches ($)</label>
            <input
              id="fd-threshold"
              type="number"
              min="0"
              step="1"
              value={fdThreshold}
              onChange={(e) => setFdThreshold(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="ops-btn primary"
            disabled={busy}
            onClick={() =>
              act(
                {
                  action: "set_free_delivery",
                  enabled: fdEnabled,
                  threshold_cents: Math.max(0, Math.round(Number(fdThreshold) * 100) || 0),
                },
                "Free delivery promotion saved — new orders now use it."
              )
            }
          >
            Save free delivery
          </button>
          <p className="ops-muted">
            Delivery orders at or above this food total pay $0 for delivery — the
            checkout shows “FREE”. The courier is still dispatched and the
            restaurant absorbs the DoorDash fee; each order's details here show
            the absorbed amount. The service fee (if on) is still charged.
            Pickup orders are not affected.
          </p>
        </section>
        <section className="ops-card">
          <h3>Homepage promotions</h3>
          <div className="ops-field">
            <label htmlFor="pr-title">Title</label>
            <input
              id="pr-title"
              value={promoTitle}
              onChange={(e) => setPromoTitle(e.target.value)}
              placeholder="e.g. This week's special"
            />
          </div>
          <div className="ops-field">
            <label htmlFor="pr-body">Text</label>
            <input
              id="pr-body"
              value={promoBody}
              onChange={(e) => setPromoBody(e.target.value)}
              placeholder="e.g. Free drink with any kabob platter!"
            />
          </div>
          <div className="ops-field">
            <label htmlFor="pr-item">Featured dish (optional — its photo shows in the box)</label>
            <select id="pr-item" value={promoItemId} onChange={(e) => setPromoItemId(e.target.value)}>
              <option value="">No dish — text only</option>
              {state.menu.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {formatCents(item.price_cents)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="ops-btn primary"
            disabled={busy || !promoTitle.trim()}
            onClick={async () => {
              await act(
                {
                  action: "promo_create",
                  title: promoTitle,
                  body: promoBody,
                  item_id: promoItemId || undefined,
                },
                "Promotion added — it is live on the homepage."
              );
              setPromoTitle("");
              setPromoBody("");
              setPromoItemId("");
            }}
          >
            Add promotion
          </button>
          {state.promotions.map((p) => (
            <div className="cart-line" key={p.id}>
              <span>
                {p.active ? "🟢" : "⚪"} <strong>{p.title}</strong>
                {p.body ? ` — ${p.body}` : ""}
                {p.item_id
                  ? ` · ${state.menu.items.find((i) => i.id === p.item_id)?.name ?? p.item_id}`
                  : ""}
              </span>
              <span className="ops-btn-row">
                <button
                  type="button"
                  className="ops-btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: "promo_set_active", id: p.id, active: !p.active },
                      p.active ? "Promotion hidden." : "Promotion is live."
                    )
                  }
                >
                  {p.active ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  className="ops-btn danger"
                  disabled={busy}
                  onClick={() => act({ action: "promo_delete", id: p.id }, "Promotion deleted.")}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
          {state.promotions.length === 0 && (
            <p className="ops-muted">No promotions yet — the homepage box stays hidden.</p>
          )}
        </section>
      </>
    );
  }

  function renderReports() {
    if (!reports) return <p className="ops-muted">Loading reports…</p>;
    return (
      <>
        <section className="ops-card">
          <h3>Last 30 days</h3>
          <p className="ops-muted">Cancelled orders are excluded. Revenue counts paid orders only.</p>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Orders</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {[...reports.days].reverse().map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="num">{d.orders}</td>
                    <td className="num">{formatCents(d.revenue_cents)}</td>
                  </tr>
                ))}
                <tr className="ops-total-row">
                  <td>Total</td>
                  <td className="num">{reports.totals.orders}</td>
                  <td className="num">{formatCents(reports.totals.revenue_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section className="ops-card">
          <h3>Top dishes (last 30 days)</h3>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th>Quantity</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {reports.top_dishes.map((d) => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td className="num">{d.qty}</td>
                    <td className="num">{formatCents(d.revenue_cents)}</td>
                  </tr>
                ))}
                {reports.top_dishes.length === 0 && (
                  <tr>
                    <td colSpan={3} className="ops-muted">No dishes sold in this period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  function renderStaff() {
    if (!staffData) return <p className="ops-muted">Loading staff…</p>;
    return (
      <section className="ops-card">
        <h3>Accounts</h3>
        <p className="ops-muted">
          Read-only. Roles are managed in Supabase (Authentication → Users and the profiles
          table). Only accounts with the staff role can open this panel and the kitchen.
        </p>
        {!staffData.emails_available && (
          <div className="fee-msg err">
            Email addresses could not be loaded from Supabase Auth — showing account ids
            and roles only.
          </div>
        )}
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Phone</th>
                <th>Joined</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {staffData.people.map((p) => (
                <tr key={p.id}>
                  <td>{p.email ?? <span className="ops-muted">{p.id.slice(0, 8)}…</span>}</td>
                  <td>{p.display_name ?? "—"}</td>
                  <td>
                    <span className={`ops-chip${p.role === "staff" ? " strong" : ""}`}>{p.role}</span>
                  </td>
                  <td>{p.phone ?? "—"}</td>
                  <td>{fmtTime(p.created_at)}</td>
                  <td>{p.last_sign_in_at ? fmtTime(p.last_sign_in_at) : "—"}</td>
                </tr>
              ))}
              {staffData.people.length === 0 && (
                <tr>
                  <td colSpan={6} className="ops-muted">No accounts found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderAudit() {
    if (!auditData) return <p className="ops-muted">Loading audit log…</p>;
    if (!auditData.available) {
      return (
        <section className="ops-card">
          <h3>Audit log</h3>
          <p>
            The audit table does not exist yet. Run{" "}
            <code>supabase/admin-panel-schema.sql</code> in the Supabase SQL Editor, then
            reopen this section. Admin changes are still being made — they are simply not
            recorded until the table exists.
          </p>
        </section>
      );
    }
    return (
      <section className="ops-card">
        <h3>Audit log — latest 100</h3>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {auditData.entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.created_at)}</td>
                  <td>{e.actor ?? "—"}</td>
                  <td>{e.action}</td>
                  <td>
                    <code className="ops-detail-json">{JSON.stringify(e.detail)}</code>
                  </td>
                </tr>
              ))}
              {auditData.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="ops-muted">No admin actions recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderSecurity() {
    const user = session?.user;
    return (
      <>
        <section className="ops-card">
          <h3>Signed in as</h3>
          <div className="ops-detail-grid">
            <span>Email</span>
            <strong>{user?.email ?? "—"}</strong>
            <span>Account id</span>
            <strong className="ops-mono">{user?.id ?? "—"}</strong>
            <span>Role</span>
            <strong>staff</strong>
          </div>
          <div className="ops-btn-row">
            <button
              type="button"
              className="ops-btn"
              disabled={busy}
              onClick={async () => {
                const supabase = getBrowserClient();
                if (!supabase || !user?.email) return;
                setBusy(true);
                setMsg("");
                const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
                  redirectTo: `${window.location.origin}/admin`,
                });
                setMsg(
                  error
                    ? "Could not send the recovery email."
                    : `Password recovery email sent to ${user.email}.`
                );
                setBusy(false);
              }}
            >
              Send password recovery email
            </button>
            <button type="button" className="ops-btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        </section>
        <section className="ops-card">
          <h3>Access & status</h3>
          <ul className="ops-notes">
            <li>
              This panel and the kitchen APIs accept only signed-in accounts whose profile
              role is <strong>staff</strong> (checked on the server for every request).
              Customer accounts can never open them.
            </li>
            <li>
              All admin data moves through server routes using the service-role key; the
              database tables themselves stay closed to the public (RLS on, no public
              policies).
            </li>
            {security ? (
              <>
                <li>
                  Payments:{" "}
                  {security.test_mode ? (
                    <strong className="ops-status-off">
                      TEST MODE — no Stripe key is set, so orders are marked test-paid and
                      no card is charged.
                    </strong>
                  ) : (
                    <strong className="ops-status-on">LIVE — Stripe is configured.</strong>
                  )}
                </li>
                <li>
                  TV board test mode: {security.board_test_mode ? "ON" : "OFF"} ·
                  Database: {security.supabase_configured ? "configured" : "not configured"}
                </li>
                <li>
                  DoorDash Drive delivery:{" "}
                  {security.doordash_mode === "live" ? (
                    <strong className="ops-status-on">
                      LIVE — real DoorDash credentials are configured.
                    </strong>
                  ) : (
                    <strong className="ops-status-off">
                      MOCK — no DoorDash credentials yet. Quotes use DoorDash's published
                      rate card and deliveries are simulated; the panel labels them MOCK.
                    </strong>
                  )}{" "}
                  Webhook secret:{" "}
                  {security.doordash_webhook_secret_configured ? "set" : "not set"}
                </li>
                <li>
                  Twilio SMS:{" "}
                  {security.twilio_configured
                    ? "configured — customers get order texts."
                    : "not configured — customer text messages are skipped."}
                </li>
              </>
            ) : (
              <li>Loading server status…</li>
            )}
          </ul>
        </section>
      </>
    );
  }

  // ---- shell -------------------------------------------------------------------

  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <div className="ops-brand">
          <strong>
            Madinah <span className="gold">Market</span>
          </strong>
          <small>Operations</small>
        </div>
        <nav className="ops-nav">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="ops-eyebrow">{group.group}</div>
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-current={section === item ? "page" : undefined}
                  onClick={() => setSection(item)}
                >
                  <Icon d={ICONS[item]} />
                  {item}
                  {item === "Orders" && newOrderCount > 0 && (
                    <span className="ops-count">{newOrderCount}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <footer className="ops-sidebar-footer">
          <div>3126 S Parker Rd, Aurora, CO 80014</div>
          <div className="ops-muted">{session.user.email}</div>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </footer>
      </aside>
      <div className="ops-workspace">
        <div className="ops-topbar">
          <div>
            <div className="ops-location">Madinah Market · Aurora, Colorado</div>
            <h1>{section}</h1>
          </div>
          <button
            type="button"
            className="ops-btn"
            disabled={busy}
            onClick={() => {
              setOverview(null);
              setOrders(null);
              setCatalog(null);
              setReports(null);
              setStaffData(null);
              setAuditData(null);
              setSecurity(null);
              if (session?.access_token) loadState(session.access_token);
            }}
          >
            Refresh
          </button>
        </div>
        {msg && <div className="fee-msg ok">{msg}</div>}
        {section === "Overview" && renderOverview()}
        {section === "Orders" && renderOrders()}
        {section === "Catalog" && renderCatalog()}
        {section === "Operations" && renderOperations()}
        {section === "Reports" && renderReports()}
        {section === "Staff" && renderStaff()}
        {section === "Audit log" && renderAudit()}
        {section === "Security" && renderSecurity()}
      </div>
    </div>
  );
}
