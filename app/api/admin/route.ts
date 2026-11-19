// /api/admin — admin-controlled site state.
// GET  (no login): public view — settings, sold-out dish ids, ACTIVE
//      promotions. The storefront reads this on load.
// GET  (staff token): full view — also inactive promotions.
// POST (staff token only): actions —
//      { action: "set_setting", key, value }
//      { action: "set_availability", item_id, available }
//      { action: "promo_create", title, body }
//      { action: "promo_set_active", id, active }
//      { action: "promo_delete", id }
// POST returns the refreshed full state.

import { NextResponse } from "next/server";
import { supabaseConfigured, verifyKitchenUser } from "@/lib/supabase/server";
import {
  getSettings,
  setSetting,
  isSettingKey,
  getUnavailableIds,
  setDishAvailability,
  listPromotions,
  createPromotion,
  setPromotionActive,
  deletePromotion,
  getDishPhotos,
  uploadDishPhoto,
  addCategory,
  addMenuItem,
  getHoursConfig,
  setHoursConfig,
} from "@/lib/admin";
import { HOURS_SETTING_KEYS, parseHHMM } from "@/lib/hours";
import { getMenuItem } from "@/lib/menu";
import { getDbMenu } from "@/lib/menuDb";
import { logAudit } from "@/lib/audit";
import { getDeliverySettings, setDeliverySettings } from "@/lib/delivery";
import {
  getFeeSettings,
  setFreeDeliverySettings,
  setServiceFeeSettings,
} from "@/lib/fees";

export const dynamic = "force-dynamic";

async function staffState() {
  const [settings, unavailable, promotions, photos, menu, hours, delivery, fees] =
    await Promise.all([
      getSettings(),
      getUnavailableIds(),
      listPromotions(false),
      getDishPhotos(),
      getDbMenu(),
      getHoursConfig(),
      getDeliverySettings(),
      getFeeSettings(),
    ]);
  return {
    settings,
    unavailable: [...unavailable],
    promotions,
    photos,
    hours,
    // Stage 3 delivery settings (staff view only — the public GET
    // shape below is unchanged).
    delivery: {
      max_miles: delivery.max_miles,
      min_subtotal_cents: delivery.min_subtotal_cents,
      markup_flat_cents: delivery.markup_flat_cents,
      markup_percent: delivery.markup_percent,
    },
    // Service Fee + Free Delivery settings (staff view only, same
    // reasoning as the delivery settings above).
    fees: {
      service_fee: fees.service_fee,
      free_delivery: fees.free_delivery,
    },
    menu: { categories: menu.categories, items: menu.items },
  };
}

export async function GET(req: Request) {
  const [settings, unavailable, activePromos, photos, hours] = await Promise.all([
    getSettings(),
    getUnavailableIds(),
    listPromotions(true),
    getDishPhotos(),
    getHoursConfig(),
  ]);
  const publicState = {
    settings,
    hours,
    unavailable: [...unavailable],
    promotions: activePromos.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.body,
      item_id: p.item_id ?? null,
    })),
    photos,
  };
  // A valid staff token upgrades the response to the full admin view.
  if (supabaseConfigured()) {
    const user = await verifyKitchenUser(req).catch(() => null);
    if (user) {
      const full = await staffState();
      return NextResponse.json({ ...full, staff: true });
    }
  }
  return NextResponse.json(publicState);
}

export async function POST(req: Request) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  const user = await verifyKitchenUser(req);
  if (!user) {
    return NextResponse.json({ error: "Staff login required." }, { status: 401 });
  }
  // Dish photo upload arrives as multipart form data.
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const itemId = String(form.get("item_id") ?? "");
      const file = form.get("file");
      if (!itemId || !(file instanceof File)) {
        return NextResponse.json({ error: "Missing dish or file." }, { status: 400 });
      }
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        return NextResponse.json(
          { error: "Please choose a JPG, PNG or WebP image." },
          { status: 400 }
        );
      }
      if (file.size > 5 * 1024 * 1024) {
        return NextResponse.json({ error: "Image is too large (max 5 MB)." }, { status: 400 });
      }
      await uploadDishPhoto(itemId, await file.arrayBuffer(), file.type);
      await logAudit(user.email ?? user.id, "admin.photo_upload", { item_id: itemId });
    } catch (err) {
      console.error("[admin] photo upload failed:", err);
      return NextResponse.json({ error: "Photo upload failed." }, { status: 500 });
    }
    const full = await staffState();
    return NextResponse.json({ ...full, staff: true });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const actor = user.email ?? user.id;
  try {
    switch (body.action) {
      case "set_setting": {
        const key = String(body.key ?? "");
        if (!isSettingKey(key)) throw new Error("Unknown setting");
        await setSetting(key, body.value === true);
        await logAudit(actor, "admin.set_setting", { key, value: body.value === true });
        break;
      }
      case "set_hours": {
        const raw =
          body.hours && typeof body.hours === "object"
            ? (body.hours as Record<string, unknown>)
            : {};
        const values: Record<string, string> = {};
        for (const key of HOURS_SETTING_KEYS) {
          if (parseHHMM(raw[key]) === null) {
            throw new Error("Please fill in all eight opening and closing times.");
          }
          values[key] = String(raw[key]).trim();
        }
        const pairs: [string, string, string][] = [
          ["hours_pickup_mon_sat_open", "hours_pickup_mon_sat_close", "Pickup (Mon–Sat)"],
          ["hours_pickup_sun_open", "hours_pickup_sun_close", "Pickup (Sunday)"],
          ["hours_delivery_mon_sat_open", "hours_delivery_mon_sat_close", "Delivery (Mon–Sat)"],
          ["hours_delivery_sun_open", "hours_delivery_sun_close", "Delivery (Sunday)"],
        ];
        for (const [openKey, closeKey, label] of pairs) {
          if ((parseHHMM(values[openKey]) ?? 0) >= (parseHHMM(values[closeKey]) ?? 0)) {
            throw new Error(`${label}: closing time must be after opening time.`);
          }
        }
        await setHoursConfig(values);
        await logAudit(actor, "admin.set_hours", { ...values });
        break;
      }
      case "set_delivery_settings": {
        // Stage 3: DoorDash delivery radius cap, delivery minimum,
        // and the extra delivery markup (flat + percent).
        const max_miles = Number(body.max_miles);
        const min_subtotal_cents = Math.floor(Number(body.min_subtotal_cents));
        const markup_flat_cents = Math.floor(Number(body.markup_flat_cents));
        const markup_percent = Number(body.markup_percent);
        if (!Number.isFinite(max_miles) || max_miles < 1 || max_miles > 15) {
          throw new Error("Delivery radius must be between 1 and 15 miles.");
        }
        if (!Number.isFinite(min_subtotal_cents) || min_subtotal_cents < 0 || min_subtotal_cents > 100000) {
          throw new Error("Enter a valid delivery minimum (or 0 for off).");
        }
        if (!Number.isFinite(markup_flat_cents) || markup_flat_cents < 0 || markup_flat_cents > 10000) {
          throw new Error("Enter a valid flat service fee (or 0 for off).");
        }
        if (!Number.isFinite(markup_percent) || markup_percent < 0 || markup_percent > 100) {
          throw new Error("Service-fee percent must be between 0 and 100.");
        }
        await setDeliverySettings({
          max_miles,
          min_subtotal_cents,
          markup_flat_cents,
          markup_percent,
        });
        await logAudit(actor, "admin.set_delivery_settings", {
          max_miles,
          min_subtotal_cents,
          markup_flat_cents,
          markup_percent,
        });
        break;
      }
      case "set_service_fee": {
        // General Service Fee (Operations): on/off + percent-of-subtotal
        // OR flat per order. Applies to every order; never taxed.
        const enabled = body.enabled === true;
        const type = body.type === "flat" ? "flat" : "percent";
        const percent = Number(body.percent);
        const flat_cents = Math.floor(Number(body.flat_cents));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          throw new Error("Service-fee percent must be between 0 and 100.");
        }
        if (!Number.isFinite(flat_cents) || flat_cents < 0 || flat_cents > 100000) {
          throw new Error("Enter a valid flat service fee (or 0 for off).");
        }
        await setServiceFeeSettings({ enabled, type, percent, flat_cents });
        await logAudit(actor, "admin.set_service_fee", { enabled, type, percent, flat_cents });
        break;
      }
      case "set_free_delivery": {
        // Free Delivery promotion (Promotions section): on/off +
        // the food-subtotal amount at/above which delivery is $0.
        const enabled = body.enabled === true;
        const threshold_cents = Math.floor(Number(body.threshold_cents));
        if (!Number.isFinite(threshold_cents) || threshold_cents < 0 || threshold_cents > 1000000) {
          throw new Error("Enter a valid free-delivery amount (in dollars).");
        }
        if (enabled && threshold_cents <= 0) {
          throw new Error("Set the order amount for free delivery (e.g. $50).");
        }
        await setFreeDeliverySettings({ enabled, threshold_cents });
        await logAudit(actor, "admin.set_free_delivery", { enabled, threshold_cents });
        break;
      }
      case "set_availability": {
        const itemId = String(body.item_id ?? "");
        const menu = await getDbMenu();
        if (!menu.items.some((i) => i.id === itemId) && !getMenuItem(itemId)) {
          throw new Error("Unknown dish");
        }
        await setDishAvailability(itemId, body.available === true);
        await logAudit(actor, "admin.set_availability", {
          item_id: itemId,
          available: body.available === true,
        });
        break;
      }
      case "promo_create": {
        const title = String(body.title ?? "").trim().slice(0, 120);
        const text = String(body.body ?? "").trim().slice(0, 400);
        const itemId = String(body.item_id ?? "").trim();
        if (!title) throw new Error("A promotion needs a title");
        if (itemId) {
          const menu = await getDbMenu();
          if (!menu.items.some((i) => i.id === itemId)) {
            throw new Error("Unknown dish for the promotion");
          }
        }
        await createPromotion(title, text, itemId || null);
        await logAudit(actor, "admin.promo_create", { title, item_id: itemId || null });
        break;
      }
      case "promo_set_active": {
        await setPromotionActive(Math.floor(Number(body.id)), body.active === true);
        await logAudit(actor, "admin.promo_set_active", {
          id: Math.floor(Number(body.id)),
          active: body.active === true,
        });
        break;
      }
      case "promo_delete": {
        await deletePromotion(Math.floor(Number(body.id)));
        await logAudit(actor, "admin.promo_delete", { id: Math.floor(Number(body.id)) });
        break;
      }
      case "add_category": {
        const name = String(body.name ?? "").trim().slice(0, 60);
        if (!name) throw new Error("A category needs a name");
        await addCategory(name);
        await logAudit(actor, "admin.add_category", { name });
        break;
      }
      case "add_item": {
        const name = String(body.name ?? "").trim().slice(0, 80);
        const description = String(body.description ?? "").trim().slice(0, 300);
        const price_cents = Math.floor(Number(body.price_cents));
        const category = String(body.category ?? "").trim().slice(0, 60);
        const number = String(body.number ?? "").trim().slice(0, 10);
        const station = String(body.station ?? "").trim().slice(0, 40);
        if (!name) throw new Error("A dish needs a name");
        if (!category) throw new Error("Choose a category");
        if (!Number.isFinite(price_cents) || price_cents < 1 || price_cents > 100000) {
          throw new Error("Enter a valid price");
        }
        const newId = await addMenuItem({
          name,
          description,
          price_cents,
          category,
          number,
          station: station || undefined,
        });
        await logAudit(actor, "admin.add_item", {
          id: newId,
          name,
          category,
          price_cents,
          station: station || "main",
        });
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("[admin] action failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 400 }
    );
  }
  const full = await staffState();
  return NextResponse.json({ ...full, staff: true });
}
