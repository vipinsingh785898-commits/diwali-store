require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 3000;
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const SHIPPING_FLAT = Number(process.env.SHIPPING_FLAT ?? 80);
const FREE_SHIPPING_ABOVE = Number(process.env.FREE_SHIPPING_ABOVE ?? 2999);

const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, "products.json"), "utf8"));
const PRODUCT_MAP = new Map(PRODUCTS.map(p => [p.id, p]));

const razorpay = KEY_ID && KEY_SECRET ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET }) : null;

/* ---------- Tiny file-based order store (swap for MongoDB in production) ---------- */
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "{}");

let writeChain = Promise.resolve();
function updateOrders(mutator) {
  writeChain = writeChain.then(async () => {
    const orders = JSON.parse(await fs.promises.readFile(ORDERS_FILE, "utf8"));
    const result = mutator(orders);
    await fs.promises.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
    return result;
  });
  return writeChain;
}
const readOrders = () => JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));

/* ---------- Helpers ---------- */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

function priceCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 30) throw new Error("Cart is empty or invalid");
  const lines = [];
  let subtotal = 0;
  for (const it of rawItems) {
    const product = PRODUCT_MAP.get(it && it.id);
    const qty = Number(it && it.qty);
    if (!product) throw new Error("Unknown product in cart");
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new Error("Invalid quantity");
    const size = String((it && it.size) || "Free").slice(0, 10);
    lines.push({ id: product.id, name: product.name, price: product.price, qty, size });
    subtotal += product.price * qty;
  }
  const shipping = subtotal >= FREE_SHIPPING_ABOVE ? 0 : SHIPPING_FLAT;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}

function validateCustomer(c) {
  const clean = {
    name: String((c && c.name) || "").trim().slice(0, 80),
    phone: String((c && c.phone) || "").replace(/\D/g, "").slice(-10),
    email: String((c && c.email) || "").trim().slice(0, 120),
    address: String((c && c.address) || "").trim().slice(0, 300),
    city: String((c && c.city) || "").trim().slice(0, 60),
    pincode: String((c && c.pincode) || "").replace(/\D/g, "").slice(0, 6)
  };
  if (clean.name.length < 2) throw new Error("Please enter your full name");
  if (!/^[6-9]\d{9}$/.test(clean.phone)) throw new Error("Enter a valid 10-digit mobile number");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw new Error("Enter a valid email address");
  if (clean.address.length < 8) throw new Error("Please enter your full delivery address");
  if (clean.city.length < 2) throw new Error("Please enter your city");
  if (!/^\d{6}$/.test(clean.pincode)) throw new Error("Enter a valid 6-digit pincode");
  return clean;
}

/* ---------- Webhook (needs the RAW body, so it is registered before express.json) ---------- */
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!WEBHOOK_SECRET) return res.status(503).send("Webhook not configured");
  const signature = req.get("X-Razorpay-Signature");
  if (!safeEqual(signature, hmac(WEBHOOK_SECRET, req.body))) return res.status(400).send("Invalid signature");

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "payment.captured" || event.event === "order.paid") {
      const payment = event.payload && event.payload.payment && event.payload.payment.entity;
      const orderId = payment && payment.order_id;
      if (orderId) {
        await updateOrders(orders => {
          const o = orders[orderId];
          if (o && o.status !== "paid") {
            o.status = "paid";
            o.paymentId = payment.id;
            o.paidAt = new Date().toISOString();
            o.paidVia = "webhook";
          }
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).send("Webhook failed");
  }
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
 res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------- API ---------- */
app.get("/api/products", (_req, res) => res.json(PRODUCTS));

app.get("/api/config", (_req, res) =>
  res.json({ shippingFlat: SHIPPING_FLAT, freeShippingAbove: FREE_SHIPPING_ABOVE, paymentsEnabled: Boolean(razorpay) })
);

app.post("/api/create-order", async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payments are not configured yet. Add Razorpay keys to .env." });
  try {
    const cart = priceCart(req.body.items);
    const customer = validateCustomer(req.body.customer);

    const order = await razorpay.orders.create({
      amount: cart.total * 100, // paise; computed on the server, never trusted from the browser
      currency: "INR",
      receipt: "DW" + Date.now().toString(36).toUpperCase(),
      notes: { customer: customer.name, phone: customer.phone }
    });

    await updateOrders(orders => {
      orders[order.id] = {
        orderId: order.id,
        receipt: order.receipt,
        status: "created",
        createdAt: new Date().toISOString(),
        amount: cart.total,
        subtotal: cart.subtotal,
        shipping: cart.shipping,
        items: cart.lines,
        customer
      };
    });

    res.json({
      keyId: KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      prefill: { name: customer.name, email: customer.email, contact: customer.phone }
    });
  } catch (err) {
    const known = /Cart|quantity|product|name|mobile|email|address|city|pincode/i.test(err.message);
    if (!known) console.error("create-order error:", err);
    res.status(known ? 400 : 500).json({ error: known ? err.message : "Could not start payment. Please try again." });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  if (!KEY_SECRET) return res.status(503).json({ error: "Payments are not configured" });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: "Missing payment details" });

  const expected = hmac(KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
  if (!safeEqual(expected, razorpay_signature)) return res.status(400).json({ error: "Payment verification failed" });

  const receipt = await updateOrders(orders => {
    const o = orders[razorpay_order_id];
    if (!o) return null;
    if (o.status !== "paid") {
      o.status = "paid";
      o.paymentId = razorpay_payment_id;
      o.paidAt = new Date().toISOString();
      o.paidVia = "checkout";
    }
    return o.receipt;
  });
  if (!receipt) return res.status(404).json({ error: "Order not found" });
  res.json({ ok: true, receipt });
});

/* Simple admin view of paid orders. Protect with ADMIN_TOKEN before going live. */
app.get("/api/admin/orders", (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !safeEqual(req.get("x-admin-token"), token)) return res.status(401).json({ error: "Unauthorized" });
  const paid = Object.values(readOrders()).filter(o => o.status === "paid");
  res.json(paid);
});

app.listen(PORT, () => {
  console.log(`Diwali store running on http://localhost:${PORT}`);
  if (!razorpay) console.warn("Razorpay keys missing: storefront works, payments are disabled until .env is set.");
});

module.exports = app;
