const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "16.0" });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ── Endpoint 1: Fetch a page of charges (fast — no extra lookups) ──────────
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

  try {
    const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    // Attach invoice-based discount info (fast — already in the response)
    for (const charge of data.data || []) {
      const inv = extractFromInvoiceOrMeta(charge);
      charge._discountCode = inv?.code || null;
      charge._discountAmount = inv?.amount || null;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

// ── Endpoint 2: Enrich a small batch of payment intent IDs ─────────────────
// Dashboard calls this after all pages are loaded, sending 10 PI IDs at a time.
// Returns: { [piId]: { lineItems: [...], discountCode, discountAmount } }
app.post("/enrich", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });

  const piIds = (req.body.piIds || []).slice(0, 10); // max 10 per call
  const headers = { Authorization: `Bearer ${stripeKey}` };
  const results = {};

  await Promise.all(piIds.map(async (piId) => {
    try {
      const sessRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions?payment_intent=${piId}&limit=1&expand[]=data.line_items&expand[]=data.total_details.breakdown`,
        { headers }
      );
      const sessData = await sessRes.json();
      const session = sessData.data?.[0];
      if (!session) { results[piId] = { lineItems: [], discountCode: null, discountAmount: null }; return; }

      // Line item descriptions
      const lineItems = (session.line_items?.data || [])
        .map(i => i.description)
        .filter(Boolean);

      // Promotion code
      let discountCode = null, discountAmount = null;
      for (const d of session.total_details?.breakdown?.discounts || []) {
        const promoCode = d.discount?.promotion_code;
        if (promoCode && typeof promoCode === "object" && promoCode.code) {
          discountCode = promoCode.code;
          discountAmount = (d.amount || 0) / 100;
          break;
        }
        const couponCode = d.discount?.coupon?.name || d.discount?.coupon?.id;
        if (couponCode) { discountCode = couponCode; discountAmount = (d.amount || 0) / 100; break; }
      }

      results[piId] = { lineItems, discountCode, discountAmount };
    } catch (e) {
      results[piId] = { lineItems: [], discountCode: null, discountAmount: null };
    }
  }));

  res.json(results);
});

function extractFromInvoiceOrMeta(charge) {
  const inv = charge.invoice;
  if (inv && typeof inv === "object") {
    const disc = inv.discount;
    if (disc) {
      const code = disc.promotion_code?.code || disc.coupon?.name || disc.coupon?.id || null;
      if (code) return { code, amount: disc.coupon?.amount_off ? disc.coupon.amount_off / 100 : null };
    }
    if (inv.total_discount_amounts?.length > 0) {
      const d = inv.total_discount_amounts[0];
      if (d.discount && typeof d.discount === "object") {
        const code = d.discount.promotion_code?.code || d.discount.coupon?.name || d.discount.coupon?.id || null;
        if (code) return { code, amount: (d.amount || 0) / 100 };
      }
    }
  }
  const pi = charge.payment_intent;
  if (pi && typeof pi === "object") {
    const meta = pi.metadata || {};
    const code = meta.coupon || meta.discount_code || meta.promo_code || meta.coupon_code || meta.discount || null;
    if (code) return { code, amount: null };
  }
  const cmeta = charge.metadata || {};
  const code = cmeta.coupon || cmeta.discount_code || cmeta.promo_code || cmeta.coupon_code || null;
  if (code) return { code, amount: null };
  return null;
}

app.listen(PORT, () => {
  console.log(`Stripe proxy v16.0 running on port ${PORT}`);
});
