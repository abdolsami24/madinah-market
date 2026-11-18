"use client";

// Rewards page: explains the loyalty program and, for signed-in
// customers, shows the live balance and recent history from
// /api/account/me (the same data the account page uses).

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/client";

interface PointsRow {
  id?: number;
  delta: number;
  reason: string;
  created_at: string;
}

export default function RewardsPanel() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "guest" }
    | { kind: "member"; balance: number; history: PointsRow[] }
  >({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const client = getBrowserClient();
        if (!client) return setState({ kind: "guest" });
        const { data } = await client.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return setState({ kind: "guest" });
        const res = await fetch("/api/account/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return setState({ kind: "guest" });
        const me = await res.json();
        if (me.points && typeof me.points.balance === "number") {
          setState({
            kind: "member",
            balance: me.points.balance,
            history: (me.points.history ?? []) as PointsRow[],
          });
        } else {
          setState({ kind: "member", balance: 0, history: [] });
        }
      } catch {
        setState({ kind: "guest" });
      }
    })();
  }, []);

  return (
    <main className="wrap">
      <h2 className="category-title">⭐ Madinah Rewards</h2>
      <div className="panel">
        <h3>How it works</h3>
        <ul className="rewards-rules">
          <li>
            <strong>Earn 1 point for every $1</strong> you pay on an order (paid orders only).
          </li>
          <li>
            <strong>100 points = $5.00 off</strong> — use whole 100-point blocks at checkout;
            the discount comes off before tax.
          </li>
          <li>
            Points are for <strong>signed-in customers</strong> — guest orders don’t earn
            points, so create a free account before you order.
          </li>
          <li>Your balance is checked on our server at checkout — simple and safe.</li>
        </ul>

        {state.kind === "loading" && <p>Checking your balance…</p>}

        {state.kind === "guest" && (
          <div className="auth-box">
            <p>
              👋 You’re browsing as a guest.{" "}
              <Link href="/account">Sign in or create an account</Link> to see your points
              and start earning.
            </p>
          </div>
        )}

        {state.kind === "member" && (
          <div className="auth-box">
            <p>
              ⭐ Your balance: <strong>{state.balance} points</strong>
              {state.balance >= 100
                ? ` — you have $${(Math.floor(state.balance / 100) * 5).toFixed(2)} off waiting for your next order!`
                : ` — earn ${100 - state.balance} more for $5.00 off.`}
            </p>
            {state.history.length > 0 && (
              <ul className="points-history">
                {state.history.slice(0, 10).map((h, i) => (
                  <li key={h.id ?? i}>
                    <span>
                      {h.delta > 0 ? "+" : ""}
                      {h.delta} pts · {h.reason}
                    </span>
                    <span>{new Date(h.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <p>
              <Link href="/menu">Order and earn more →</Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
