// Per-item additional options, copied exactly from the restaurant's
// existing online menu (GloriaFood / denverhalal.com) — see
// menu-import.json (format madinah-menu-import/v1) at the project root.
//
// Every group is optional and multi-select (checkboxes). A choice is
// identified by its (group name, choice name) pair; prices are integer
// cents added to the dish's base price. The server (lib/pricing.ts)
// re-validates every selection against this data — browser-sent prices
// for options are never trusted.

import menuImport from "../menu-import.json";

export interface OptionChoice {
  name: string;
  price_delta_cents: number;
}

export interface OptionGroup {
  name: string;
  choices: OptionChoice[];
}

/** A customer's chosen option, as stored on cart lines and orders. */
export interface SelectedOption {
  group: string;
  name: string;
  price_delta_cents: number;
}

interface ImportItem {
  id: string;
  option_groups?: { name: string; choices: OptionChoice[] }[];
}

const items = (menuImport as { items: ImportItem[] }).items ?? [];

/** Built-in option groups per menu item id (18 of the 36 dishes). */
export const OPTION_GROUPS_BY_ID: Record<string, OptionGroup[]> = {};
for (const it of items) {
  if (it.option_groups && it.option_groups.length > 0) {
    OPTION_GROUPS_BY_ID[it.id] = it.option_groups.map((g) => ({
      name: g.name,
      choices: g.choices.map((c) => ({
        name: c.name,
        price_delta_cents: c.price_delta_cents,
      })),
    }));
  }
}

/** Normalizes option groups coming from the database (jsonb). */
export function sanitizeOptionGroups(raw: unknown): OptionGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: OptionGroup[] = [];
  for (const g of raw as Record<string, unknown>[]) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.choices)) continue;
    const choices: OptionChoice[] = [];
    for (const c of g.choices as Record<string, unknown>[]) {
      if (!c || typeof c.name !== "string") continue;
      const delta = Math.floor(Number(c.price_delta_cents));
      choices.push({
        name: c.name,
        price_delta_cents: Number.isFinite(delta) ? delta : 0,
      });
    }
    if (choices.length > 0) groups.push({ name: g.name, choices });
  }
  return groups.length > 0 ? groups : undefined;
}

/**
 * Validates client-sent option selections against an item's trusted
 * option groups. Returns the trusted selections (with server prices),
 * or null when anything is unknown/duplicated — callers must reject.
 */
export function validateSelectedOptions(
  groups: OptionGroup[] | undefined,
  requested: unknown
): SelectedOption[] | null {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) return null;
  if (requested.length > 30) return null;
  const out: SelectedOption[] = [];
  const seen = new Set<string>();
  for (const raw of requested as Record<string, unknown>[]) {
    const group = String(raw?.group ?? "");
    const name = String(raw?.name ?? "");
    const key = `${group}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const g = (groups ?? []).find((x) => x.name === group);
    const choice = g?.choices.find((x) => x.name === name);
    if (!choice) return null;
    out.push({ group, name, price_delta_cents: choice.price_delta_cents });
  }
  return out;
}

/** Stable signature so identical option sets merge into one cart line. */
export function optionsSignature(options: SelectedOption[]): string {
  return options
    .map((o) => `${o.group}::${o.name}`)
    .sort()
    .join("|");
}
