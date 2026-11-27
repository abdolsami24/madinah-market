// Restaurant hours (America/Denver) — set by Sami, 2026-11-16.
//   Pickup:   Mon–Sat 10:00 AM – 7:45 PM · Sun 10:00 AM – 6:45 PM
//   Delivery: Mon–Sat 10:00 AM – 7:30 PM · Sun 10:00 AM – 6:30 PM
// Pure helpers (no server-only imports) so the browser and the API routes
// share exactly the same rules.

export const RESTAURANT_TZ = "America/Denver";

export interface DayWindow {
  open: number; // minutes from midnight, Denver time
  close: number;
}

const MON_SAT_PICKUP: DayWindow = { open: 10 * 60, close: 19 * 60 + 45 };
const SUN_PICKUP: DayWindow = { open: 10 * 60, close: 18 * 60 + 45 };
const MON_SAT_DELIVERY: DayWindow = { open: 10 * 60, close: 19 * 60 + 30 };
const SUN_DELIVERY: DayWindow = { open: 10 * 60, close: 18 * 60 + 30 };

/** Index 0 = Sunday … 6 = Saturday (same as Date.getDay). */
export const PICKUP_HOURS: DayWindow[] = [
  SUN_PICKUP,
  MON_SAT_PICKUP,
  MON_SAT_PICKUP,
  MON_SAT_PICKUP,
  MON_SAT_PICKUP,
  MON_SAT_PICKUP,
  MON_SAT_PICKUP,
];
export const DELIVERY_HOURS: DayWindow[] = [
  SUN_DELIVERY,
  MON_SAT_DELIVERY,
  MON_SAT_DELIVERY,
  MON_SAT_DELIVERY,
  MON_SAT_DELIVERY,
  MON_SAT_DELIVERY,
  MON_SAT_DELIVERY,
];

/** The four editable windows (admin panel). Minutes from midnight. */
export interface HoursConfig {
  pickup_mon_sat: DayWindow;
  pickup_sun: DayWindow;
  delivery_mon_sat: DayWindow;
  delivery_sun: DayWindow;
}

export const DEFAULT_HOURS_CONFIG: HoursConfig = {
  pickup_mon_sat: MON_SAT_PICKUP,
  pickup_sun: SUN_PICKUP,
  delivery_mon_sat: MON_SAT_DELIVERY,
  delivery_sun: SUN_DELIVERY,
};

/** site_settings keys for the eight editable times. */
export const HOURS_SETTING_KEYS = [
  "hours_pickup_mon_sat_open",
  "hours_pickup_mon_sat_close",
  "hours_pickup_sun_open",
  "hours_pickup_sun_close",
  "hours_delivery_mon_sat_open",
  "hours_delivery_mon_sat_close",
  "hours_delivery_sun_open",
  "hours_delivery_sun_close",
] as const;

/** "HH:MM" -> minutes from midnight, or null when malformed. */
export function parseHHMM(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function windowFromMap(
  map: Record<string, unknown>,
  openKey: string,
  closeKey: string,
  fallback: DayWindow
): DayWindow {
  const open = parseHHMM(map[openKey]);
  const close = parseHHMM(map[closeKey]);
  if (open === null || close === null || open >= close) return fallback;
  return { open, close };
}

/**
 * Builds the hours config from raw site_settings values (jsonb strings
 * like "19:45"). Any missing or invalid window falls back to the
 * built-in default for that window.
 */
export function hoursConfigFromMap(map: Record<string, unknown>): HoursConfig {
  return {
    pickup_mon_sat: windowFromMap(
      map,
      "hours_pickup_mon_sat_open",
      "hours_pickup_mon_sat_close",
      DEFAULT_HOURS_CONFIG.pickup_mon_sat
    ),
    pickup_sun: windowFromMap(
      map,
      "hours_pickup_sun_open",
      "hours_pickup_sun_close",
      DEFAULT_HOURS_CONFIG.pickup_sun
    ),
    delivery_mon_sat: windowFromMap(
      map,
      "hours_delivery_mon_sat_open",
      "hours_delivery_mon_sat_close",
      DEFAULT_HOURS_CONFIG.delivery_mon_sat
    ),
    delivery_sun: windowFromMap(
      map,
      "hours_delivery_sun_open",
      "hours_delivery_sun_close",
      DEFAULT_HOURS_CONFIG.delivery_sun
    ),
  };
}

/** Expands a config into the 7-day arrays (index 0 = Sunday). */
export function pickupWindows(config: HoursConfig): DayWindow[] {
  return [
    config.pickup_sun,
    config.pickup_mon_sat,
    config.pickup_mon_sat,
    config.pickup_mon_sat,
    config.pickup_mon_sat,
    config.pickup_mon_sat,
    config.pickup_mon_sat,
  ];
}

export function deliveryWindows(config: HoursConfig): DayWindow[] {
  return [
    config.delivery_sun,
    config.delivery_mon_sat,
    config.delivery_mon_sat,
    config.delivery_mon_sat,
    config.delivery_mon_sat,
    config.delivery_mon_sat,
    config.delivery_mon_sat,
  ];
}

export function formatMinutes(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatWindow(w: DayWindow): string {
  return `${formatMinutes(w.open)} – ${formatMinutes(w.close)}`;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface DenverParts {
  dayIndex: number; // 0 = Sunday
  minutes: number; // minutes from midnight in Denver
  ymd: string; // YYYY-MM-DD in Denver
}

export function denverParts(date: Date): DenverParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESTAURANT_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return {
    dayIndex: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minutes: hour * 60 + Number(get("minute")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Today's pickup window in Denver (for hints and input min/max). */
export function pickupWindowToday(
  now = new Date(),
  config: HoursConfig = DEFAULT_HOURS_CONFIG
): DayWindow {
  return pickupWindows(config)[denverParts(now).dayIndex];
}

/**
 * The Denver calendar date `days` after today's Denver date (pure
 * calendar math on the YYYY-MM-DD — no DST traps). Only `ymd` and
 * `dayIndex` are meaningful in the result; `minutes` is 0.
 */
export function denverDatePlusDays(now: Date, days: number): DenverParts {
  const { ymd } = denverParts(now);
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dayIndex: dt.getUTCDay(),
    minutes: 0,
    ymd: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
  };
}

/** The pickup window for today (offset 0) or tomorrow (offset 1). */
export function pickupWindowOn(
  now = new Date(),
  config: HoursConfig = DEFAULT_HOURS_CONFIG,
  offsetDays = 0
): DayWindow {
  return pickupWindows(config)[denverDatePlusDays(now, offsetDays).dayIndex];
}

/** "HH:MM" (Denver wall time today) -> "10:00" style input value. */
export function minutesToInputValue(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Converts a Denver wall-clock time ("HH:MM") on the given Denver
 * calendar date ("YYYY-MM-DD") into an absolute ISO timestamp.
 */
export function denverTimeOnDateToISO(hhmm: string, ymd: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return null;
  const [y, mo, d] = ymd.split("-").map(Number);
  // Start with the wall time read as UTC, then correct by the real Denver
  // offset at that moment (two passes settle DST edges).
  let guess = Date.UTC(y, mo - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = denverParts(new Date(guess));
    const actual = p.minutes;
    const desired = hh * 60 + mm;
    if (p.ymd !== ymd) {
      guess += (desired - actual + 24 * 60) * 60000 * (p.ymd < ymd ? 1 : -1);
    } else if (actual !== desired) {
      guess += (desired - actual) * 60000;
    } else {
      break;
    }
  }
  return new Date(guess).toISOString();
}

/**
 * Converts a Denver wall-clock time ("HH:MM") on Denver's current date
 * into an absolute ISO timestamp.
 */
export function denverTimeTodayToISO(hhmm: string, now = new Date()): string | null {
  return denverTimeOnDateToISO(hhmm, denverParts(now).ymd);
}

/**
 * Validates a scheduled pickup time (spec: today or tomorrow — one day
 * ahead — inside the chosen day's pickup hours, at least ~10 minutes
 * from now). Returns an error message or null.
 */
export function validatePickupTime(
  iso: string,
  now = new Date(),
  config: HoursConfig = DEFAULT_HOURS_CONFIG
): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "Please choose a pickup time.";
  const want = denverParts(when);
  const today = denverParts(now);
  const tomorrow = denverDatePlusDays(now, 1);
  const dayLabel =
    want.ymd === today.ymd ? "today" : want.ymd === tomorrow.ymd ? "tomorrow" : null;
  if (!dayLabel) {
    return "Scheduled pickup can be today or tomorrow only — please pick a time today or tomorrow.";
  }
  if (when.getTime() < now.getTime() + 10 * 60000) {
    return "Please pick a pickup time at least 10 minutes from now.";
  }
  const win = pickupWindows(config)[want.dayIndex];
  if (want.minutes < win.open || want.minutes > win.close) {
    return `Pickup hours ${dayLabel} are ${formatWindow(win)} — please pick a time inside them.`;
  }
  return null;
}

/** "⏰ Pickup at 3:30 PM" style label for kitchen cards and tickets. */
export function formatDenverTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: RESTAURANT_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * True when the scheduled Denver date is the day AFTER the order's own
 * Denver creation date — i.e. the order was placed for "tomorrow".
 * Ticket composers key off this (not off the print moment) so a ticket
 * reprinted on the pickup morning still says the same thing it said
 * when the order was placed.
 */
export function isNextDaySchedule(scheduledIso: string, createdIso: string): boolean {
  const created = new Date(createdIso);
  if (Number.isNaN(created.getTime())) return false;
  return denverParts(new Date(scheduledIso)).ymd === denverDatePlusDays(created, 1).ymd;
}

/**
 * The ⏰ banner for the kitchen screens, relative to NOW: an order whose
 * pickup falls on tomorrow's Denver date reads "⏰ TOMORROW — pickup
 * 11:00 AM"; anything else keeps the plain "⏰ PICKUP AT 7:28 PM".
 */
export function kitchenScheduledLabel(iso: string, now = new Date()): string {
  const time = formatDenverTime(iso);
  if (denverParts(new Date(iso)).ymd === denverDatePlusDays(now, 1).ymd) {
    return `⏰ TOMORROW — pickup ${time}`;
  }
  return `⏰ PICKUP AT ${time}`;
}

/**
 * Customer-facing scheduled-pickup label: "Today at 7:28 PM",
 * "Tomorrow, Fri Nov 27 · 11:00 AM", or "Fri, Dec 5 · 11:00 AM" for
 * anything further out (defensive — validation only allows +1 day).
 */
export function formatPickupWhenLabel(iso: string, now = new Date()): string {
  const when = new Date(iso);
  const time = formatDenverTime(iso);
  if (denverParts(when).ymd === denverParts(now).ymd) return `Today at ${time}`;
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: RESTAURANT_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(when);
  if (denverParts(when).ymd === denverDatePlusDays(now, 1).ymd) {
    return `Tomorrow, ${dateLabel} · ${time}`;
  }
  return `${dateLabel} · ${time}`;
}
