import Link from "next/link";
import { getDbMenu } from "@/lib/menuDb";
import { getDishPhotos, getHoursConfig, listPromotions } from "@/lib/admin";
import { formatCents, type MenuItem } from "@/lib/menu";
import {
  pickupWindows,
  deliveryWindows,
  formatWindow,
} from "@/lib/hours";

// Home page, modeled on madinah.boyscoding.com: hero, "How would you
// like it?", Guest favorites, Popular right now, promotions, Visit us.
export const dynamic = "force-dynamic";

// Hand-picked sections (ids from lib/menu.ts).
const GUEST_FAVORITES = ["kobideh-kabob", "lamb-gyro-rice", "chicken-shawarma-sandwich", "falafel-platter"];
const POPULAR_NOW = ["combo-platter", "sultani-kabob", "lamb-shank", "chicken-tikka-kabob"];

export default async function HomePage() {
  const [menu, photos, hours, promos] = await Promise.all([
    getDbMenu(),
    getDishPhotos(),
    getHoursConfig(),
    listPromotions(true),
  ]);
  const byId = Object.fromEntries(menu.items.map((m) => [m.id, m]));
  const pickupWins = pickupWindows(hours);
  const deliveryWins = deliveryWindows(hours);
  const testMode = !process.env.STRIPE_SECRET_KEY;

  function dishCard(m: MenuItem) {
    return (
      <Link href="/menu" className="card home-card" key={m.id}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photos[m.id] ?? m.image} alt={m.name} loading="lazy" />
        <div className="card-body">
          <h3>
            {m.number && <span className="num">{m.number}</span>}
            {m.name}
          </h3>
          <p>{m.description}</p>
          <div className="price-row">
            <span className="price">{formatCents(m.price_cents)}</span>
            <span className="add-btn">Order →</span>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <>
      {testMode && (
        <div className="testmode-banner">
          TEST MODE — no real payment is taken. Orders are marked “test paid”.
        </div>
      )}

      <div className="hero">
        <p className="hero-kicker">Aurora, Colorado · 100% halal</p>
        <h2>Fire-grilled kabobs, fresh bread and saffron rice.</h2>
        <p>Order online for pickup. Made to order in our kitchen on South Parker Road.</p>
        <Link href="/menu" className="hero-cta">
          See the full menu →
        </Link>
      </div>

      <main className="wrap">
        {promos.map((p) => {
          const dish = p.item_id ? byId[p.item_id] : null;
          return (
            <div className="promo-box" key={p.id}>
              {dish && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photos[dish.id] ?? dish.image} alt={dish.name} />
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

        <section className="home-section">
          <h2 className="category-title">How would you like it?</h2>
          <div className="how-grid">
            <Link href="/menu" className="how-card">
              <span className="how-icon">🏃</span>
              <strong>Pickup</strong>
              <span>Order ahead — ready when you arrive. Pay online or at the counter.</span>
            </Link>
            <Link href="/menu" className="how-card">
              <span className="how-icon">🛵</span>
              <strong>Delivery</strong>
              <span>Hot and fresh to your door within about 4 miles of the restaurant.</span>
            </Link>
            <Link href="/rewards" className="how-card">
              <span className="how-icon">⭐</span>
              <strong>Rewards</strong>
              <span>Earn 1 point per $1 on paid orders — 100 points = $5.00 off.</span>
            </Link>
          </div>
        </section>

        <section className="home-section">
          <h2 className="category-title">Guest favorites</h2>
          <div className="menu-grid">
            {GUEST_FAVORITES.map((id) => byId[id]).filter(Boolean).map(dishCard)}
          </div>
        </section>

        <section className="home-section">
          <h2 className="category-title">Popular right now</h2>
          <div className="menu-grid">
            {POPULAR_NOW.map((id) => byId[id]).filter(Boolean).map(dishCard)}
          </div>
          <p className="home-more">
            <Link href="/menu">Full menu →</Link>
          </p>
        </section>

        <section className="home-section visit-box">
          <h2 className="category-title">Visit us</h2>
          <p>
            <strong>Madinah Bakery &amp; Kabob</strong>
            <br />
            3126 S Parker Rd, Aurora, CO 80014
            <br />
            <a href="tel:+17207630786">📞 720-763-0786</a>
            {" · "}
            <a
              href="https://www.google.com/maps/search/?api=1&query=3126+S+Parker+Rd+Aurora+CO+80014"
              target="_blank"
              rel="noreferrer"
            >
              Get directions →
            </a>
          </p>
          <h3>Opening hours</h3>
          <p>
            🏃 Pickup: Mon–Sat {formatWindow(pickupWins[1])} · Sun {formatWindow(pickupWins[0])}
            <br />
            🛵 Delivery: Mon–Sat {formatWindow(deliveryWins[1])} · Sun {formatWindow(deliveryWins[0])}
          </p>
        </section>
      </main>

      <footer className="site-footer">
        Madinah Bakery &amp; Kabob · 3126 S Parker Rd, Aurora, CO 80014 ·{" "}
        <a href="tel:+17207630786">720-763-0786</a>
        <br />
        Aurora, Colorado · 100% Halal · Kabob, Turkish, Afghan Persian &amp; Middle Eastern
      </footer>
    </>
  );
}
