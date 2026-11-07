require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SHIPPING_FLAT = Number(process.env.SHIPPING_FLAT ?? 80);
const FREE_SHIPPING_ABOVE = Number(process.env.FREE_SHIPPING_ABOVE ?? 2999);

/* Temporary / backup payment method: customer pays to your UPI ID and sends the screenshot on WhatsApp */
const STORE_NAME = process.env.STORE_NAME || "Diya & Dhaga";
const UPI_ID = (process.env.UPI_ID || "").trim();
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || "").replace(/\D/g, ""); // with country code, e.g. 919876543210
// Placeholder values from .env.example are rejected so customers never pay a wrong ID by mistake
const UPI_OK = /^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(UPI_ID) && !/^yourname@/i.test(UPI_ID);
const WA_OK = /^\d{11,14}$/.test(WHATSAPP_NUMBER) && WHATSAPP_NUMBER !== "919876543210";

const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, "products.json"), "utf8"));
const PRODUCT_MAP = new Map(PRODUCTS.map(p => [p.id, p]));


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



app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* Safety net: if the HTML pages were uploaded to the repo root instead of /public,
   still serve them. Only these two files are exposed, never the whole folder. */
for (const page of ["index.html", "policies.html"]) {
  const route = page === "index.html" ? "/" : "/" + page;
  app.get(route, (req, res, next) => {
    const file = path.join(__dirname, page);
    fs.existsSync(file) ? res.sendFile(file) : next();
  });
}

/* ---------- API ---------- */
app.get("/api/config", (_req, res) =>
  res.json({
    shippingFlat: SHIPPING_FLAT,
    freeShippingAbove: FREE_SHIPPING_ABOVE,
    paymentsEnabled: false,
    manualEnabled: UPI_OK || WA_OK
  })
);

/* Manual order: server prices the cart, saves the order as "awaiting_payment", returns UPI + WhatsApp links */
app.post("/api/manual-order", async (req, res) => {
  if (!UPI_OK && !WA_OK) return res.status(503).json({ error: "This payment method is not available right now." });
  try {
    const cart = priceCart(req.body.items);
    const customer = validateCustomer(req.body.customer);
    const receipt = "DW" + Date.now().toString(36).toUpperCase();

    await updateOrders(orders => {
      orders[receipt] = {
        orderId: receipt,
        receipt,
        method: "manual-upi",
        status: "awaiting_payment",
        createdAt: new Date().toISOString(),
        amount: cart.total,
        subtotal: cart.subtotal,
        shipping: cart.shipping,
        items: cart.lines,
        customer
      };
    });

    const lines = cart.lines.map(l => `- ${l.name} (Size ${l.size}) x${l.qty} = Rs ${l.price * l.qty}`);
    const text = [
      `New order ${receipt}`,
      ...lines,
      cart.shipping ? `Shipping: Rs ${cart.shipping}` : "Shipping: Free",
      `Total: Rs ${cart.total}`,
      "",
      `Name: ${customer.name}`,
      `Mobile: ${customer.phone}`,
      `Address: ${customer.address}, ${customer.city} - ${customer.pincode}`,
      "",
      "I have paid by UPI. Payment screenshot attached."
    ].join("\n");

    res.json({
      receipt,
      amount: cart.total,
      storeName: STORE_NAME,
      upiId: UPI_OK ? UPI_ID : null,
      upiLink: UPI_OK
        ? `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(STORE_NAME)}&am=${cart.total}.00&cu=INR&tn=${encodeURIComponent(receipt)}`
        : null,
      whatsappLink: WA_OK ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}` : null
    });
  } catch (err) {
    const known = /Cart|quantity|product|name|mobile|email|address|city|pincode/i.test(err.message);
    if (!known) console.error("manual-order error:", err);
    res.status(known ? 400 : 500).json({ error: known ? err.message : "Could not place the order. Please try again." });
  }
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
 
});

/* Simple admin view. Protect with ADMIN_TOKEN before going live.
   GET  /api/admin/orders            -> paid orders
   GET  /api/admin/orders?status=all -> every order (includes UPI orders awaiting your confirmation)
   POST /api/admin/mark-paid {orderId} -> after you check the UPI screenshot in your bank/UPI app */
const isAdmin = req => {
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && safeEqual(req.get("x-admin-token"), token);
};
app.get("/api/admin/orders", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const all = Object.values(readOrders());
  res.json(req.query.status === "all" ? all : all.filter(o => o.status === "paid"));
});
app.post("/api/admin/mark-paid", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const id = String((req.body && req.body.orderId) || "");
  const found = await updateOrders(orders => {
    const o = orders[id];
    if (!o) return false;
    o.status = "paid";
    o.paidAt = new Date().toISOString();
    o.paidVia = "manual-confirmed";
    return true;
  });
  if (!found) return res.status(404).json({ error: "Order not found" });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Diwali store running on http://localhost:${PORT}`);
  if (!UPI_OK) console.warn("UPI_ID missing or invalid: UPI payment details will not be shown.");
  if (!WA_OK) console.warn("WHATSAPP_NUMBER missing or invalid: WhatsApp order button will not be shown.");
});

module.exports = app;
