"use client";

// /kitchen shell: chooses between the LIST view (default since
// 2026-11-26 — the owner's GloriaFood-style orders list) and the
// original card BOARD. The toggle lives in each view's header; this
// wrapper only holds the choice and persists it in localStorage
// ("madinah_kitchen_view", same pattern as the alerts/auto-print
// toggles) so the tablet comes back to the face staff left it on.
// Each view keeps its own auth + feed, exactly as the board always
// has — switching remounts the other view, like a page reload.

import { useEffect, useState } from "react";
import KitchenBoard from "@/components/KitchenBoard";
import KitchenList from "@/components/KitchenList";

export default function KitchenHome({ testMode }: { testMode: boolean }) {
  const [view, setView] = useState<"list" | "board">("list");

  useEffect(() => {
    if (localStorage.getItem("madinah_kitchen_view") === "board") {
      setView("board");
    }
  }, []);

  function switchView() {
    setView((prev) => {
      const next = prev === "list" ? "board" : "list";
      localStorage.setItem("madinah_kitchen_view", next);
      return next;
    });
  }

  return view === "list" ? (
    <KitchenList testMode={testMode} view="list" onSwitchView={switchView} />
  ) : (
    <KitchenBoard testMode={testMode} view="board" onSwitchView={switchView} />
  );
}
