const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "3.0" });
});

// Single-page Stripe passthrough — key comes from environment only
app.get("/stripe/*", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway environment variables. Please add it in Railway → Variables." });

  const stripePath = req.params[0];
  const queryString = new URLSearchParams(req.query).toString();
  const stripeUrl = `https://api.stripe.com/v1/${stripePath}${queryString ? "?" + queryString : ""}`;

  try {
    const response = await fetch(stripeUrl, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

// Paginated endpoint — loops through all Stripe pages automatically
app.get("/stripe-all/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway environment variables. Please add it in Railway → Variables." });

  const maxRecords = Math.min(parseInt(req.query.max_records) || 1000, 25000);
  const createdGte = req.query["created[gte]"];
  const createdLte = req.query["created[lte]"];

  let allCharges = [];
  let startingAfter = null;
  let hasMore = true;

  try {
    while (hasMore && allCharges.length < maxRecords) {
      const batchSize = Math.min(100, maxRecords - allCharges.length);
      const params = new URLSearchParams({ limit: batchSize });
      if (createdGte) params.append("created[gte]", createdGte);
      if (createdLte) params.append("created[lte]", createdLte);
      if (startingAfter) params.append("starting_after", startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });

      allCharges = allCharges.concat(data.data || []);
      hasMore = data.has_more;
      if (data.data && data.data.length > 0) {
        startingAfter = data.data[data.data.length - 1].id;
      } else {
        hasMore = false;
      }
    }

    res.json({ data: allCharges, total: allCharges.length, truncated: hasMore });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch from Stripe: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe proxy v3.0 running on port ${PORT}`);
});
