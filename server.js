require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3001;

const API_VERSION = '3.2';
const VINCARIO_BASE_URL = `https://api.vincario.com/${API_VERSION}`;

const VINCARIO_API_KEY = process.env.VINCARIO_API_KEY;
const VINCARIO_SECRET_KEY = process.env.VINCARIO_SECRET_KEY;

const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;

const REPORTS_DIR = path.join(__dirname, 'reports');
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Render erkennt man oft über NODE_ENV=production, alternativ kannst du RENDER=true setzen
const IS_PROD =
  (process.env.NODE_ENV || '').toLowerCase() === 'production' ||
  (process.env.RENDER || '').toLowerCase() === 'true';

if (!VINCARIO_API_KEY || !VINCARIO_SECRET_KEY) {
  console.error('❌ Missing VINCARIO_API_KEY or VINCARIO_SECRET_KEY in .env');
  process.exit(1);
}

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// ===== In-memory download store =====
const downloadStore = new Map();

function putDownload(token, filePath, meta = {}) {
  downloadStore.set(token, { filePath, meta, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
}

function getDownload(token) {
  const item = downloadStore.get(token);
  if (!item) return null;

  if (Date.now() > item.expiresAt) {
    downloadStore.delete(token);
    return null;
  }
  return item;
}

// ===== Paid store (persisted) =====
// Speichert purchaseFlowId -> { email, paidAt }
const PAID_STORE_FILE = path.join(REPORTS_DIR, 'paid-store.json');
let paidStore = {};

function loadPaidStore() {
  try {
    if (!fs.existsSync(PAID_STORE_FILE)) {
      paidStore = {};
      return;
    }
    const raw = fs.readFileSync(PAID_STORE_FILE, 'utf8');
    paidStore = JSON.parse(raw || '{}') || {};
  } catch (e) {
    console.error('❌ paid-store load failed:', e);
    paidStore = {};
  }
}

function savePaidStore() {
  try {
    fs.writeFileSync(PAID_STORE_FILE, JSON.stringify(paidStore, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ paid-store save failed:', e);
  }
}

function markPaid(purchaseFlowId, email) {
  const id = String(purchaseFlowId || '').trim();
  if (!id) return;
  paidStore[id] = { email: String(email || '').trim().toLowerCase(), paidAt: new Date().toISOString() };
  savePaidStore();
}

function isPaid(purchaseFlowId, email) {
  const id = String(purchaseFlowId || '').trim();
  if (!id) return false;
  const rec = paidStore[id];
  if (!rec) return false;

  // wenn email mitgegeben wird, matchen wir sie
  if (email) {
    const e = String(email || '').trim().toLowerCase();
    if (rec.email && e && rec.email !== e) return false;
  }
  return true;
}

loadPaidStore();

// ===== Helpers =====
function sanitizeVin(vin) {
  return String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 25);
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
      'Informationsbericht auf Basis verfügbarer Datenquellen. Keine Garantie für Vollständigkeit oder Unfallfreiheit.'
  };

  return { ok: true, report };
}

// ===== HTML Report (multi-page) =====
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
    padding-left:10px;
    border-left:4px solid var(--brandRed);
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
  .table th{
    background:var(--soft);text-align:left;
  }
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

// ===== PDF Renderer =====
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

// ===== Routes =====
app.get('/', (_req, res) => res.send('✅ FZB-24 VIN Report API läuft'));

app.get('/api/version', (_req, res) => {
  res.json({ ok: true, build: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown' });
});

app.get('/download/:token', (req, res) => {
  const item = getDownload(req.params.token);
  if (!item) return res.status(404).send('Link abgelaufen oder nicht gefunden.');
  return res.download(item.filePath);
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
        { title: 'Hinweise & Datenquellen', hint: 'Transparente Erklärung, was geprüft wurde und was nicht.' }
      ]
    });
  } catch (err) {
    console.error('❌ Fehler /api/report:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

// (Optional) direkt Premium JSON
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

// ALT (hat früher direkt PDF erstellt; lassen wir drin für Debug, aber NICHT mehr als finaler Checkout-Flow)
app.post('/api/order', async (req, res) => {
  try {
    const { vin, email } = req.body || {};
    if (!vin || typeof vin !== 'string') return res.status(400).json({ success: false, error: 'missing_vin' });
    if (!email || typeof email !== 'string') return res.status(400).json({ success: false, error: 'missing_email' });

    const built = await buildPremiumReport(vin, email);
    if (!built.ok) return res.status(502).json({ success: false, ...built });

    const report = built.report;
    const html = renderReportHtml(report);

    const safeVin = sanitizeVin(report.vin);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `FZB24_${safeVin}_${stamp}.pdf`;
    const filePath = path.join(REPORTS_DIR, fileName);

    await renderPdfToFile(html, filePath);

    const token = crypto.randomBytes(16).toString('hex');
    putDownload(token, filePath, { vin: report.vin, email });

    return res.status(200).json({
      success: true,
      status: 'done',
      message: 'Danke! Dein Bericht wurde erstellt.',
      download_url: `${PUBLIC_BASE_URL}/download/${token}`
    });
  } catch (err) {
    console.error('❌ Fehler /api/order:', err);
    return res.status(500).json({ success: false, error: 'server_error', details: err.message });
  }
});

// ✅ 1) Wix Automation Endpoint: markiert Zahlung als eingegangen
app.post('/api/order-from-wix', (req, res) => {
  try {
    const body = req.body || {};
    const purchaseFlowId = String(body.purchaseFlowId || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const vin = body.vin ? sanitizeVin(body.vin) : '';

    if (!purchaseFlowId) {
      return res.status(400).json({ success: false, error: 'missing_purchaseFlowId' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'missing_email' });
    }

    // Zahlung merken (persistiert)
    markPaid(purchaseFlowId, email);

    return res.status(200).json({
      success: true,
      received: { purchaseFlowId, email, vin: vin || null },
      next: 'Now call /api/fulfill with purchaseFlowId + vin + email (from thank-you page)'
    });
  } catch (e) {
    console.error('❌ /api/order-from-wix error:', e);
    return res.status(500).json({ success: false, error: 'server_error', details: e.message });
  }
});

// ✅ 2) Danke-Seite Endpoint: erstellt PDF nur wenn Zahlung vorhanden ist
app.post('/api/fulfill', async (req, res) => {
  try {
    const { purchaseFlowId, vin, email } = req.body || {};
    const pf = String(purchaseFlowId || '').trim();
    const v = sanitizeVin(vin);
    const em = String(email || '').trim().toLowerCase();

    if (!pf) return res.status(400).json({ success: false, error: 'missing_purchaseFlowId' });
    if (!v || v.length < 11) return res.status(400).json({ success: false, error: 'missing_or_invalid_vin' });
    if (!em || !em.includes('@')) return res.status(400).json({ success: false, error: 'missing_email' });

    // Payment check
    if (!isPaid(pf, em)) {
      return res.status(403).json({
        success: false,
        error: 'not_paid',
        message: 'Zahlung noch nicht bestätigt. Bitte 10-30 Sekunden warten und Seite neu laden.'
      });
    }

    // Report bauen + PDF erzeugen
    const built = await buildPremiumReport(v, em);
    if (!built.ok) return res.status(502).json({ success: false, ...built });

    const report = built.report;
    const html = renderReportHtml(report);

    const safeVin = sanitizeVin(report.vin);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `FZB24_${safeVin}_${stamp}.pdf`;
    const filePath = path.join(REPORTS_DIR, fileName);

    await renderPdfToFile(html, filePath);

    const token = crypto.randomBytes(16).toString('hex');
    putDownload(token, filePath, { vin: report.vin, email: em, purchaseFlowId: pf });

    return res.status(200).json({
      success: true,
      status: 'done',
      message: 'Bericht erstellt.',
      download_url: `${PUBLIC_BASE_URL}/download/${token}`
    });
  } catch (e) {
    console.error('❌ /api/fulfill error:', e);
    return res.status(500).json({ success: false, error: 'server_error', details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server läuft auf ${PUBLIC_BASE_URL}`);
});
