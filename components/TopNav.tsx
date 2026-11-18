"use client";

// Shared top bar + main navigation for the customer pages (Home, Menu,
// Deals, Rewards, Visit, Account). Hidden on the staff screens
// (/kitchen, /display) which are full-screen boards of their own.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CART_EVENT, loadCart, cartItemCount } from "@/lib/cartClient";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/menu", label: "Menu" },
  { href: "/deals", label: "Deals" },
  { href: "/rewards", label: "Rewards" },
  { href: "/visit", label: "Visit" },
  { href: "/account", label: "Account" },
];

export default function TopNav() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () => setCount(cartItemCount(loadCart()));
    update();
    window.addEventListener(CART_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CART_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [pathname]);

  if (pathname?.startsWith("/kitchen") || pathname?.startsWith("/display")) {
    return null;
  }

  return (
    <>
      <div className="topbar">
        <span>📍 3126 S Parker Rd, Aurora, CO 80014</span>
        <a href="tel:+17207630786">📞 720-763-0786</a>
        <span>🕙 Mon–Thu 10–7:50 · Fri–Sat 10–8 · Sun 10–7</span>
      </div>
      <header className="site-header compact">
        <Link href="/" className="brand">
          <h1>
            Madinah <span className="gold">Bakery &amp; Kabob</span>
          </h1>
          <p>Aurora, Colorado · 100% halal</p>
        </Link>
        <span className="halal-badge">100% HALAL</span>
        <nav className="main-nav" aria-label="Main">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={pathname === l.href ? "active" : ""}
            >
              {l.label}
            </Link>
          ))}
          <Link href="/track">Track order</Link>
          <Link href="/menu" className="nav-cart">
            🛒 Cart{count > 0 ? ` (${count})` : ""}
          </Link>
        </nav>
      </header>
    </>
  );
}
