const express = require("express");
const cors = require("cors");
const path = require("path");
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors());
app.options("*", cors());
app.use(express.json());
 
app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "14.0" });
});
 
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});
 
app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });
 
  const params = new URLSearchParams({ limit: "100" });
  const created = req.query.created;
  if (created && created.gte) params.append("created[gte]", created.gte);
  if (created && created.lte) params.append("created[lte]", created.lte);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);
 
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");
  params.append("expand[]", "data.invoice.discount");
  params.append("expand[]", "data.payment_intent");
 
  const headers = { Authorization: `Bearer ${stripeKey}` };
 
  try {
    const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, { headers });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
 
    // Collect payment intent IDs that don't already have a discount code
    // so we can look up their checkout sessions for promotion codes
    const piIds = new Set();
    for (const charge of data.data || []) {
      const pi = charge.payment_intent;
      if (pi && typeof pi === "object" && pi.id) {
        // Quick check: does the invoice already give us a code?
        const quickCode = extractFromInvoiceOrMeta(charge);
        if (!quickCode) piIds.add(pi.id);
      }
    }
 
    // For each payment intent without a known discount, look up its checkout session
    // Checkout sessions store the human-readable promotion code (e.g. "LIFT")
    const sessionCodeMap = {};
    await Promise.all([...piIds].map(async (piId) => {
      try {
        const sessRes = await fetch(
          `https://api.stripe.com/v1/checkout/sessions?payment_intent=${piId}&limit=1&expand[]=data.total_details.breakdown`,
          { headers }
        );
        const sessData = await sessRes.json();
        const session = sessData.data?.[0];
        if (!session) return;
 
        // total_details.breakdown.discounts contains the promotion code objects
        const discounts = session.total_details?.breakdown?.discounts || [];
        for (const d of discounts) {
          // promotion_code is the human-readable code the customer entered
          const promoCode = d.discount?.promotion_code;
          if (promoCode && typeof promoCode === "object") {
            sessionCodeMap[piId] = {
              code: promoCode.code,                        // "LIFT"
              amount: (d.amount || 0) / 100,              // 5.00
              couponName: d.discount?.coupon?.name || null // coupon display name
            };
            return;
          }
          // Fallback: use coupon id/name if no promotion code object
          const couponCode = d.discount?.coupon?.id || d.discount?.coupon?.name;
          if (couponCode) {
            sessionCodeMap[piId] = {
              code: couponCode,
              amount: (d.amount || 0) / 100,
              couponName: d.discount?.coupon?.name || null
            };
            return;
          }
        }
 
        // Also check session.discounts array (older API versions)
        for (const d of session.discounts || []) {
          const promoCode = d.promotion_code;
          if (promoCode && typeof promoCode === "object") {
            sessionCodeMap[piId] = { code: promoCode.code, amount: null, couponName: null };
            return;
          }
          if (typeof promoCode === "string") {
            sessionCodeMap[piId] = { code: promoCode, amount: null, couponName: null };
            return;
          }
        }
      } catch (e) { /* skip — non-critical */ }
    }));
 
    // Attach discount info to each charge
    for (const charge of data.data || []) {
      const invoiceMeta = extractFromInvoiceOrMeta(charge);
      const piId = charge.payment_intent?.id;
      const sessionInfo = piId ? sessionCodeMap[piId] : null;
 
      if (invoiceMeta) {
        charge._discountCode = invoiceMeta.code;
        charge._discountAmount = invoiceMeta.amount;
      } else if (sessionInfo) {
        charge._discountCode = sessionInfo.code;
        charge._discountAmount = sessionInfo.amount;
      } else {
        charge._discountCode = null;
        charge._discountAmount = null;
      }
    }
 
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});
 
// Extract discount from invoice or payment intent metadata (fast path, no extra API calls)
function extractFromInvoiceOrMeta(charge) {
  const inv = charge.invoice;
  if (inv && typeof inv === "object") {
    // Invoice discount object (expanded)
    const disc = inv.discount;
    if (disc) {
      const code = disc.promotion_code?.code || disc.coupon?.name || disc.coupon?.id || null;
      if (code) return { code, amount: disc.coupon?.amount_off ? disc.coupon.amount_off / 100 : null };
    }
    // total_discount_amounts
    if (inv.total_discount_amounts?.length > 0) {
      const d = inv.total_discount_amounts[0];
      if (d.discount && typeof d.discount === "object") {
        const code = d.discount.promotion_code?.code || d.discount.coupon?.name || d.discount.coupon?.id || null;
        if (code) return { code, amount: (d.amount || 0) / 100 };
      }
    }
  }
 
  // Payment intent metadata
  const pi = charge.payment_intent;
  if (pi && typeof pi === "object") {
    const meta = pi.metadata || {};
    const code = meta.coupon || meta.discount_code || meta.promo_code || meta.coupon_code || meta.discount || null;
    if (code) return { code, amount: null };
  }
 
  // Charge metadata
  const cmeta = charge.metadata || {};
  const code = cmeta.coupon || cmeta.discount_code || cmeta.promo_code || cmeta.coupon_code || null;
  if (code) return { code, amount: null };
 
  return null;
}
 
app.listen(PORT, () => {
  console.log(`Stripe proxy v14.0 running on port ${PORT}`);
});
 
