const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running" });
});

// Generic Stripe passthrough
app.get("/stripe/*", async (req, res) => {
  // Accept key from environment variable OR from request header
  const stripeKey = process.env.STRIPE_SECRET_KEY || req.headers["x-stripe-key"];

  if (!stripeKey) {
    return res.status(401).json({ error: "No Stripe key provided. Set STRIPE_SECRET_KEY in Railway environment variables." });
  }

  const stripePath = req.params[0];
  const queryString = new URLSearchParams(req.query).toString();
  const stripeUrl = `https://api.stripe.com/v1/${stripePath}${queryString ? "?" + queryString : ""}`;

  try {
    const response = await fetch(stripeUrl, {
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to reach Stripe: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe proxy running on port ${PORT}`);
});
