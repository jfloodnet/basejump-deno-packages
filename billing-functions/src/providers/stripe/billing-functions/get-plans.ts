import type { Stripe } from "../../../../deps.ts";

export default async function getPlans(stripeClient) {
  const [prices, coupons] = await Promise.all([
    stripeClient.prices.list({
      expand: ["data.product"],
      active: true,
    }),
    stripeClient.coupons.list()
  ]);

  console.log("Stripe prices response:", JSON.stringify(prices, null, 2));
  console.log("Stripe coupons response:", JSON.stringify(coupons, null, 2));

  return prices?.data?.map((price: Stripe.Price) => {
    const productCoupons = coupons.data.filter(coupon => 
      coupon.applies_to?.products?.includes(price.product.id)
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
      coupons: productCoupons.map(coupon => ({
        id: coupon.id,
        name: coupon.name,
        percent_off: coupon.percent_off,
        amount_off: coupon.amount_off,
        duration: coupon.duration,
        duration_in_months: coupon.duration_in_months,
      })),
    };
  });
}
