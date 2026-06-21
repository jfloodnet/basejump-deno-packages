import { Stripe } from "../../../../deps.ts";

// Snapshot of the live subscription used to render the in-app offboarding flow.
// offer_variant decides Step 2 copy (trial → free month, paid → permanent
// discount) so the client never re-derives trial logic.
export type SUBSCRIPTION_SUMMARY = {
  status: string;
  trial_end: number | null;
  current_period_end: number;
  cancel_at_period_end: boolean;
  plan_name: string | null;
  amount: number;
  currency: string;
  interval: "month" | "year";
  has_discount: boolean;
  offer_variant: "trial_free_month" | "permanent_discount";
  discount_percent_off?: number;
};

export async function getSubscriptionSummary(
  stripeClient: Stripe.Client,
  { subscriptionId, discountCouponId }: {
    subscriptionId: string;
    discountCouponId?: string;
  },
): Promise<SUBSCRIPTION_SUMMARY> {
  const sub = await stripeClient.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price", "discount"],
  });

  const item = sub.items.data[0];
  const price = item?.price;
  const nowSec = Math.floor(Date.now() / 1000);
  // "On trial" = Stripe says trialing OR trial_end is still in the future.
  const onTrial = sub.status === "trialing" ||
    (sub.trial_end != null && sub.trial_end > nowSec);
  const offerVariant = onTrial ? "trial_free_month" : "permanent_discount";

  // Surface the configured discount's percent so the client can render the
  // "save X%" copy without hard-coding it. Best-effort — falls back on the
  // client if the coupon is missing/misconfigured.
  let discountPercentOff: number | undefined;
  if (offerVariant === "permanent_discount" && discountCouponId) {
    try {
      const coupon = await stripeClient.coupons.retrieve(discountCouponId);
      if (coupon?.percent_off) discountPercentOff = coupon.percent_off;
    } catch (_e) {
      // coupon not found — leave undefined
    }
  }

  return {
    status: sub.status,
    trial_end: sub.trial_end ?? null,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end,
    plan_name: item?.plan?.nickname ?? null,
    amount: price?.unit_amount ?? 0,
    currency: price?.currency ?? "aud",
    interval: (price?.recurring?.interval ?? "month") as "month" | "year",
    has_discount: !!sub.discount,
    offer_variant: offerVariant,
    discount_percent_off: discountPercentOff,
  };
}
