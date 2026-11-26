"use client";

// Kitchen options menu (⋮) — shared by BOTH kitchen faces (List and
// Board headers render this exact component, so the menu can never
// drift between views). One item today, GloriaFood-style (owner's
// request, 2026-11-26):
//
//   🧹 Clear orders — asks first ("Remove all orders from this
//   screen? The orders stay in Admin and reports — nothing is
//   deleted."), then POSTs the ids of every order the feed just
//   returned to /api/kitchen/clear. The server stamps them
//   kitchen_status='cleared' and the feed stops returning them, so
//   the screen empties on every staff device and stays empty after
//   a reload. Orders placed afterwards arrive normally.
//
// Until supabase/kitchen-clear-schema.sql is run, the server answers
// with a friendly "not switched on yet" message, shown verbatim in
// the confirm dialog — nothing clears and nothing crashes.

import { useState } from "react";

export default function KitchenOptionsMenu({
  accessToken,
  orderIds,
  onCleared,
}: {
  accessToken: string;
  /** Ids of every order the parent view's feed currently holds. */
  orderIds: number[];
  /** Parent empties its local list + refetches after a clear. */
  onCleared: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doClear() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kitchen/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ order_ids: orderIds }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not clear the orders — try again.");
        return;
      }
      setConfirming(false);
      onCleared();
    } catch {
      setError("Could not reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="k-menu">
      <button
        type="button"
        className="k-btn k-menu-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Kitchen options"
        onClick={() => setMenuOpen((v) => !v)}
      >
        ⋮
      </button>
      {menuOpen && (
        <>
          <div className="k-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="k-menu-pop" role="menu" aria-label="Kitchen options">
            <button
              type="button"
              role="menuitem"
              className="k-menu-item"
              disabled={orderIds.length === 0}
              onClick={() => {
                setMenuOpen(false);
                setError(null);
                setConfirming(true);
              }}
            >
              🧹 Clear orders
            </button>
            {orderIds.length === 0 && (
              <div className="k-menu-note">No orders on screen</div>
            )}
          </div>
        </>
      )}
      {confirming && (
        <div className="k-confirm-backdrop">
          <div className="k-confirm" role="alertdialog" aria-label="Clear orders">
            <p className="k-confirm-title">Clear orders?</p>
            <p>
              Remove all orders from this screen? The orders stay in Admin
              and reports — nothing is deleted.
            </p>
            {error && <p className="k-confirm-err">{error}</p>}
            <div className="k-confirm-actions">
              <button
                type="button"
                className="k-btn"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="k-btn warn"
                disabled={busy}
                onClick={doClear}
              >
                {busy ? "Clearing…" : "Clear orders"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
