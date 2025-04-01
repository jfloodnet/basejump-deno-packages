import type { Stripe } from "../../../../deps.ts";

export default async function getPlans(stripeClient, defaultTrialDays?: number) {
  const [prices, promotionCodes] = await Promise.all([
    stripeClient.prices.list({
      expand: ["data.product"],
      active: true,
    }),
    stripeClient.promotionCodes.list({
      expand: ["data.coupon.applies_to"],
      active: true,
    })
  ]);

  console.log("Stripe prices response:", JSON.stringify(prices, null, 2));
  console.log("Stripe promotion codes response:", JSON.stringify(promotionCodes, null, 2));

  return prices?.data?.map((price: Stripe.Price) => {
    const productPromotions = promotionCodes.data.filter(promo => 
      promo.coupon.applies_to?.products?.includes(price.product.id)
    );

    return {
      product_name: price.product.name,
      product_description: price.product.description,
      currency: price.currency,
      price: price.unit_amount,
      id: price.id,
      interval:
        price.type === "one_time" ? "one_time" : price.recurring?.interval,
      features: (price.product as Stripe.Product).marketing_features || [],
      trial_period_days: defaultTrialDays,
      promotions: productPromotions.map(promo => ({
        id: promo.id,
        code: promo.code,
        name: promo.coupon.name,
        percent_off: promo.coupon.percent_off,
        amount_off: promo.coupon.amount_off,
        duration: promo.coupon.duration,
        duration_in_months: promo.coupon.duration_in_months,
      })),
    };
  });
}
