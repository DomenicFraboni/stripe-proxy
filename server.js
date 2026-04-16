const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "17.0" });
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

  // Single Stripe request — no extra lookups, no timeouts
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");
  params.append("expand[]", "data.invoice.discount");
  params.append("expand[]", "data.payment_intent");

  try {
    const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    // Extract discount code from invoice or payment intent metadata
    for (const charge of data.data || []) {
      charge._discountCode = extractDiscountCode(charge);
      charge._discountAmount = extractDiscountAmount(charge);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

function extractDiscountCode(charge) {
  // Invoice discount (subscription charges)
  const inv = charge.invoice;
  if (inv && typeof inv === "object") {
    const disc = inv.discount;
    if (disc) {
      const code = disc.promotion_code?.code || disc.coupon?.name || disc.coupon?.id || null;
      if (code) return code;
    }
    if (inv.total_discount_amounts?.length > 0) {
      const d = inv.total_discount_amounts[0];
      if (d.discount && typeof d.discount === "object") {
        const code = d.discount.promotion_code?.code || d.discount.coupon?.name || d.discount.coupon?.id || null;
        if (code) return code;
      }
    }
  }
  // Payment intent metadata (direct checkout charges)
  const pi = charge.payment_intent;
  if (pi && typeof pi === "object") {
    const meta = pi.metadata || {};
    const code = meta.coupon || meta.discount_code || meta.promo_code ||
                 meta.coupon_code || meta.discount || null;
    if (code) return code;
  }
  // Charge metadata
  const meta = charge.metadata || {};
  return meta.coupon || meta.discount_code || meta.promo_code || meta.coupon_code || null;
}

function extractDiscountAmount(charge) {
  const inv = charge.invoice;
  if (inv && typeof inv === "object" && inv.total_discount_amounts?.length > 0) {
    const total = inv.total_discount_amounts.reduce((s, d) => s + (d.amount || 0), 0);
    if (total > 0) return total / 100;
  }
  const pi = charge.payment_intent;
  if (pi && typeof pi === "object" &&
      pi.amount_subtotal != null && pi.amount != null) {
    const diff = pi.amount_subtotal - pi.amount;
    if (diff > 0) return diff / 100;
  }
  return null;
}

app.listen(PORT, () => {
  console.log(`Stripe proxy v17.0 running on port ${PORT}`);
});
