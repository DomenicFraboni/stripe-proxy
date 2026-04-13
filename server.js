const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "5.0" });
});

// Serve the dashboard HTML
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Single page of charges
app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });

  const params = new URLSearchParams({ limit: "100" });
  if (req.query["created[gte]"]) params.append("created[gte]", req.query["created[gte]"]);
  if (req.query["created[lte]"]) params.append("created[lte]", req.query["created[lte]"]);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);

  try {
    const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe proxy v5.0 running on port ${PORT}`);
});
