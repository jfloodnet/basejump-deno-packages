import {BILLING_FUNCTION_WRAPPER_HANDLERS} from "../../billing-functions-wrapper.ts";
import getPlans from "./billing-functions/get-plans.ts";
import {findOrCreateCustomer} from "./billing-functions/find-or-create-customer.ts";
import {findOrCreateSubscription} from "./billing-functions/find-or-create-subscription.ts";
import {getSubscriptionSummary} from "./billing-functions/get-subscription-summary.ts";
import {applyRetentionOffer} from "./billing-functions/apply-retention-offer.ts";
import {cancelSubscription} from "./billing-functions/cancel-subscription.ts";
import {Stripe} from "../../../deps.ts";

type Props = {
    stripeClient: Stripe.Client;
    defaultTrialDays?: number;
    defaultPlanId?: string;
};

export function stripeFunctionHandler({
                                          stripeClient,
                                          defaultTrialDays,
                                          defaultPlanId
                                      }: Props): BILLING_FUNCTION_WRAPPER_HANDLERS {
    // Retention coupons for the offboarding flow (Step 2). The server picks the
    // coupon by trial status; the client never sends a coupon id.
    const trialRetentionCouponId = Deno.env.get("STRIPE_TRIAL_RETENTION_COUPON_ID");
    const retentionDiscountCouponId = Deno.env.get("STRIPE_RETENTION_DISCOUNT_COUPON_ID");

    return {
        provider: "stripe",
        async getPlans() {
            return getPlans(stripeClient, defaultTrialDays);
        },

        async getSubscriptionSummary({subscriptionId}) {
            return getSubscriptionSummary(stripeClient, {
                subscriptionId,
                discountCouponId: retentionDiscountCouponId,
            });
        },

        async applyRetentionOffer({subscriptionId}) {
            return applyRetentionOffer(stripeClient, {
                subscriptionId,
                trialCouponId: trialRetentionCouponId,
                discountCouponId: retentionDiscountCouponId,
            });
        },

        async cancelSubscription({subscriptionId, reason, note}) {
            return cancelSubscription(stripeClient, {subscriptionId, reason, note});
        },

        async getBillingStatus({
                                   accountId,
                                   customerId,
                                   billingEmail,
                                   defaultTrialDays,
                                   defaultPlanId,
                                   subscriptionId,
                               }) {
            const customer = await findOrCreateCustomer(stripeClient, {
                customerId,
                billingEmail,
                accountId,
            });

            const subscription = await findOrCreateSubscription(stripeClient, {
                subscriptionId,
                customerId: customer?.id,
                defaultPlanId,
                accountId,
                defaultTrialDays,
            });

            return {
                provider: 'stripe',
                customer,
                subscription,
            };
        },
        async getNewSubscriptionUrl({
                                        successUrl,
                                        cancelUrl,
                                        accountId,
                                        planId,
                                        billingEmail,
                                        customerId,
                                        promotionId,
                                        clientReferenceId,
                                    }) {

            const customer = await findOrCreateCustomer(stripeClient, {
                customerId,
                billingEmail,
                accountId,
            });

            if (!customer) {
                throw new Error("Customer not found");
            }

            const session = await stripeClient.checkout.sessions.create({
                customer: customer.id,
                subscription_data: {
                    trial_period_days: defaultTrialDays,
                    trial_settings: {
                        end_behavior: {
                            missing_payment_method: 'create_invoice' // subscription will go past_due if no payment method is added in time
                        }
                    },
                    metadata: {
                        basejump_account_id: accountId,
                    },
                    items: [
                        {
                            plan: planId || defaultPlanId
                        },
                    ],
                },
                mode: "subscription",
                success_url: successUrl,
                cancel_url: cancelUrl,
                metadata: {
                    basejump_account_id: accountId,
                },
                ...(clientReferenceId && { client_reference_id: clientReferenceId }),
                ...(promotionId && { discounts: [{ promotion_code: promotionId }] }),
            });
            
            return {
                url: session.url,
            };
        },
        async getBillingPortalUrl({returnUrl, customerId}) {
            const session = await stripeClient.billingPortal.sessions.create({
                customer: customerId,
                return_url: returnUrl,
            });

            return {
                url: session.url,
            };
        },
    };
}
