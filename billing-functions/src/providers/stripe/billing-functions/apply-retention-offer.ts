import { Stripe } from "../../../../deps.ts";

export type RETENTION_OFFER_RESULT = {
  applied: boolean;
  offer_variant: "trial_free_month" | "permanent_discount";
  current_period_end?: number;
};

// Step 2 of the offboarding flow. The SERVER decides which coupon based on
// trial status — the client never picks:
//   - trialing  → free-month coupon (100% off, duration once)
//   - paid      → permanent discount coupon (% off, duration forever)
// Idempotent: if a discount is already attached we don't stack another.
export async function applyRetentionOffer(
  stripeClient: Stripe.Client,
  { subscriptionId, trialCouponId, discountCouponId }: {
    subscriptionId: string;
    trialCouponId?: string;
    discountCouponId?: string;
  },
): Promise<RETENTION_OFFER_RESULT> {
  const sub = await stripeClient.subscriptions.retrieve(subscriptionId);

  const nowSec = Math.floor(Date.now() / 1000);
  const onTrial = sub.status === "trialing" ||
    (sub.trial_end != null && sub.trial_end > nowSec);
  const offerVariant = onTrial ? "trial_free_month" : "permanent_discount";
  const couponId = onTrial ? trialCouponId : discountCouponId;

  if (!couponId) {
    throw new Error(
      `Retention coupon not configured for offer "${offerVariant}"`,
    );
  }

  // Don't stack discounts — treat an already-discounted subscription as a no-op.
  if (sub.discount) {
    return {
      applied: false,
      offer_variant: offerVariant,
      current_period_end: sub.current_period_end,
    };
  }

  const updated = await stripeClient.subscriptions.update(subscriptionId, {
    coupon: couponId,
  });

  return {
    applied: true,
    offer_variant: offerVariant,
    current_period_end: updated.current_period_end,
  };
}
