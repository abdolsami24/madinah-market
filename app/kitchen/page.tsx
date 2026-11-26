import KitchenHome from "@/components/KitchenHome";

export const dynamic = "force-dynamic";

export default function KitchenPage() {
  const testMode = !process.env.STRIPE_SECRET_KEY;
  return <KitchenHome testMode={testMode} />;
}
