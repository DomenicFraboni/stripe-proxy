const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "9.0" });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });

  // Express parses "created[gte]" into req.query.created = { gte: "...", lte: "..." }
  // We must re-encode these correctly for Stripe using bracket notation
  const params = new URLSearchParams({ limit: "100" });

  const created = req.query.created;
  if (created && created.gte) params.append("created[gte]", created.gte);
  if (created && created.lte) params.append("created[lte]", created.lte);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);

  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");

  const headers = { Authorization: `Bearer ${stripeKey}` };

  try {
    const chargesRes = await fetch(`https://api.stripe.com/v1/charges?${params}`, { headers });
    const chargesData = await chargesRes.json();
    if (chargesData.error) return res.status(400).json({ error: chargesData.error.message });

    // Collect unique subscription IDs to fetch billing interval separately
    const subIds = new Set();
    for (const charge of chargesData.data || []) {
      const inv = charge.invoice;
      if (inv && typeof inv === "object" && inv.subscription) {
        subIds.add(inv.subscription);
      }
    }

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
      } catch (e) { /* skip */ }
    }));

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
  console.log(`Stripe proxy v9.0 running on port ${PORT}`);
});
