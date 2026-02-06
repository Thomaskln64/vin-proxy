require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ====================== ENV ======================
const PORT = process.env.PORT || 3001;

const API_VERSION = '3.2';
const VINCARIO_BASE_URL = `https://api.vincario.com/${API_VERSION}`;
const VINCARIO_API_KEY = process.env.VINCARIO_API_KEY;
const VINCARIO_SECRET_KEY = process.env.VINCARIO_SECRET_KEY;

const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

// Render hat oft RENDER_EXTERNAL_URL (Host ohne https://)
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || '';
const FALLBACK_PUBLIC =
  RENDER_EXTERNAL_URL
    ? `https://${RENDER_EXTERNAL_URL}`
    : `http://127.0.0.1:${PORT}`;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || FALLBACK_PUBLIC;

// PDF / Email
const PDF_ENABLED = (process.env.PDF_ENABLED || 'true').toLowerCase() === 'true';
const EMAIL_ENABLED = (process.env.EMAIL_ENABLED || 'true').toLowerCase() === 'true';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = (process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER; // z.B. fzb24.info@gmail.com
const SMTP_PASS = process.env.SMTP_PASS; // Google App Password
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `FZB-24 <${SMTP_USER}>` : 'FZB-24');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || SMTP_USER;

// Webhook security (kommt aus .env)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Render prod detection
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase() === 'production' ||
  (process.env.RENDER || '').toLowerCase() === 'true';

if (!VINCARIO_API_KEY || !VINCARIO_SECRET_KEY) {
  console.error('❌ Missing VINCARIO_API_KEY or VINCARIO_SECRET_KEY in env');
  // Wenn du gerade ohne Vincario testest: kommentier das aus.
  process.exit(1);
}

if (EMAIL_ENABLED) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('❌ EMAIL_ENABLED=true but SMTP_USER/SMTP_PASS missing');
    process.exit(1);
  }
}

// Render: nutze /tmp (stabil)
const REPORTS_DIR = path.join('/tmp', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ====================== UTIL ======================
function log(...args) {
  if (DEBUG) console.log(...args);
}

function sanitizeVin(vin) {
  return String(vin || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 25);
}

function isLikelyVin(v) {
  const s = sanitizeVin(v);
  // VIN ist normalerweise 17 Zeichen (ohne I,O,Q), aber wir sind tolerant:
  return s.length >= 11 && s.length <= 17;
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
  const hit = decodeArr.find(d => d.label === label);
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
  log('🔗 Vincario:', url);
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
  const anyStolen = rows.some(r => String(r.status).toLowerCase() === 'stolen');
  return {
    available: true,
    status: anyStolen ? 'stolen' : 'not-stolen',
    details: rows.map(r => ({ source: r.code, status: r.status }))
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
  return crypto.createHash('sha1').update(`${vin}|${day}`).digest('hex').substring(0, 10).toUpperCase();
}

function safeJson(obj, maxLen = 4000) {
  let s = '';
  try {
    s = JSON.stringify(obj, null, 2);
  } catch {
    s = String(obj);
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + '\n…(gekürzt)…';
  return s;
}

// ====================== EMAIL ======================
let mailer = null;

function getMailer() {
  if (!EMAIL_ENABLED) return null;
  if (mailer) return mailer;

  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  return mailer;
}

async function sendMail({ to, subject, text, html, attachments = [] }) {
  if (!EMAIL_ENABLED) return { skipped: true };

  const transporter = getMailer();
  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    html,
    attachments
  });

  return info;
}

// ====================== REPORT BUILDERS ======================
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
        body: pick(d, 'Body') || null
      }
    }
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
      suspension: pick(d, 'Suspension') || null
    },
    checks: {
      stolen: stolenR.ok ? summarizeStolen(stolenR.json) : { available: false, status: 'unavailable' },
      market_value: valueR.ok ? summarizeMarketValue(valueR.json) : { available: false, reason: 'unavailable' }
    },
    vin_decode_raw: stripInternalFields(decodeR.json),
    generated_at: new Date().toISOString(),
    disclaimer:
      'Informationsbericht auf Basis verfügbarer Datenquellen. Keine Garantie für Vollständigkeit, Richtigkeit oder tatsächlichen Zustand des Fahrzeugs.'
  };

  return { ok: true, report };
}

// ====================== HTML REPORT ======================
function renderReportHtml(report) {
  const v = report.vehicle || {};
  const stolenStatus = report.checks?.stolen?.status || 'unknown';
  const market = report.checks?.market_value;

  let verdict = { label: 'Hinweis', color: 'warn', text: 'Keine vollständige Historie verfügbar. Bericht dient zur Orientierung.' };
  if (stolenStatus === 'not-stolen') verdict = { label: 'OK', color: 'ok', text: 'Kein Treffer im EU-Diebstahlcheck gefunden.' };
  if (stolenStatus === 'stolen') verdict = { label: 'Achtung', color: 'bad', text: 'Treffer im Diebstahlcheck. Bitte unbedingt prüfen.' };

  const title = `${v.make || ''} ${v.model || ''} (${v.year || '—'})`.trim();
  const marketText = market?.available ? 'Verfügbar' : `Nicht verfügbar (${market?.reason || 'keine Daten'})`;

  const stolenDetailsRows = (report.checks?.stolen?.details || [])
    .map(r => `<tr><td>${escapeHtml(r.source)}</td><td>${escapeHtml(r.status)}</td></tr>`)
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
  .topline:before{content:"";position:absolute;left:0;top:0;bottom:0;width:12px;background:var(--brandRed);}
  .h1{font-size:20px;font-weight:950;margin:0 0 4px 0}
  .meta{color:#e2e8f0;opacity:.95;font-size:12px}
  .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:12px}
  .twoCol{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .box{border:1px solid var(--line);border-radius:14px;padding:12px;background:#fff}
  .secH{font-size:13px;font-weight:950;margin:0 0 8px 0;color:var(--text);padding-left:10px;border-left:4px solid var(--brandRed);}
  .para{color:var(--muted);font-size:12px;line-height:1.6}
  .pill{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:14px;padding:10px 12px;background:#fff;margin-bottom:10px}
  .dot{width:10px;height:10px;border-radius:50%;margin-top:4px}
  .dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.bad{background:var(--bad)}
  .small{color:var(--muted);font-size:12px;line-height:1.5}
  .table{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:14px;border:1px solid rgba(15,23,42,.14);margin-top:8px;}
  .table th,.table td{padding:10px 12px;border-bottom:1px solid rgba(15,23,42,.08);font-size:12px;color:var(--text);background:#fff;}
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

// ====================== PDF RENDER ======================
async function renderPdfToFile(html, outPath) {
  const browser = await puppeteer.launch({
    headless: IS_PROD ? chromium.headless : 'new',
    executablePath: IS_PROD ? await chromium.executablePath() : undefined,
    args: IS_PROD ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: IS_PROD ? chromium.defaultViewport : { width: 1280, height: 720 }
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });
  } finally {
    await browser.close();
  }
}

// ====================== WIX PAYLOAD PARSER ======================

// Payload kann 2 Hauptformen haben:
// A) { data: { order: {...}, contact: {...} } }  (oft "payment added")
// B) { data: { lineItems: [...], checkoutCustomFields: {...}, buyerEmail: "...", purchaseFlowId: "..." } } (oft "order placed")
function extractOrderFromWixPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // 1) häufig: payload.order
  if (payload.order && typeof payload.order === 'object') return payload.order;

  // 2) häufig: payload.data.order
  if (payload.data?.order && typeof payload.data.order === 'object') return payload.data.order;

  // 3) falls kein order-Objekt vorhanden ist, aber data enthält order-like Felder:
  if (payload.data && typeof payload.data === 'object') {
    const d = payload.data;

    const looksOrderish =
      d.purchaseFlowId || d.purchase_flow_id || d.orderNumber || d.order_number || Array.isArray(d.lineItems) || Array.isArray(d.line_items);

    if (looksOrderish) {
      // “synthetic order” bauen, damit unser Code überall gleich ist
      return {
        purchaseFlowId: d.purchaseFlowId || d.purchase_flow_id || null,
        number: d.orderNumber || d.order_number || null,
        buyerInfo: d.buyerInfo || (d.buyerEmail ? { email: d.buyerEmail } : undefined),
        lineItems: d.lineItems || d.line_items || [],
        extendedFields: d.extendedFields || d.extended_fields,
        checkoutCustomFields: d.checkoutCustomFields || d.checkout_custom_fields,
        customFields: d.customFields || d.custom_fields,
        customTextFields: d.customTextFields || d.custom_text_fields
      };
    }
  }

  // 4) manchmal: payload.body.order
  if (payload.body?.order && typeof payload.body.order === 'object') return payload.body.order;

  return null;
}

function extractPurchaseFlowId(payload, order) {
  return (
    payload?.purchaseFlowId ||
    payload?.purchase_flow_id ||
    payload?.data?.purchaseFlowId ||
    payload?.data?.purchase_flow_id ||
    order?.purchaseFlowId ||
    order?.id ||
    payload?.orderId ||
    payload?.data?.orderId ||
    payload?.data?.id ||
    null
  );
}

function extractEmailFromPayload(order, payload) {
  // möglichst viele Stellen abklappern
  const e =
    order?.buyerInfo?.email ||
    order?.buyer_info?.email ||
    order?.buyerEmail ||
    payload?.data?.buyerEmail ||
    payload?.data?.buyer_email ||
    payload?.data?.contact?.email ||
    payload?.contact?.email ||
    payload?.data?.billingInfo?.address?.email ||
    payload?.data?.shippingInfo?.address?.email ||
    payload?.data?.billingInfo?.contactDetails?.email ||
    payload?.data?.email ||
    payload?.email ||
    null;

  return e ? String(e).trim() : null;
}

// ✅ DAS ist die entscheidende Funktion: VIN aus ALLEN realistischen Wix-Stellen ziehen
function extractVinFromOrder(order, payload) {
  if (!order) return null;

  // Helper: aus object-values eine VIN ziehen
  const scanObjectForVin = (obj) => {
    if (!obj || typeof obj !== 'object') return null;

    // 1) keys, die nach FIN/VIN aussehen
    for (const [k, v] of Object.entries(obj)) {
      if (!v) continue;
      const key = String(k).toLowerCase();
      const val = String(v).trim();

      const keyHits = ['vin', 'fin', 'fahrgestell', 'fahrgestellnummer', 'vehicle identification', 'vehicle id'];
      if (keyHits.some(h => key.includes(h)) && isLikelyVin(val)) return sanitizeVin(val);

      // 2) Notfall: value sieht wie VIN aus
      if (isLikelyVin(val)) return sanitizeVin(val);
    }

    return null;
  };

  // 0) Wix Custom Checkout Feld landet bei dir oft hier:
  // order.extendedFields.namespaces._user_fields.{fahrgestellnummer_fin_1: "..."}
  const userFields =
    order?.extendedFields?.namespaces?._user_fields ||
    order?.extended_fields?.namespaces?._user_fields ||
    null;

  const fromUserFields = scanObjectForVin(userFields);
  if (fromUserFields) return fromUserFields;

  // 0b) Manche Payloads liefern checkoutCustomFields (kann leer sein, aber wenn nicht, dann hier)
  const ccf =
    order?.checkoutCustomFields ||
    order?.checkout_custom_fields ||
    payload?.data?.checkoutCustomFields ||
    payload?.data?.checkout_custom_fields ||
    null;

  // checkoutCustomFields kann z.B. { fahrgestellnummer_fin_1: "WBA..." } sein
  const fromCheckoutCustom = scanObjectForVin(ccf);
  if (fromCheckoutCustom) return fromCheckoutCustom;

  // 1) lineItems[].customTextFields[] (falls du das mal nutzt)
  const lineItems = order.lineItems || order.line_items || payload?.data?.lineItems || payload?.data?.line_items || [];
  for (const li of lineItems) {
    const ctf = li.customTextFields || li.custom_text_fields || li.customTextField || [];
    if (Array.isArray(ctf)) {
      for (const f of ctf) {
        const title = String(f?.title || f?.name || '').toLowerCase();
        const value = f?.value;
        if (!value) continue;

        const hits = ['fin', 'vin', 'fahrgestell', 'fahrgestellnummer', 'vehicle identification', 'vehicle id'];
        if (hits.some(h => title.includes(h)) && isLikelyVin(value)) return sanitizeVin(value);

        if (isLikelyVin(value)) return sanitizeVin(value);
      }
    }
  }

  // 2) fallback: order.customFields / customTextFields
  const any = order.customFields || order.customTextFields || order.custom_fields || order.custom_text_fields || [];
  if (Array.isArray(any)) {
    for (const f of any) {
      const title = String(f?.title || f?.name || '').toLowerCase();
      const value = f?.value;
      if (!value) continue;

      const hits = ['fin', 'vin', 'fahrgestell', 'fahrgestellnummer'];
      if (hits.some(h => title.includes(h)) && isLikelyVin(value)) return sanitizeVin(value);

      if (isLikelyVin(value)) return sanitizeVin(value);
    }
  }

  // 3) letzter Notfall: payload.data direkt scannen (wenn Wix wieder anders liefert)
  const deep = scanObjectForVin(payload?.data);
  if (deep) return deep;

  return null;
}

// ====================== SECURITY + IDEMPOTENCY ======================

// Wix kann oft keine Custom Header setzen → wir erlauben ?secret=...
function getIncomingSecret(req) {
  const h = req.headers['x-webhook-secret'];
  const q = req.query?.secret;
  return (h || q || '').toString();
}

function checkWebhookAuth(req) {
  if (!WEBHOOK_SECRET) return true; // wenn bewusst leer (nicht empfohlen)
  return getIncomingSecret(req) === WEBHOOK_SECRET;
}

// Doppeltrigger verhindern
const processed = new Map(); // key -> expiresAt
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function wasProcessed(key) {
  const exp = processed.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    processed.delete(key);
    return false;
  }
  return true;
}

function markProcessed(key) {
  processed.set(key, Date.now() + DEDUPE_TTL_MS);
}

// ====================== ROUTES ======================

app.get('/', (_req, res) => res.send('✅ FZB-24 VIN Report API läuft'));

app.get('/api/version', (_req, res) => {
  const build =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    crypto.createHash('sha1').update(String(Date.now())).digest('hex');

  res.json({ ok: true, build });
});

// Debug-Echo
app.post('/api/_debug/echo', (req, res) => {
  if (!checkWebhookAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.json({ ok: true, headers: req.headers, body: req.body });
});

// Preview endpoint
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
        { title: 'Hinweise & Datenquellen', hint: 'Transparente Erklärung, was geprüft wurde und was nicht.' }
      ]
    });
  } catch (err) {
    console.error('❌ Fehler /api/report:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

// Premium JSON endpoint
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

// ✅ WIX WEBHOOK: Payment Added to Order -> PDF + Email
app.post('/api/order-from-wix', async (req, res) => {
  const start = Date.now();

  try {
    // 1) Auth
    if (!checkWebhookAuth(req)) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    const payload = req.body || {};
    const order = extractOrderFromWixPayload(payload);

    const purchaseFlowId =
      extractPurchaseFlowId(payload, order) ||
      `unknown_${crypto.randomBytes(6).toString('hex')}`;

    // 2) Dedupe
    if (wasProcessed(purchaseFlowId)) {
      return res.status(200).json({
        success: true,
        status: 'duplicate_ignored',
        purchaseFlowId,
        message: 'Webhook bereits verarbeitet (Dedupe).'
      });
    }

    const email = extractEmailFromPayload(order, payload);
    const vinRaw = extractVinFromOrder(order, payload);
    const vin = vinRaw ? sanitizeVin(vinRaw) : '';

    log('📦 Incoming purchaseFlowId:', purchaseFlowId);
    log('📧 email:', email);
    log('🚗 vin:', vin);

    // 3) Safety: wenn VIN oder Email fehlt -> Admin Mail statt Kunde leer ausgehen lassen
    if (!email || !vin || vin.length < 11) {
      markProcessed(purchaseFlowId); // markieren, sonst spammt Wix

      const subject = `FZB-24 ALERT: Bestellung ohne VIN/Email (${purchaseFlowId})`;
      const body =
        `Es kam ein Wix Payment-Webhook rein, aber VIN oder Email war leer/ungültig.\n\n` +
        `purchaseFlowId: ${purchaseFlowId}\n` +
        `email: ${email || '—'}\n` +
        `vin: ${vin || '—'}\n\n` +
        `Payload (gekürzt):\n${safeJson(payload, 8000)}\n`;

      try {
        await sendMail({
          to: ADMIN_EMAIL,
          subject,
          text: body
        });
      } catch (mailErr) {
        console.error('❌ Admin-Mail konnte nicht gesendet werden:', mailErr);
      }

      return res.status(200).json({
        success: true,
        status: 'needs_manual_check',
        purchaseFlowId,
        email,
        vin,
        message: 'VIN/Email fehlte. Admin wurde informiert.'
      });
    }

    // 4) Bericht bauen
    const built = await buildPremiumReport(vin, email);
    if (!built.ok) {
      markProcessed(purchaseFlowId);

      // Admin informieren
      await sendMail({
        to: ADMIN_EMAIL,
        subject: `FZB-24 ALERT: Vincario Fehler (${purchaseFlowId})`,
        text:
          `Vincario/Report build ist fehlgeschlagen.\n\n` +
          `purchaseFlowId: ${purchaseFlowId}\n` +
          `email: ${email}\n` +
          `vin: ${vin}\n\n` +
          `Fehler: ${built.error}\n` +
          `Status: ${built.status}\n` +
          `Raw: ${built.raw || '—'}\n`
      });

      return res.status(502).json({ success: false, ...built });
    }

    const report = built.report;

    // 5) PDF rendern
    if (!PDF_ENABLED) {
      markProcessed(purchaseFlowId);

      await sendMail({
        to: ADMIN_EMAIL,
        subject: `FZB-24 INFO: PDF_ENABLED=false (${purchaseFlowId})`,
        text: `PDF ist deaktiviert. Bestellung kann nicht ausgeliefert werden.\nVIN: ${vin}\nEmail: ${email}\n`
      });

      return res.status(200).json({
        success: true,
        status: 'pdf_disabled',
        purchaseFlowId,
        email,
        vin
      });
    }

    const html = renderReportHtml(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `FZB24_${vin}_${stamp}.pdf`;
    const filePath = path.join(REPORTS_DIR, fileName);

    await renderPdfToFile(html, filePath);

    // 6) Kunden-Mail + Anhang (normaler Text wie du wolltest)
    const mailSubject = `Dein FZB-24 Fahrzeugbericht (${vin})`;
    const mailText =
      `Hallo,\n\n` +
      `anbei findest du deinen Fahrzeugbericht als PDF.\n\n` +
      `VIN: ${vin}\n` +
      `Report-ID: ${report.report_id}\n\n` +
      `Hinweis: ${report.disclaimer}\n\n` +
      `Viele Grüße\n` +
      `FZB-24`;

    await sendMail({
      to: email,
      subject: mailSubject,
      text: mailText,
      attachments: [
        {
          filename: `FZB24_Report_${vin}.pdf`,
          path: filePath
        }
      ]
    });

    // 7) Aufräumen
    try { fs.unlinkSync(filePath); } catch {}

    // 8) Dedupe markieren
    markProcessed(purchaseFlowId);

    const ms = Date.now() - start;
    return res.status(200).json({
      success: true,
      status: 'sent',
      purchaseFlowId,
      email,
      vin,
      reportId: report.report_id,
      message: 'PDF erstellt und per E-Mail versendet.',
      tookMs: ms
    });
  } catch (err) {
    console.error('❌ Fehler /api/order-from-wix:', err);

    // Admin informieren
    try {
      await sendMail({
        to: ADMIN_EMAIL,
        subject: 'FZB-24 ALERT: Server Fehler bei order-from-wix',
        text: `Server error:\n${err?.stack || err?.message || String(err)}`
      });
    } catch {}

    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf ${PUBLIC_BASE_URL}`);
  console.log(`✅ EMAIL_ENABLED=${EMAIL_ENABLED} SMTP=${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}`);
});
