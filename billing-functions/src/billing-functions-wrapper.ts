import { Database as BASEJUMP_DATABASE_SCHEMA } from "../types/basejump-database.ts";
import { requireAuthorizedBillingUser } from "./require-authorized-billing-user.ts";
import getBillingStatus from "./wrappers/get-billing-status.ts";
import createSupabaseServiceClient from "../lib/create-supabase-service-client.ts";
import { corsHeaders } from "../lib/cors-headers.ts";
import { BASEJUMP_BILLING_DATA_UPSERT } from "../lib/upsert-data.ts";
import validateUrl from "../lib/validate-url.ts";
import errorResponse from "../lib/error-response.ts";
import { SUBSCRIPTION_SUMMARY } from "./providers/stripe/billing-functions/get-subscription-summary.ts";
import { RETENTION_OFFER_RESULT } from "./providers/stripe/billing-functions/apply-retention-offer.ts";
import { CANCELLATION_RESULT } from "./providers/stripe/billing-functions/cancel-subscription.ts";

type GET_PLANS_ARGS = {
  account_id?: string;
};

type GET_PLANS_RESPONSE = Array<{
  product_name: string;
  product_description?: string;
  currency: string;
  price: number;
  id: string;
  interval: "month" | "year" | "one_time";
  features: string[];
  trial_period_days?: number;
  promotions: Array<{
    id: string;
    code: string;
    name?: string;
    percent_off?: number;
    amount_off?: number;
    duration?: string;
    duration_in_months?: number;
  }>;
}>;

type GET_BILLING_PORTAL_URL_ARGS = {
  accountId: string;
  subscriptionId: string;
  customerId?: string;
  returnUrl: string;
};

type GET_NEW_SUBSCRIPTION_URL_ARGS = {
  accountId: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
  billingEmail: string;
  customerId?: string;
  promotionId?: string;
  clientReferenceId?: string;
};

type GET_BILLING_STATUS_ARGS = {
  accountId: string;
  billingEmail?: string;
  defaultPlanId?: string;
  defaultTrialDays?: number;
  customerId?: string;
  subscriptionId?: string;
};

type GENERIC_URL_RESPONSE = {
  url: string;
};

// Offboarding / retention flow argument shapes.
type SUBSCRIPTION_SUMMARY_ARGS = {
  subscriptionId: string;
};

type APPLY_RETENTION_OFFER_ARGS = {
  subscriptionId: string;
};

type CANCEL_SUBSCRIPTION_ARGS = {
  subscriptionId: string;
  reason?: string;
  note?: string;
};

export type GET_BILLING_STATUS_RESPONSE = {
  subscription_id: string;
  subscription_active: boolean;
  status: BASEJUMP_DATABASE_SCHEMA["basejump"]["Tables"]["billing_subscriptions"]["Row"]["status"];
  billing_email?: string;
  account_role: BASEJUMP_DATABASE_SCHEMA["basejump"]["Tables"]["account_user"]["Row"]["account_role"];
  is_primary_owner: boolean;
  billing_enabled: boolean;
  plan_name?: string;
  metadata?: any;
};

type BILLING_FUNCTION_WRAPPER_OPTIONS = {
  allowedURLs: Array<string>;
};

export type BILLING_FUNCTION_WRAPPER_HANDLERS = {
  provider: BASEJUMP_DATABASE_SCHEMA["basejump"]["Tables"]["billing_subscriptions"]["Row"]["provider"];
  getPlans: (args: GET_PLANS_ARGS) => Promise<GET_PLANS_RESPONSE>;
  getBillingPortalUrl: (
    args: GET_BILLING_PORTAL_URL_ARGS,
  ) => Promise<GENERIC_URL_RESPONSE>;
  getNewSubscriptionUrl: (
    args: GET_NEW_SUBSCRIPTION_URL_ARGS,
  ) => Promise<GENERIC_URL_RESPONSE>;
  getBillingStatus: (
    args: GET_BILLING_STATUS_ARGS,
  ) => Promise<BASEJUMP_BILLING_DATA_UPSERT>;
  getSubscriptionSummary: (
    args: SUBSCRIPTION_SUMMARY_ARGS,
  ) => Promise<SUBSCRIPTION_SUMMARY>;
  applyRetentionOffer: (
    args: APPLY_RETENTION_OFFER_ARGS,
  ) => Promise<RETENTION_OFFER_RESULT>;
  cancelSubscription: (
    args: CANCEL_SUBSCRIPTION_ARGS,
  ) => Promise<CANCELLATION_RESULT>;
};

// Best-effort audit write for the offboarding flow. Uses the service-role
// client (bypasses RLS). `public.cancellations` is not in the basejump-typed
// Database, so the insert goes through an untyped client. Never throws — a
// failed audit write must not fail the Stripe action that already succeeded.
async function recordCancellation(
  accountId: string,
  row: {
    reason?: string;
    features?: string[];
    note?: string;
    offer_variant?: string;
    offer_shown: boolean;
    offer_accepted: boolean;
    outcome: "retained" | "cancelled";
  },
): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    // deno-lint-ignore no-explicit-any
    const { error } = await (supabase as any).from("cancellations").insert({
      account_id: accountId,
      reason: row.reason ?? null,
      features: row.features ?? [],
      note: row.note ?? null,
      offer_variant: row.offer_variant ?? null,
      offer_shown: row.offer_shown,
      offer_accepted: row.offer_accepted,
      outcome: row.outcome,
    });
    if (error) {
      console.log("Failed to record cancellation:", error);
    }
  } catch (e) {
    console.log("recordCancellation error:", e);
  }
}

export function billingFunctionsWrapper(
  handlers: BILLING_FUNCTION_WRAPPER_HANDLERS,
  options: BILLING_FUNCTION_WRAPPER_OPTIONS = {
    allowedURLs: [],
  },
): (req: Request) => Promise<Response> {
  return async function (req: Request) {
    // check for options preflight and handle cors
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    const body = await req.json();

    if (body.action !== "get_plans" && !body.args?.account_id) {
      return errorResponse("Account id is required");
    }
    try {
      switch (body.action) {
        case "get_plans":
          const plans = await handlers.getPlans(body.args);
          return new Response(JSON.stringify(plans), {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          });
        case "get_billing_portal_url":
          if (!validateUrl(body.args.return_url, options.allowedURLs)) {
            return errorResponse("Return url is not allowed");
          }
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const response = await handlers.getBillingPortalUrl({
                accountId: roleInfo.account_id,
                subscriptionId: roleInfo.billing_subscription_id,
                customerId: roleInfo.billing_customer_id,
                returnUrl: body.args.return_url,
              });
              return new Response(
                JSON.stringify({
                  billing_enabled: roleInfo.billing_enabled,
                  ...response,
                }),
                {
                  headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                  },
                },
              );
            },
          });
        case "get_new_subscription_url":
          if (
            !validateUrl(body.args.success_url, options.allowedURLs) ||
            !validateUrl(body.args.cancel_url, options.allowedURLs)
          ) {
            return errorResponse("Success or cancel url is not allowed");
          }
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const response = await handlers.getNewSubscriptionUrl({
                accountId: roleInfo.account_id,
                planId: body.args.plan_id,
                successUrl: body.args.success_url,
                cancelUrl: body.args.cancel_url,
                billingEmail: roleInfo.billing_email,
                customerId: roleInfo.billing_customer_id,
                promotionId: body.args.promotion_id,
                clientReferenceId: body.args.client_reference_id,
              });
              return new Response(
                JSON.stringify({
                  billing_enabled: roleInfo.billing_enabled,
                  ...response,
                }),
                {
                  headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                  },
                },
              );
            },
          });

        case "get_billing_status":
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const supabaseClient = createSupabaseServiceClient();
              const response = await getBillingStatus(
                supabaseClient,
                roleInfo,
                handlers,
              );

              return new Response(
                JSON.stringify({
                  ...response,
                  status: response.status || "not_setup",
                  billing_enabled: roleInfo.billing_enabled,
                }),
                {
                  headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                  },
                },
              );
            },
          });

        // ---- Offboarding / retention flow -----------------------------------
        case "get_subscription_summary":
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const summary = await handlers.getSubscriptionSummary({
                subscriptionId: roleInfo.billing_subscription_id,
              });
              return new Response(JSON.stringify(summary), {
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json",
                },
              });
            },
          });

        case "apply_retention_offer":
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const result = await handlers.applyRetentionOffer({
                subscriptionId: roleInfo.billing_subscription_id,
              });
              await recordCancellation(roleInfo.account_id, {
                reason: body.args.reason,
                features: body.args.features,
                note: body.args.note,
                offer_variant: result.offer_variant,
                offer_shown: true,
                offer_accepted: result.applied,
                outcome: "retained",
              });
              return new Response(JSON.stringify(result), {
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json",
                },
              });
            },
          });

        case "cancel_subscription":
          return await requireAuthorizedBillingUser(req, {
            accountId: body.args.account_id,
            authorizedRoles: ["owner"],
            async onBillableAndAuthorized(roleInfo) {
              const result = await handlers.cancelSubscription({
                subscriptionId: roleInfo.billing_subscription_id,
                reason: body.args.reason,
                note: body.args.note,
              });
              await recordCancellation(roleInfo.account_id, {
                reason: body.args.reason,
                features: body.args.features,
                note: body.args.note,
                offer_variant: body.args.offer_variant,
                offer_shown: !!body.args.offer_shown,
                offer_accepted: false,
                outcome: "cancelled",
              });
              return new Response(JSON.stringify(result), {
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json",
                },
              });
            },
          });

        default:
          return errorResponse("Invalid action");
      }
    } catch (e) {
      console.log(e);
      return errorResponse("Internal server error", 500);
    }
  };
}
