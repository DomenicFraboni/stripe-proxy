const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "22.0" });
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

  // Expand invoice, invoice lines, invoice discount, and charge-level discount
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");
  params.append("expand[]", "data.invoice.discount");
  // Note: data.discount cannot be expanded on charges — charge-level discounts
  // are fetched via the /enrich endpoint (checkout session lookup)

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

// Enrich endpoint — fetches checkout session for direct-checkout charges
app.post("/enrich", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set." });

  const piIds = (req.body.piIds || []).slice(0, 20);
  const headers = { Authorization: `Bearer ${stripeKey}` };
  const results = {};

  await Promise.all(piIds.map(async (piId) => {
    try {
      // Try checkout session first
      const sessRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions?payment_intent=${piId}&limit=1` +
        `&expand[]=data.line_items&expand[]=data.total_details.breakdown`,
        { headers }
      );
      const sessData = await sessRes.json();
      const session = sessData.data?.[0];

      if (session) {
        const lineItems = (session.line_items?.data || []).map(i => i.description).filter(Boolean);
        let discountCode = null, discountAmount = null;

        for (const d of session.total_details?.breakdown?.discounts || []) {
          const promo = d.discount?.promotion_code;
          if (promo && typeof promo === "object" && promo.code) {
            discountCode = promo.code;
            discountAmount = (d.amount || 0) / 100;
            break;
          }
          const coupon = d.discount?.coupon?.name || d.discount?.coupon?.id;
          if (coupon) { discountCode = coupon; discountAmount = (d.amount || 0) / 100; break; }
        }

        results[piId] = { lineItems, discountCode, discountAmount };
        return;
      }

      // No checkout session found — try fetching the payment intent directly
      // Payment intents created via custom integrations store discount in metadata
      const piRes = await fetch(
        `https://api.stripe.com/v1/payment_intents/${piId}`,
        { headers }
      );
      const piData = await piRes.json();
      if (!piData.error) {
        const meta = piData.metadata || {};
        const code = meta.coupon || meta.discount_code || meta.promo_code ||
                     meta.coupon_code || meta.discount || null;
        // Also check if there's a discount amount in metadata
        const amt = meta.discount_amount ? parseFloat(meta.discount_amount) : null;
        results[piId] = { lineItems: [], discountCode: code, discountAmount: amt };
        return;
      }

      results[piId] = { lineItems: [], discountCode: null, discountAmount: null };
    } catch (e) {
      results[piId] = { lineItems: [], discountCode: null, discountAmount: null };
    }
  }));

  res.json(results);
});

function extractDiscount(charge) {
  // 1. Charge-level discount (direct checkout purchases)
  const chargeDisc = charge.discount;
  if (chargeDisc && typeof chargeDisc === "object") {
    const couponName = chargeDisc.coupon?.name || null;
    const couponId = chargeDisc.coupon?.id || null;
    const code = couponName || couponId;
    if (code) {
      return {
        code,
        amount: chargeDisc.coupon?.amount_off ? chargeDisc.coupon.amount_off / 100 : null
      };
    }
  }

  // 2. Invoice discount (subscription charges)
  const inv = charge.invoice;
  if (inv && typeof inv === "object") {
    const disc = inv.discount;
    if (disc && typeof disc === "object") {
      const couponName = disc.coupon?.name || null;
      const couponId = disc.coupon?.id || null;
      const code = couponName || couponId;
      if (code) {
        return {
          code,
          amount: disc.coupon?.amount_off ? disc.coupon.amount_off / 100 : null
        };
      }
    }
    // total_discount_amounts on invoice
    if (inv.total_discount_amounts?.length > 0) {
      const d = inv.total_discount_amounts[0];
      if (d.discount && typeof d.discount === "object") {
        const couponName = d.discount.coupon?.name || null;
        const couponId = d.discount.coupon?.id || null;
        const code = couponName || couponId;
        if (code) return { code, amount: (d.amount || 0) / 100 };
      }
    }
  }

  // 3. Charge metadata fallback
  const meta = charge.metadata || {};
  const code = meta.coupon || meta.discount_code || meta.promo_code || meta.coupon_code || null;
  if (code) return { code, amount: null };

  return null;
}

app.listen(PORT, () => {
  console.log(`Stripe proxy v23.0 running on port ${PORT}`);
});
