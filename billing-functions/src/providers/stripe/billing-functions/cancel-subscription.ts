import { Stripe } from "../../../../deps.ts";

export type CANCELLATION_RESULT = {
  canceled: boolean;
  current_period_end: number;
};

// Maps the offboarding flow's Step 1 reason keys to Stripe's
// cancellation_details.feedback enum so the reason shows in the Stripe
// dashboard / churn reporting.
const STRIPE_FEEDBACK_BY_REASON: Record<string, string> = {
  price: "too_expensive",
  usage: "unused",
  features: "missing_features",
  alt: "switched_service",
  break: "other",
  other: "other",
};

// Step 5 of the offboarding flow. Cancels at period end (access stays until
// the current period ends) and records the reason + free-text comment on the
// Stripe subscription.
export async function cancelSubscription(
  stripeClient: Stripe.Client,
  { subscriptionId, reason, note }: {
    subscriptionId: string;
    reason?: string;
    note?: string;
  },
): Promise<CANCELLATION_RESULT> {
  const feedback = reason ? STRIPE_FEEDBACK_BY_REASON[reason] : undefined;

  const cancellationDetails: Record<string, string> = {};
  if (feedback) cancellationDetails.feedback = feedback;
  // Stripe caps the comment at 500 chars.
  if (note) cancellationDetails.comment = note.slice(0, 500);

  const updated = await stripeClient.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
    ...(Object.keys(cancellationDetails).length > 0
      ? { cancellation_details: cancellationDetails }
      : {}),
  });

  return {
    canceled: true,
    current_period_end: updated.current_period_end,
  };
}
