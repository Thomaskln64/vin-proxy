require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  // nodemailer optional; wenn nicht installiert, geben wir später klare Fehlermeldung aus
}

const app = express();
const PORT = process.env.PORT || 3001;

// ===== Config =====
const API_VERSION = '3.2';
const VINCARIO_BASE_URL = `https://api.vincario.com/${API_VERSION}`;
const VINCARIO_API_KEY = process.env.VINCARIO_API_KEY;
const VINCARIO_SECRET_KEY = process.env.VINCARIO_SECRET_KEY;

const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

const PDF_ENABLED = (process.env.PDF_ENABLED || 'true').toLowerCase() === 'true';
const EMAIL_ENABLED = (process.env.EMAIL_ENABLED || 'true').toLowerCase() === 'true';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@fzb-24.com';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

// Render erkennt man oft über NODE_ENV=production, alternativ RENDER=true
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase() === 'production' ||
  (process.env.RENDER || '').toLowerCase() === 'true';

if (!VINCARIO_API_KEY || !VINCARIO_SECRET_KEY) {
  console.error('❌ Missing VINCARIO_API_KEY or VINCARIO_SECRET_KEY in env');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ===== Helpers =====
function sanitizeVin(vin) {
  return String(vin || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 25);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pick(decodeArr, label) {
  if (!Array.isArray(decodeArr)) return undefined;
  const hit = decodeArr.find((d) => d.label === label);
  return hit ? hit.value : undefined;
}

function makeControlSum(vin, action) {
  const hashString = `${vin}|${action}|${VINCARIO_API_KEY}|${VINCARIO_SECRET_KEY}`;
  return crypto.createHash('sha1').update(hashString).digest('hex').substring(0, 10);
}

async function getJson(url, headers = {}) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(url, { headers });
  const text = await resp.text();

  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }

  return { ok: resp.ok, status: resp.status, json, rawText: text };
}

async function vincarioGet(vin, action) {
  const v = sanitizeVin(vin);
  const controlSum = makeControlSum(v, action);
  const url = `${VINCARIO_BASE_URL}/${VINCARIO_API_KEY}/${controlSum}/${action}/${v}.json`;
  if (DEBUG) console.log('🔗 Vincario:', url);
  return await getJson(url);
}

function stripInternalFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  delete copy.balance;
  delete copy.price;
  delete copy.price_currency;
  return copy;
}

function summarizeStolen(stolenJson) {
  const rows = stolenJson?.stolen;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { available: false, status: 'unknown', details: [] };
  }
  const anyStolen = rows.some((r) => String(r.status).toLowerCase() === 'stolen');
  return {
    available: true,
    status: anyStolen ? 'stolen' : 'not-stolen',
    details: rows.map((r) => ({ source: r.code, status: r.status })),
  };
}

function summarizeMarketValue(valueJson) {
  if (!valueJson || valueJson.error) {
    return { available: false, reason: valueJson?.message || 'no_data' };
  }
  return { available: true, data: valueJson };
}

function stolenLabel(status) {
  if (status === 'not-stolen') return 'Nicht als gestohlen gemeldet';
  if (status === 'stolen') return 'Achtung: Als gestohlen gemeldet';
  return 'Unbekannt';
}

function yesNoUnknown(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function makeReportId(vin) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha1')
    .update(`${vin}|${day}`)
    .digest('hex')
    .substring(0, 10)
    .toUpperCase();
}

// ===== Robust payload extraction (Wix) =====
function deepGet(obj, pathArr) {
  let cur = obj;
  for (const key of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function findFirstStringByKeys(obj, keyNamesLower) {
  // durchsucht rekursiv nach Keys wie "email", "vin" etc. (strings)
  const seen = new Set();
  const stack = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const [k, v] of Object.entries(cur)) {
      const kl = String(k).toLowerCase();
      if (keyNamesLower.includes(kl) && typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return undefined;
}

function extractEmailFromWixPayload(body) {
  // häufige Stellen bei Wix Stores:
  // body.order.buyerInfo.email
  // body.Order.BuyerInfo.Email (Automation UI zeigt oft so)
  const direct =
    deepGet(body, ['order', 'buyerInfo', 'email']) ||
    deepGet(body, ['Order', 'BuyerInfo', 'Email']) ||
    deepGet(body, ['Order', 'Buyer Info', 'Email']);

  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  // fallback: irgendwo im payload ein "email" key finden
  return findFirstStringByKeys(body, ['email', 'buyeremail', 'authoremail']);
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue');
}

function extractVinFromWixPayload(body) {
  // 1) wenn du (oder Automation) direkt vin schickst
  if (typeof body?.vin === 'string' && body.vin.trim()) return body.vin.trim();

  // 2) manche Wix Payloads enthalten customTextFields / customFields
  const candidates = [];

  const pushIf = (v) => {
    if (typeof v === 'string' && v.trim()) candidates.push(v.trim());
  };

  // mögliche Pfade
  const maybeArrays = [
    deepGet(body, ['order', 'lineItems']),
    deepGet(body, ['Order', 'Line Items']),
    deepGet(body, ['Order', 'lineItems']),
    deepGet(body, ['Order', 'lineItems', '0', 'customTextFields']), // falls komisch
    deepGet(body, ['order', 'customFields']),
    deepGet(body, ['order', 'customTextFields']),
    deepGet(body, ['Order', 'customFields']),
    deepGet(body, ['Order', 'customTextFields']),
  ];

  // lineItems kann array sein, darin customTextFields
  for (const mi of maybeArrays) {
    if (Array.isArray(mi)) {
      for (const item of mi) {
        if (!item || typeof item !== 'object') continue;
        const ctf = item.customTextFields || item.customFields || item.customTextFieldValues;
        if (Array.isArray(ctf)) {
          for (const f of ctf) {
            const title = normalizeTitle(f?.title || f?.name || f?.key);
            const value = f?.value || f?.text || f?.stringValue;
            if (['vin', 'fin', 'fahrgestellnummer', 'fahrgestellnummerfin'].includes(title)) pushIf(value);
          }
        }
      }
    }
  }

  // 3) fallback: überall im payload nach "vin" suchen
  const anywhere = findFirstStringByKeys(body, ['vin', 'fin', 'fahrgestellnummer']);
  if (anywhere) candidates.push(anywhere);

  // best candidate: der, der wie VIN aussieht (>=11)
  const best = candidates
    .map((x) => sanitizeVin(x))
    .find((x) => x.length >= 11);

  return best || undefined;
}

function extractPurchaseFlowId(body) {
  if (typeof body?.purchaseFlowId === 'string' && body.purchaseFlowId.trim()) return body.purchaseFlowId.trim();
  const p =
    deepGet(body, ['Order', 'Purchase Flow Id']) ||
    deepGet(body, ['order', 'purchaseFlowId']) ||
    deepGet(body, ['order', 'purchaseFlow', 'id']);
  if (typeof p === 'string' && p.trim()) return p.trim();
  return findFirstStringByKeys(body, ['purchaseflowid', 'checkoutid', 'paymentorderid', 'externalorderid']);
}

// ===== Report Builders =====
async function buildPreviewReport(vin) {
  const decodeR = await vincarioGet(vin, 'decode');
  if (!decodeR.ok || !decodeR.json?.decode) {
    return { ok: false, error: 'decode_failed', status: decodeR.status, raw: decodeR.rawText };
  }
  const d = decodeR.json.decode;
  return {
    ok: true,
    preview: {
      vin: sanitizeVin(vin),
      vehicle: {
        make: pick(d, 'Make') || null,
        model: pick(d, 'Model') || null,
        year: pick(d, 'Model Year') || pick(d, 'Production Year') || null,
        fuel: pick(d, 'Fuel Type - Primary') || null,
        transmission: pick(d, 'Transmission') || null,
        body: pick(d, 'Body') || null,
      },
    },
  };
}

async function buildPremiumReport(vin, email = null) {
  const decodeR = await vincarioGet(vin, 'decode');
  if (!decodeR.ok || !decodeR.json?.decode) {
    return { ok: false, error: 'decode_failed', status: decodeR.status, raw: decodeR.rawText };
  }

  const stolenR = await vincarioGet(vin, 'stolen-check');
  const valueR = await vincarioGet(vin, 'vehicle-market-value');

  const d = decodeR.json.decode;
  const v = sanitizeVin(vin);

  const report = {
    vin: v,
    report_id: makeReportId(v),
    email,
    vehicle: {
      make: pick(d, 'Make') || null,
      model: pick(d, 'Model') || null,
      year: pick(d, 'Model Year') || pick(d, 'Production Year') || null,
      body: pick(d, 'Body') || null,
      fuel: pick(d, 'Fuel Type - Primary') || null,
      transmission: pick(d, 'Transmission') || null,

      manufacturer: pick(d, 'Manufacturer') || null,
      plant_country: pick(d, 'Plant Country') || null,

      engine_ccm: pick(d, 'Engine Displacement (ccm)') || null,
      engine_code: pick(d, 'Engine Code') || null,
      engine_type: pick(d, 'Engine Type') || null,
      drive: pick(d, 'Drive') || null,

      co2_g_km: pick(d, 'CO2 Emission (g/km)') || null,
      consumption_urban: pick(d, 'Fuel Consumption Urban (l/100km)') || null,

      doors: pick(d, 'Number of Doors') || null,
      seats: pick(d, 'Number of Seats') || null,

      length_mm: pick(d, 'Length (mm)') || null,
      width_mm: pick(d, 'Width (mm)') || null,
      height_mm: pick(d, 'Height (mm)') || null,
      wheelbase_mm: pick(d, 'Wheelbase (mm)') || null,

      weight_empty_kg: pick(d, 'Weight Empty (kg)') || null,
      max_weight_kg: pick(d, 'Max Weight (kg)') || null,
      max_speed_kmh: pick(d, 'Max Speed (km/h)') || null,

      wheel_size: pick(d, 'Wheel Size') || null,
      brakes_front: pick(d, 'Front Brakes') || null,
      brake_system: pick(d, 'Brake System') || null,
      steering_type: pick(d, 'Steering Type') || null,
      suspension: pick(d, 'Suspension') || null,
    },
    checks: {
      stolen: stolenR.ok ? summarizeStolen(stolenR.json) : { available: false, status: 'unavailable' },
      market_value: valueR.ok ? summarizeMarketValue(valueR.json) : { available: false, reason: 'unavailable' },
    },
    vin_decode_raw: stripInternalFields(decodeR.json),
    generated_at: new Date().toISOString(),
    disclaimer:
      'Informationsbericht auf Basis verfügbarer Datenquellen. Keine Garantie für Vollständigkeit oder Unfallfreiheit.',
  };

  return { ok: true, report };
}

// ===== HTML Report (multi-page) =====
function renderReportHtml(report) {
  const v = report.vehicle || {};
  const stolenStatus = report.checks?.stolen?.status || 'unknown';
  const market = report.checks?.market_value;

  let verdict = {
    label: 'Hinweis',
    color: 'warn',
    text: 'Keine vollständige Historie verfügbar. Bericht dient zur Orientierung.',
  };
  if (stolenStatus === 'not-stolen') verdict = { label: 'OK', color: 'ok', text: 'Kein Treffer im EU-Diebstahlcheck gefunden.' };
  if (stolenStatus === 'stolen') verdict = { label: 'Achtung', color: 'bad', text: 'Treffer im Diebstahlcheck. Bitte unbedingt prüfen.' };

  const title = `${v.make || ''} ${v.model || ''} (${v.year || '—'})`.trim();
  const marketText = market?.available ? 'Verfügbar' : `Nicht verfügbar (${market?.reason || 'keine Daten'})`;

  const stolenDetailsRows =
    (report.checks?.stolen?.details || [])
      .map((r) => `<tr><td>${escapeHtml(r.source)}</td><td>${escapeHtml(r.status)}</td></tr>`)
      .join('') || `<tr><td colspan="2">—</td></tr>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>FZB-24 Fahrzeugbericht</title>
<style>
  :root{
    --brandRed:#9F1239;
    --text:#0f172a;
    --muted:#475569;
    --line:rgba(15,23,42,.12);
    --soft:#f8fafc;
    --ok:#16a34a;
    --warn:#f59e0b;
    --bad:#ef4444;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;color:var(--text);background:#fff}
  .page{padding:22px 24px;page-break-after:always}
  .page:last-child{page-break-after:auto}
  .header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}
  .brand{font-weight:950;font-size:18px;color:var(--text)}
  .sub{color:var(--muted);font-size:12px;margin-top:3px;line-height:1.4}
  .chip{
    display:inline-block;padding:8px 10px;border-radius:999px;
    border:1px solid rgba(225,29,72,.25);
    background:#fff;
    color:var(--text);font-size:12px;white-space:nowrap;
  }
  .topline{
    border:1px solid var(--line);
    border-radius:16px;
    padding:12px 14px;
    background:linear-gradient(180deg,#0b1220,#0f1a33);
    color:#fff;
    position:relative;
    overflow:hidden;
    margin-bottom:12px;
  }
  .topline:before{
    content:"";
    position:absolute;left:0;top:0;bottom:0;width:12px;
    background:var(--brandRed);
  }
  .h1{font-size:20px;font-weight:950;margin:0 0 4px 0}
  .meta{color:#e2e8f0;opacity:.95;font-size:12px}
  .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:12px}
  .twoCol{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .box{border:1px solid var(--line);border-radius:14px;padding:12px;background:#fff}
  .secH{
    font-size:13px;font-weight:950;margin:0 0 8px 0;color:var(--text);
    padding-left:10px;border-left:4px solid var(--brandRed);
  }
  .para{color:var(--muted);font-size:12px;line-height:1.6}
  .pill{
    display:flex;gap:10px;align-items:flex-start;
    border:1px solid var(--line);
    border-radius:14px;padding:10px 12px;background:#fff;margin-bottom:10px
  }
  .dot{width:10px;height:10px;border-radius:50%;margin-top:4px}
  .dot.ok{background:var(--ok)}
  .dot.warn{background:var(--warn)}
  .dot.bad{background:var(--bad)}
  .small{color:var(--muted);font-size:12px;line-height:1.5}
  .table{
    width:100%;
    border-collapse:separate;border-spacing:0;
    overflow:hidden;border-radius:14px;
    border:1px solid rgba(15,23,42,.14);
    margin-top:8px;
  }
  .table th,.table td{
    padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.08);
    font-size:12px;color:var(--text);background:#fff;
  }
  .table th{background:var(--soft);text-align:left;}
  .table tr:last-child td{border-bottom:none}
</style>
</head>
<body>

<div class="page">
  <div class="header">
    <div>
      <div class="brand">FZB-24 Fahrzeugbericht</div>
      <div class="sub">
        Erstellt am ${escapeHtml(new Date(report.generated_at).toLocaleDateString('de-DE'))}
        · Report-ID <span style="color:var(--brandRed);font-weight:900">${escapeHtml(report.report_id)}</span>
      </div>
    </div>
    <div class="chip">VIN: ${escapeHtml(report.vin)}</div>
  </div>

  <div class="topline">
    <div class="h1">${escapeHtml(title || 'Fahrzeug')}</div>
    <div class="meta">${escapeHtml(v.body || '—')} · ${escapeHtml(v.fuel || '—')} · ${escapeHtml(v.transmission || '—')}</div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="secH">Fahrzeugübersicht</div>
      <table class="table">
        <tbody>
          <tr><th style="width:42%">Hersteller</th><td>${escapeHtml(v.manufacturer || v.make || '—')}</td></tr>
          <tr><th>Produktionsland</th><td>${escapeHtml(v.plant_country || '—')}</td></tr>
          <tr><th>Motor</th><td>${escapeHtml(v.engine_code || '—')} ${v.engine_ccm ? '(' + escapeHtml(v.engine_ccm) + ' ccm)' : ''}</td></tr>
          <tr><th>Antrieb</th><td>${escapeHtml(v.drive || '—')}</td></tr>
          <tr><th>CO₂</th><td>${escapeHtml(v.co2_g_km ?? '—')} g/km</td></tr>
          <tr><th>Höchstgeschwindigkeit</th><td>${escapeHtml(v.max_speed_kmh ?? '—')} km/h</td></tr>
        </tbody>
      </table>

      <div class="pill" style="margin-top:10px">
        <span class="dot ${escapeHtml(verdict.color)}"></span>
        <div>
          <div style="font-weight:950">${escapeHtml(verdict.label)}</div>
          <div class="small">${escapeHtml(verdict.text)}</div>
        </div>
      </div>
    </div>

    <div class="box">
      <div class="secH">Premium Checks</div>

      <div class="pill">
        <span class="dot ${stolenStatus === 'not-stolen' ? 'ok' : (stolenStatus === 'stolen' ? 'bad' : 'warn')}"></span>
        <div>
          <div style="font-weight:950">Diebstahlcheck (EU)</div>
          <div class="small">${escapeHtml(stolenLabel(stolenStatus))}</div>
        </div>
      </div>

      <div class="pill">
        <span class="dot ${market?.available ? 'ok' : 'warn'}"></span>
        <div>
          <div style="font-weight:950">Marktwert</div>
          <div class="small">${escapeHtml(marketText)}</div>
        </div>
      </div>

      <div class="small" style="margin-top:10px">
        Hinweis: ${escapeHtml(report.disclaimer)}
      </div>
    </div>
  </div>
</div>

<div class="page">
  <div class="header">
    <div>
      <div class="brand">FZB-24 Fahrzeugbericht</div>
      <div class="sub">Fahrzeugdetails · VIN ${escapeHtml(report.vin)} · Report-ID ${escapeHtml(report.report_id)}</div>
    </div>
    <div class="chip">${escapeHtml(title || 'Fahrzeug')}</div>
  </div>

  <div class="twoCol">
    <div class="box">
      <div class="secH">Allgemein</div>
      <div class="para">
        <b>Karosserie:</b> ${escapeHtml(v.body || '—')}<br/>
        <b>Türen:</b> ${escapeHtml(yesNoUnknown(v.doors))}<br/>
        <b>Sitze:</b> ${escapeHtml(yesNoUnknown(v.seats))}<br/>
        <b>Antrieb:</b> ${escapeHtml(v.drive || '—')}<br/>
        <b>Getriebe:</b> ${escapeHtml(v.transmission || '—')}
      </div>
    </div>

    <div class="box">
      <div class="secH">Motor & Umwelt</div>
      <div class="para">
        <b>Motortyp:</b> ${escapeHtml(v.engine_type || '—')}<br/>
        <b>Motorkennung:</b> ${escapeHtml(v.engine_code || '—')}<br/>
        <b>Hubraum:</b> ${escapeHtml(yesNoUnknown(v.engine_ccm))} ccm<br/>
        <b>CO₂:</b> ${escapeHtml(yesNoUnknown(v.co2_g_km))} g/km<br/>
        <b>Verbrauch (urban):</b> ${escapeHtml(yesNoUnknown(v.consumption_urban))} l/100km
      </div>
    </div>

    <div class="box">
      <div class="secH">Herstellung</div>
      <div class="para">
        <b>Hersteller:</b> ${escapeHtml(v.manufacturer || '—')}<br/>
        <b>Produktionsland:</b> ${escapeHtml(v.plant_country || '—')}
      </div>
      <div class="small" style="margin-top:8px">Hinweis: Angaben können je nach Datenquelle variieren.</div>
    </div>

    <div class="box">
      <div class="secH">Checks</div>
      <div class="para">
        <b>Diebstahlcheck:</b> ${escapeHtml(stolenLabel(stolenStatus))}<br/>
        <b>Marktwert:</b> ${escapeHtml(marketText)}
      </div>
    </div>
  </div>

  <table class="table" style="margin-top:12px">
    <thead>
      <tr><th colspan="2">Diebstahlcheck Details (EU-Datenbanken)</th></tr>
      <tr><th>Quelle</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${stolenDetailsRows}
    </tbody>
  </table>
</div>

<div class="page">
  <div class="header">
    <div>
      <div class="brand">FZB-24 Fahrzeugbericht</div>
      <div class="sub">Technische Daten · VIN ${escapeHtml(report.vin)} · Report-ID ${escapeHtml(report.report_id)}</div>
    </div>
    <div class="chip">${escapeHtml(title || 'Fahrzeug')}</div>
  </div>

  <table class="table">
    <thead><tr><th colspan="2">Technische Daten</th></tr></thead>
    <tbody>
      <tr><th style="width:42%">Länge</th><td>${escapeHtml(yesNoUnknown(v.length_mm))} mm</td></tr>
      <tr><th>Breite</th><td>${escapeHtml(yesNoUnknown(v.width_mm))} mm</td></tr>
      <tr><th>Höhe</th><td>${escapeHtml(yesNoUnknown(v.height_mm))} mm</td></tr>
      <tr><th>Radstand</th><td>${escapeHtml(yesNoUnknown(v.wheelbase_mm))} mm</td></tr>
      <tr><th>Leergewicht</th><td>${escapeHtml(yesNoUnknown(v.weight_empty_kg))} kg</td></tr>
      <tr><th>Max. Gesamtgewicht</th><td>${escapeHtml(yesNoUnknown(v.max_weight_kg))} kg</td></tr>
      <tr><th>Höchstgeschwindigkeit</th><td>${escapeHtml(yesNoUnknown(v.max_speed_kmh))} km/h</td></tr>
      <tr><th>Reifengröße</th><td>${escapeHtml(yesNoUnknown(v.wheel_size))}</td></tr>
      <tr><th>Vordere Bremsen</th><td>${escapeHtml(yesNoUnknown(v.brakes_front))}</td></tr>
      <tr><th>Bremssystem</th><td>${escapeHtml(yesNoUnknown(v.brake_system))}</td></tr>
      <tr><th>Lenkung</th><td>${escapeHtml(yesNoUnknown(v.steering_type))}</td></tr>
      <tr><th>Federung</th><td>${escapeHtml(yesNoUnknown(v.suspension))}</td></tr>
    </tbody>
  </table>

  <div class="small" style="margin-top:10px">
    Tipp: Bei fehlenden Werten liefern die Datenquellen für dieses Modell/VIN keine Angaben.
  </div>
</div>

<div class="page">
  <div class="header">
    <div>
      <div class="brand">FZB-24 Fahrzeugbericht</div>
      <div class="sub">Hinweise & Datenquellen · VIN ${escapeHtml(report.vin)} · Report-ID ${escapeHtml(report.report_id)}</div>
    </div>
    <div class="chip">${escapeHtml(title || 'Fahrzeug')}</div>
  </div>

  <div class="box">
    <div class="secH">Was dieser Bericht abdeckt</div>
    <div class="para">
      • Fahrzeugidentifikation und technische Fahrzeugdaten (VIN Decode)<br/>
      • Diebstahlcheck basierend auf verfügbaren EU-Datenbanken<br/>
      • Marktwert-Indikator, sofern ausreichende Marktdaten vorhanden sind
    </div>
  </div>

  <div class="box" style="margin-top:12px">
    <div class="secH">Wichtige Hinweise</div>
    <div class="para">
      • Dieser Bericht ist ein Informationsprodukt und ersetzt keine Vor-Ort-Prüfung.<br/>
      • Es wird keine Garantie für Vollständigkeit, Unfallfreiheit oder Mängelfreiheit gegeben.<br/>
      • Wenn einzelne Werte fehlen, lagen für dieses Fahrzeug keine Daten vor.
    </div>
  </div>

  <div class="box" style="margin-top:12px">
    <div class="secH">Disclaimer</div>
    <div class="para">${escapeHtml(report.disclaimer)}</div>
  </div>

  <div class="small" style="margin-top:10px">
    Erstellt am ${escapeHtml(new Date(report.generated_at).toLocaleString('de-DE'))}
  </div>
</div>

</body>
</html>`;
}

// ===== PDF Renderer (Buffer) =====
async function renderPdfBuffer(html) {
  const browser = await puppeteer.launch({
    headless: IS_PROD ? chromium.headless : 'new',
    executablePath: IS_PROD ? await chromium.executablePath() : undefined,
    args: IS_PROD ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: IS_PROD ? chromium.defaultViewport : { width: 1280, height: 720 },
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ===== Email =====
function ensureMailerReady() {
  if (!EMAIL_ENABLED) return { ok: false, reason: 'EMAIL_ENABLED=false' };

  if (!nodemailer) return { ok: false, reason: 'nodemailer_not_installed' };

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { ok: false, reason: 'missing_smtp_env' };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return { ok: true, transporter };
}

async function sendReportEmail({ to, vin, reportId, pdfBuffer }) {
  const mailer = ensureMailerReady();
  if (!mailer.ok) throw new Error(`Mail not ready: ${mailer.reason}`);

  const safeVin = sanitizeVin(vin);
  const fileName = `FZB24_${safeVin}_${reportId}.pdf`;

  const subject = `Dein FZB-24 Fahrzeugbericht (${safeVin})`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#0f172a">
    <h2 style="margin:0 0 8px 0">Dein Fahrzeugbericht ist da ✅</h2>
    <p style="margin:0 0 10px 0">
      VIN: <b>${escapeHtml(safeVin)}</b><br/>
      Report-ID: <b>${escapeHtml(reportId)}</b>
    </p>
    <p style="margin:0 0 10px 0">
      Im Anhang findest du den vollständigen Premium-Bericht als PDF.
    </p>
    <p style="margin:0;color:#475569;font-size:12px">
      Hinweis: Bitte prüfe auch deinen Spam-Ordner. Bei Fragen antworte einfach auf diese E-Mail.
    </p>
  </div>`;

  await mailer.transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    html,
    attachments: [
      {
        filename: fileName,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

// ===== Webhook auth =====
function requireWebhookSecret(req, res) {
  const incomingSecret = req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET) {
    // wenn du aus Versehen WEBHOOK_SECRET nicht gesetzt hast:
    return res.status(500).json({ success: false, error: 'server_misconfig', details: 'WEBHOOK_SECRET missing' });
  }
  if (!incomingSecret) {
    return res.status(401).json({ success: false, error: 'missing_webhook_secret' });
  }
  if (String(incomingSecret).trim() !== String(WEBHOOK_SECRET).trim()) {
    return res.status(401).json({ success: false, error: 'invalid_webhook_secret' });
  }
  return null; // ok
}

// ===== Routes =====
app.get('/', (_req, res) => res.send('✅ FZB-24 VIN Report API läuft'));

app.get('/api/version', (_req, res) => {
  res.json({
    ok: true,
    build: process.env.RENDER_GIT_COMMIT || 'ok build',
  });
});

// Debug: Header & Body prüfen (hilft extrem bei Wix/Render)
app.post('/api/_debug/echo', (req, res) => {
  const authErr = requireWebhookSecret(req, res);
  if (authErr) return; // response already sent

  res.json({
    ok: true,
    headers: req.headers,
    body: req.body,
  });
});

app.get('/api/report/:vin', async (req, res) => {
  try {
    const built = await buildPreviewReport(req.params.vin);
    if (!built.ok) return res.status(502).json({ success: false, ...built });

    return res.status(200).json({
      success: true,
      preview: built.preview,
      preview_note: 'Vorschau: Es werden nur Basisdaten angezeigt. Premium-Bericht enthält zusätzliche Prüfungen und Details.',
      locked_sections: [
        { title: 'Diebstahlcheck (EU)', hint: 'Prüfung über mehrere EU-Datenbanken (Details im PDF).' },
        { title: 'Marktwert', hint: 'Marktwert-Indikator (wenn ausreichende Marktdaten vorhanden).' },
        { title: 'Technische Daten', hint: 'Maße, Gewicht, Bremsen, Lenkung, Räder, CO₂ u.v.m.' },
        { title: 'Hinweise & Datenquellen', hint: 'Transparente Erklärung, was geprüft wurde und was nicht.' },
      ],
    });
  } catch (err) {
    console.error('❌ Fehler /api/report:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

app.get('/api/premium-report/:vin', async (req, res) => {
  try {
    const built = await buildPremiumReport(req.params.vin, null);
    if (!built.ok) return res.status(502).json({ success: false, ...built });
    return res.status(200).json({ success: true, report: built.report });
  } catch (err) {
    console.error('❌ Fehler /api/premium-report:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

// ===== Wix → after payment =====
// Erwartet: Webhook Secret + Wix payload
// Extrahiert: email, vin, purchaseFlowId (optional)
// Baut Report + PDF + schickt Mail (kein Download-Link)
app.post('/api/order-from-wix', async (req, res) => {
  try {
    const authErr = requireWebhookSecret(req, res);
    if (authErr) return;

    const body = req.body || {};

    const purchaseFlowId = extractPurchaseFlowId(body) || 'unknown';
    const email = extractEmailFromWixPayload(body);
    const vinRaw = extractVinFromWixPayload(body);
    const vin = sanitizeVin(vinRaw);

    if (DEBUG) {
      console.log('🧾 Wix webhook received', {
        purchaseFlowId,
        email,
        vin,
      });
    }

    if (!email) {
      return res.status(400).json({ success: false, error: 'missing_email', details: 'Could not extract email from Wix payload' });
    }
    if (!vin || vin.length < 11) {
      return res.status(400).json({ success: false, error: 'missing_vin', details: 'Could not extract VIN/FIN from Wix payload' });
    }

    // 1) Build Premium Report
    const built = await buildPremiumReport(vin, email);
    if (!built.ok) return res.status(502).json({ success: false, ...built });

    const report = built.report;
    const html = renderReportHtml(report);

    // 2) PDF
    let pdfBuffer = null;
    if (PDF_ENABLED) {
      pdfBuffer = await renderPdfBuffer(html);
    } else {
      return res.status(500).json({ success: false, error: 'pdf_disabled', details: 'Set PDF_ENABLED=true' });
    }

    // 3) Email (PDF attachment)
    if (EMAIL_ENABLED) {
      await sendReportEmail({
        to: email,
        vin: report.vin,
        reportId: report.report_id,
        pdfBuffer,
      });
    } else {
      return res.status(500).json({ success: false, error: 'email_disabled', details: 'Set EMAIL_ENABLED=true' });
    }

    // Wichtig: Wix Automation erwartet nur "ok", wir geben sauber JSON zurück
    return res.status(200).json({
      success: true,
      status: 'sent',
      purchaseFlowId,
      email,
      vin: report.vin,
      reportId: report.report_id,
      message: 'PDF erstellt und per E-Mail versendet.',
    });
  } catch (err) {
    console.error('❌ Fehler /api/order-from-wix:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
