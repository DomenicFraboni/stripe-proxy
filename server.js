const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Stripe proxy is running", version: "10.0" });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Helper: fetch with a timeout so individual calls never hang forever
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/charges", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY not set in Railway Variables." });

  // Express parses "created[gte]" into req.query.created = { gte: "...", lte: "..." }
  const params = new URLSearchParams({ limit: "100" });
  const created = req.query.created;
  if (created && created.gte) params.append("created[gte]", created.gte);
  if (created && created.lte) params.append("created[lte]", created.lte);
  if (req.query.starting_after) params.append("starting_after", req.query.starting_after);
  params.append("expand[]", "data.invoice");
  params.append("expand[]", "data.invoice.lines");

  const headers = { Authorization: `Bearer ${stripeKey}` };

  try {
    const chargesRes = await fetchWithTimeout(
      `https://api.stripe.com/v1/charges?${params}`,
      { headers },
      15000
    );
    const chargesData = await chargesRes.json();
    if (chargesData.error) return res.status(400).json({ error: chargesData.error.message });

    // Collect unique subscription IDs — cap at 20 to avoid rate limits on large batches
    const subIds = new Set();
    for (const charge of chargesData.data || []) {
      const inv = charge.invoice;
      if (inv && typeof inv === "object" && inv.subscription) {
        subIds.add(inv.subscription);
        if (subIds.size >= 20) break;
      }
    }

    // Fetch subscriptions in parallel with individual timeouts
    const subMap = {};
    await Promise.all([...subIds].map(async (subId) => {
      try {
        const subRes = await fetchWithTimeout(
          `https://api.stripe.com/v1/subscriptions/${subId}`,
          { headers },
          5000  // 5 second timeout per subscription fetch
        );
        const subData = await subRes.json();
        if (!subData.error) {
          subMap[subId] = {
            interval: subData.plan?.interval || subData.items?.data?.[0]?.price?.recurring?.interval || null,
            status: subData.status || null,
          };
        }
      } catch (e) {
        // Timed out or failed — skip this subscription, interval will fall back to amount-based detection
      }
    }));

    // Attach interval data to each charge's invoice
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
  console.log(`Stripe proxy v10.0 running on port ${PORT}`);
});
