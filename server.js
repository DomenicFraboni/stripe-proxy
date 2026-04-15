const express = require("express");
const cors = require("cors");
const path = require("path");
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors());
app.options("*", cors());
app.use(express.json());
 
app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "8.0" });
});
 
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});
 
// Fetch one page of charges.
// Strategy: expand invoice + invoice.lines (4 levels max: data.invoice.lines.data).
// Then for each invoice that has a subscription, fetch the subscription separately
// to get the billing interval and billing_reason — those live on the subscription
// object which is a separate top-level resource and not subject to the expand limit.
app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });
 
  const params = new URLSearchParams({ limit: "100" });
  if (req.query["created[gte]"]) params.append("created[gte]", req.query["created[gte]"]);
  if (req.query["created[lte]"]) params.append("created[lte]", req.query["created[lte]"]);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);
 
  // Stay within 4-level expand limit: data → invoice → lines → data (that's exactly 4)
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");
 
  const headers = { Authorization: `Bearer ${stripeKey}` };
 
  try {
    const chargesRes = await fetch(`https://api.stripe.com/v1/charges?${params}`, { headers });
    const chargesData = await chargesRes.json();
    if (chargesData.error) return res.status(400).json({ error: chargesData.error.message });
 
    // Collect unique subscription IDs from this batch so we can fetch intervals
    const subIds = new Set();
    for (const charge of chargesData.data || []) {
      const inv = charge.invoice;
      if (inv && typeof inv === "object" && inv.subscription) {
        subIds.add(inv.subscription);
      }
    }
 
    // Fetch each unique subscription (interval + status) — these are top-level resources
    const subMap = {};
    await Promise.all([...subIds].map(async (subId) => {
      try {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { headers });
        const subData = await subRes.json();
        if (!subData.error) {
          subMap[subId] = {
            interval: subData.plan?.interval || subData.items?.data?.[0]?.price?.recurring?.interval || null,
            status: subData.status || null,
          };
        }
      } catch (e) { /* skip if individual sub fetch fails */ }
    }));
 
    // Attach subscription interval data onto each charge's invoice
    for (const charge of chargesData.data || []) {
      const inv = charge.invoice;
      if (inv && typeof inv === "object" && inv.subscription && subMap[inv.subscription]) {
        inv._subInterval = subMap[inv.subscription].interval;
        inv._subStatus   = subMap[inv.subscription].status;
      }
    }
 
    res.json(chargesData);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`Stripe proxy v8.0 running on port ${PORT}`);
});
