const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "20.0" });
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
  // Expand discount AND its promotion_code so we get the human-readable code (e.g. "LIFT")
  // This is exactly 4 levels: data -> invoice -> discount -> promotion_code
  params.append("expand[]", "data.invoice.discount");
  params.append("expand[]", "data.invoice.discount.promotion_code");

  try {
    const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    for (const charge of data.data || []) {
      const disc = extractDiscount(charge);
      charge._discountCode = disc?.code || null;
      charge._discountAmount = disc?.amount || null;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

// Enrich endpoint — for direct checkout charges (no invoice)
// Fetches checkout session to get line items + promotion code
app.post("/enrich", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set." });

  const piIds = (req.body.piIds || []).slice(0, 20);
  const headers = { Authorization: `Bearer ${stripeKey}` };
  const results = {};

  await Promise.all(piIds.map(async (piId) => {
    try {
      const sessRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions?payment_intent=${piId}&limit=1` +
        `&expand[]=data.line_items&expand[]=data.total_details.breakdown`,
        { headers }
      );
      const sessData = await sessRes.json();
      const session = sessData.data?.[0];
      if (!session) { results[piId] = { lineItems: [], discountCode: null, discountAmount: null }; return; }

      const lineItems = (session.line_items?.data || []).map(i => i.description).filter(Boolean);

      let discountCode = null, discountAmount = null;
      for (const d of session.total_details?.breakdown?.discounts || []) {
        const promo = d.discount?.promotion_code;
        // promotion_code is expanded here so .code is available
        if (promo && typeof promo === "object" && promo.code) {
          discountCode = promo.code;
          discountAmount = (d.amount || 0) / 100;
          break;
        }
        // Fallback: coupon name
        const coupon = d.discount?.coupon?.name || d.discount?.coupon?.id;
        if (coupon) { discountCode = coupon; discountAmount = (d.amount || 0) / 100; break; }
      }

      results[piId] = { lineItems, discountCode, discountAmount };
    } catch (e) {
      results[piId] = { lineItems: [], discountCode: null, discountAmount: null };
    }
  }));

  res.json(results);
});

function extractDiscount(charge) {
  const inv = charge.invoice;
  if (inv && typeof inv === "object") {
    const disc = inv.discount;
    if (disc && typeof disc === "object") {
      // promotion_code is now expanded — .code is the human-readable code like "LIFT"
      const promoCode = disc.promotion_code?.code || null;
      // coupon.name is the display name set in Stripe dashboard
      const couponName = disc.coupon?.name || null;
      // coupon.id is the internal ID (last resort)
      const couponId = disc.coupon?.id || null;
      const code = promoCode || couponName || couponId;
      if (code) {
        const amount = disc.coupon?.amount_off
          ? disc.coupon.amount_off / 100
          : disc.coupon?.percent_off
          ? null
          : null;
        return { code, amount };
      }
    }
    // Also check total_discount_amounts which has the applied discount amount
    if (inv.total_discount_amounts?.length > 0) {
      const d = inv.total_discount_amounts[0];
      if (d.discount && typeof d.discount === "object") {
        const promoCode = d.discount.promotion_code?.code || null;
        const couponName = d.discount.coupon?.name || null;
        const couponId = d.discount.coupon?.id || null;
        const code = promoCode || couponName || couponId;
        if (code) return { code, amount: (d.amount || 0) / 100 };
      }
    }
  }
  // Charge metadata fallback
  const meta = charge.metadata || {};
  const code = meta.coupon || meta.discount_code || meta.promo_code || meta.coupon_code || null;
  if (code) return { code, amount: null };
  return null;
}

app.listen(PORT, () => {
  console.log(`Stripe proxy v20.0 running on port ${PORT}`);
});
