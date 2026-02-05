// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import crypto from "crypto";
import nodemailer from "nodemailer";

import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

dotenv.config();

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3001;

const DEBUG = String(process.env.DEBUG || "false").toLowerCase() === "true";
const RENDER = String(process.env.RENDER || "false").toLowerCase() === "true";

const VINCARIO_API_KEY = process.env.VINCARIO_API_KEY || "";
const VINCARIO_SECRET_KEY = process.env.VINCARIO_SECRET_KEY || "";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // optional, aber empfohlen

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || "https://fzb-24-api.onrender.com").replace(/\/+$/, "");

const PDF_ENABLED = String(process.env.PDF_ENABLED || "true").toLowerCase() === "true";
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || "true").toLowerCase() === "true";

// SMTP (Gmail App-Passwort!)
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

// Puppeteer (für Render)
const PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR;
const PUPPETEER_SKIP_DOWNLOAD = process.env.PUPPETEER_SKIP_DOWNLOAD;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function log(...args) {
  if (DEBUG) console.log(...args);
}

// ---------- Helpers ----------
function normalizeVin(v) {
  const vin = String(v || "").trim().toUpperCase();
  // VIN ist meist 17 Zeichen, wir akzeptieren aber erst mal ">= 8" für Robustheit
  return vin.length >= 8 ? vin : "";
}

function extractEmail(payload) {
  return (
    payload?.email ||
    payload?.contact?.email ||
    payload?.order?.buyerInfo?.email ||
    payload?.data?.contact?.email ||
    null
  );
}

/**
 * Wix kann die FIN an verschiedenen Stellen liefern:
 * - direkt als "vin"
 * - als customTextFields in lineItems
 * - als Checkout "Benutzerdefiniertes Feld" -> order.extendedFields.namespaces._user_fields.<...>
 *
 * Dein aktueller Payload zeigt:
 * order.extendedFields.namespaces._user_fields.fahrgestellnummer_fin_1
 */
function extractVin(payload) {
  // 1) direkt
  const direct = normalizeVin(payload?.vin);
  if (direct) return direct;

  // 2) wenn Payload verschachtelt "data"
  const direct2 = normalizeVin(payload?.data?.vin);
  if (direct2) return direct2;

  // 3) Wix extendedFields user_fields (Checkout-Feld)
  const uf =
    payload?.order?.extendedFields?.namespaces?._user_fields ||
    payload?.data?.order?.extendedFields?.namespaces?._user_fields;

  if (uf && typeof uf === "object") {
    // wenn du den exakten Key kennst, bevorzugen:
    const exact = normalizeVin(uf.fahrgestellnummer_fin_1);
    if (exact) return exact;

    // sonst: irgendeinen value nehmen, der wie VIN aussieht
    for (const k of Object.keys(uf)) {
      const candidate = normalizeVin(uf[k]);
      if (candidate) return candidate;
    }
  }

  // 4) customTextFields in lineItems
  const li =
    payload?.order?.lineItems ||
    payload?.data?.order?.lineItems ||
    payload?.order?.line_items ||
    payload?.data?.order?.line_items;

  if (Array.isArray(li) && li.length) {
    const ctf =
      li[0]?.customTextFields ||
      li[0]?.customTextfields ||
      li[0]?.custom_text_fields;

    if (Array.isArray(ctf)) {
      const found = ctf.find((f) => String(f?.title || "").toLowerCase().includes("fin"));
      if (found?.value) {
        const candidate = normalizeVin(found.value);
        if (candidate) return candidate;
      }
    }
  }

  return "";
}

function readWebhookSecretFromRequest(req) {
  // “sichere Version”: akzeptiere Header ODER Query, damit Wix-HTTP-Action ohne Header geht.
  // (Du nutzt aktuell ?secret=... in Wix, also passt das.)
  const headerSecret = req.headers["x-webhook-secret"];
  const querySecret = req.query?.secret;
  return String(headerSecret || querySecret || "");
}

function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) {
    // Wenn du es wirklich weglassen würdest, wäre es offen. Ich empfehle es dringend.
    return true;
  }
  const got = readWebhookSecretFromRequest(req);
  return got === WEBHOOK_SECRET;
}

function randomReportId() {
  return crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 chars
}

// --- Vincario ---
function makeControlSum(vin, action) {
  // gleiche Idee wie bisher: kontrolle aus VIN + action + secret
  const str = `${vin}|${action}|${VINCARIO_SECRET_KEY}`;
  return crypto.createHash("sha256").update(str).digest("hex");
}

async function vincarioGet(vin, action) {
  // ⚠️ Du hast das schon laufen. Ich lasse es “generisch”.
  // Falls du eine konkrete Vincario URL nutzt, trage sie hier ein.
  // Beispiel (Platzhalter):
  const base = "https://api.vindecoder.eu/3.2"; // nur als Beispiel – falls du eine andere URL nutzt, ersetzen!
  const controlsum = makeControlSum(vin, action);

  const url = `${base}/${VINCARIO_API_KEY}/${controlsum}/${action}/${encodeURIComponent(vin)}.json`;

  log("[vincario] GET", url);

  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    throw new Error(`Vincario ${action} failed: ${r.status} ${text}`);
  }
  return data;
}

// --- PDF Generation (simple HTML->PDF) ---
function buildReportHtml({ vin, vehicle, reportId }) {
  const make = vehicle?.make || "";
  const model = vehicle?.model || "";
  const year = vehicle?.year || "";
  const fuel = vehicle?.fuel || "";
  const transmission = vehicle?.transmission || "";
  const body = vehicle?.body || "";

  // Minimal und stabil – später kannst du es “schöner” machen.
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <title>FZB-24 Bericht ${reportId}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
    h1 { margin: 0 0 8px; }
    .meta { color: #444; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    td, th { border: 1px solid #ddd; padding: 10px; text-align: left; }
    th { background: #f5f5f5; }
    .small { font-size: 12px; color: #555; margin-top: 18px; }
  </style>
</head>
<body>
  <h1>Fahrzeugbericht</h1>
  <div class="meta">
    Report-ID: <b>${reportId}</b><br/>
    VIN: <b>${vin}</b><br/>
    Datum: ${new Date().toLocaleString("de-DE")}
  </div>

  <table>
    <tr><th>Merkmal</th><th>Wert</th></tr>
    <tr><td>Hersteller</td><td>${make}</td></tr>
    <tr><td>Modell</td><td>${model}</td></tr>
    <tr><td>Baujahr</td><td>${year}</td></tr>
    <tr><td>Kraftstoff</td><td>${fuel}</td></tr>
    <tr><td>Getriebe</td><td>${transmission}</td></tr>
    <tr><td>Karosserie</td><td>${body}</td></tr>
  </table>

  <div class="small">
    Hinweis: Der Bericht basiert auf verfügbaren Daten aus Datenbanken. Keine Garantie auf Vollständigkeit/Richtigkeit.
  </div>
</body>
</html>`;
}

async function generatePdfBuffer(html) {
  // Render: chromium.executablePath() benutzen
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// --- Email ---
function createMailer() {
  if (!EMAIL_ENABLED) return null;

  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("⚠️ EMAIL_ENABLED=true aber SMTP_USER/SMTP_PASS fehlen.");
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function buildCustomerMail({ vin, reportId }) {
  // “sauberes Mail-Template”: klare Struktur, kurz, verständlich, kein Tech-Kram.
  const subject = `Dein Fahrzeugbericht (VIN ${vin}) – FZB-24`;

  const text =
`Hallo,

anbei erhältst du deinen Fahrzeugbericht.

Report-ID: ${reportId}
VIN: ${vin}

Viele Grüße
FZB-24
`;

  const html =
`<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
  <h2 style="margin:0 0 8px">Dein Fahrzeugbericht</h2>
  <p style="margin:0 0 12px">Anbei erhältst du deinen Fahrzeugbericht als PDF.</p>
  <p style="margin:0 0 12px">
    <b>Report-ID:</b> ${reportId}<br/>
    <b>VIN:</b> ${vin}
  </p>
  <p style="margin:16px 0 0">Viele Grüße<br/>FZB-24</p>
</div>`;

  return { subject, text, html };
}

// ---------- Routes ----------
app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    build: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "local",
    emailEnabled: EMAIL_ENABLED,
    pdfEnabled: PDF_ENABLED,
  });
});

app.get("/", (req, res) => res.send("ok"));

// Debug echo: zeigt an, ob Secret überhaupt ankommt + Body passt
app.post("/api/_debug/echo", (req, res) => {
  const ok = verifyWebhook(req);
  res.json({ ok, headers: req.headers, body: req.body });
});

// Preview / Report endpoint (optional, falls du es nutzt)
app.get("/api/report/:vin", async (req, res) => {
  try {
    const vin = normalizeVin(req.params.vin);
    if (!vin) return res.status(400).json({ success: false, error: "invalid_vin" });

    // Beispiel: decode nur
    const decoded = await vincarioGet(vin, "decode");

    // “Preview” Felder extrahieren (anpassen an deine Vincario Antwort)
    const vehicle = {
      make: decoded?.make || decoded?.result?.make || "",
      model: decoded?.model || decoded?.result?.model || "",
      year: decoded?.year || decoded?.result?.year || "",
      fuel: decoded?.fuel || decoded?.result?.fuel || "",
      transmission: decoded?.transmission || decoded?.result?.transmission || "",
      body: decoded?.body || decoded?.result?.body || "",
    };

    res.json({
      success: true,
      preview: { vin, vehicle },
      preview_note:
        "Vorschau: Es werden nur Basisdaten angezeigt. Premium-Bericht enthält zusätzliche Prüfungen und Details.",
      locked_sections: [
        { title: "Diebstahlcheck (EU)", hint: "Prüfung über mehrere EU-Datenbanken (Details im PDF)." },
        { title: "Marktwert", hint: "Marktwert-Indikator (wenn ausreichende Marktdaten vorhanden)." },
        { title: "Technische Daten", hint: "Maße, Gewicht, Bremsen, Lenkung, Räder, CO₂ u.v.m." },
        { title: "Hinweise & Datenquellen", hint: "Transparente Erklärung, was geprüft wurde und was nicht." },
      ],
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: "server_error" });
  }
});

// Wix webhook / order handler
app.post("/api/order-from-wix", async (req, res) => {
  try {
    // 1) Secret check
    if (!verifyWebhook(req)) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }

    // 2) purchaseFlowId + email + vin auslesen (robust)
    const payload = req.body;

    const purchaseFlowId =
      payload?.purchaseFlowId ||
      payload?.order?.purchaseFlowId ||
      payload?.data?.order?.purchaseFlowId ||
      payload?.data?.order?.purchaseFlowId ||
      null;

    const email = extractEmail(payload);
    const vin = extractVin(payload);

    if (!email || !String(email).includes("@")) {
      console.error("❌ Email leer/ungültig", { purchaseFlowId });
      return res.status(400).json({ success: false, error: "email_missing" });
    }

    if (!vin) {
      console.error("❌ VIN leer/ungültig", {
        purchaseFlowId,
        email,
        hint: "Wix speichert oft in order.extendedFields.namespaces._user_fields",
      });
      return res.status(400).json({ success: false, error: "vin_missing" });
    }

    // 3) Daten holen (mindestens decode)
    const decoded = await vincarioGet(vin, "decode");

    const vehicle = {
      make: decoded?.make || decoded?.result?.make || "",
      model: decoded?.model || decoded?.result?.model || "",
      year: decoded?.year || decoded?.result?.year || "",
      fuel: decoded?.fuel || decoded?.result?.fuel || "",
      transmission: decoded?.transmission || decoded?.result?.transmission || "",
      body: decoded?.body || decoded?.result?.body || "",
    };

    const reportId = randomReportId();

    // 4) PDF bauen
    let pdfBuffer = null;
    if (PDF_ENABLED) {
      const html = buildReportHtml({ vin, vehicle, reportId });
      pdfBuffer = await generatePdfBuffer(html);
    }

    // 5) Mail senden
    if (EMAIL_ENABLED) {
      const transporter = createMailer();
      if (!transporter) {
        console.warn("⚠️ Mailer nicht bereit, überspringe Mailversand.");
      } else {
        const mail = buildCustomerMail({ vin, reportId });

        const attachments = [];
        if (pdfBuffer) {
          attachments.push({
            filename: `FZB24_Bericht_${vin}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          });
        }

        await transporter.sendMail({
          from: MAIL_FROM,
          to: email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments,
        });
      }
    }

    return res.json({
      success: true,
      status: EMAIL_ENABLED ? "sent" : "ok",
      purchaseFlowId,
      email,
      vin,
      reportId,
      message: EMAIL_ENABLED
        ? "PDF erstellt und per E-Mail versendet."
        : "Bericht erstellt (Mailversand deaktiviert).",
    });
  } catch (e) {
    console.error("❌ order-from-wix error:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf ${PUBLIC_BASE_URL} (PORT=${PORT})`);
  console.log(`✅ EMAIL_ENABLED=${EMAIL_ENABLED} SMTP=${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}`);
  if (PUPPETEER_CACHE_DIR) console.log(`✅ PUPPETEER_CACHE_DIR=${PUPPETEER_CACHE_DIR}`);
  if (PUPPETEER_SKIP_DOWNLOAD) console.log(`✅ PUPPETEER_SKIP_DOWNLOAD=${PUPPETEER_SKIP_DOWNLOAD}`);
});
