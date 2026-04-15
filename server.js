const express = require("express");
const cors = require("cors");
const path = require("path");
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors());
app.options("*", cors());
app.use(express.json());
 
app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "11.0" });
});
 
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});
 
app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });
 
  // Express parses "created[gte]" into req.query.created = { gte, lte }
  const params = new URLSearchParams({ limit: "100" });
  const created = req.query.created;
  if (created && created.gte) params.append("created[gte]", created.gte);
  if (created && created.lte) params.append("created[lte]", created.lte);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);
 
  // Expand invoice and its line items — stays within Stripe's 4-level expand limit
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");
 
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
  console.log(`Stripe proxy v11.0 running on port ${PORT}`);
});
