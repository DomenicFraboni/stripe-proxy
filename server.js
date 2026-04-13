const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running" });
});

// Generic Stripe passthrough — forwards any GET request to Stripe
app.get("/stripe/*", async (req, res) => {
  if (!STRIPE_KEY) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured on server." });
  }

  const stripePath = req.params[0];
  const queryString = new URLSearchParams(req.query).toString();
  const stripeUrl = `https://api.stripe.com/v1/${stripePath}${queryString ? "?" + queryString : ""}`;

  try {
    const response = await fetch(stripeUrl, {
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
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
