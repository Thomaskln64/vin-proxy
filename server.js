require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === ENV Variablen ===
// (lokal in .env setzen, auf Render unter Environment Variables)
const VINCARIO_API_KEY    = process.env.VINCARIO_API_KEY    || '31f6470bb229';
const VINCARIO_SECRET_KEY = process.env.VINCARIO_SECRET_KEY || 'c0a6b79245';
const PLACID_API_TOKEN    = process.env.PLACID_API_TOKEN    || 'placid-d4mczymmasy4sves-ftjp64aixchplncb';
const PLACID_TEMPLATE_ID  = process.env.PLACID_TEMPLATE_ID  || 'ms9dibqnbjji7';
const API_VERSION = '3.2';
const DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

app.use(cors());
app.use(express.json());

// Health-Check
app.get('/', (_req, res) => {
  res.send('✅ FZB-24 VIN Report API läuft');
});

// Helpers
function pick(decodeArr, label) {
  if (!Array.isArray(decodeArr)) return undefined;
  const hit = decodeArr.find(d => d.label === label);
  return hit ? hit.value : undefined;
}

async function postJson(url, body, headers = {}) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

async function getJson(url, headers = {}) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(url, { headers });
  const text = await resp.text(); // robust: erst text, dann versuchen JSON
  let json = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  return { ok: resp.ok, status: resp.status, json, rawText: text };
}

function extractUrl(any) {
  return (
    any?.url ||
    any?.file ||
    any?.data?.url ||
    (Array.isArray(any?.files) && any.files[0]?.url) ||
    (Array.isArray(any?.pages) && any.pages[0]?.url) ||
    null
  );
}

function extractRenderId(any) {
  return any?.id || any?.uuid || any?.render_uuid || any?.data?.id || null;
}

/** Placid-Render: anstoßen + bis 30s pollen */
async function renderPlacidPDF(layers) {
  // Start
  const start = await postJson(
    'https://api.placid.app/api/rest/pdfs',
    { pages: [{ template_uuid: PLACID_TEMPLATE_ID, layers }] },
    { Authorization: `Bearer ${PLACID_API_TOKEN}` }
  );
  if (DEBUG) console.log('📤 Placid start:', start);

  // Direkte URL?
  const directUrl = extractUrl(start.json);
  if (directUrl) return { url: directUrl, raw: start.json };

  // Render-ID?
  const renderId = extractRenderId(start.json);
  if (!renderId) {
    return { url: null, raw: start.json, reason: 'No URL or render ID in initial response' };
  }

  // Polling
  const maxTries = 15; // 15 * 2s = 30s
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await getJson(
      `https://api.placid.app/api/rest/renders/${renderId}`,
      { Authorization: `Bearer ${PLACID_API_TOKEN}` }
    );
    last = status.json;
    if (DEBUG) console.log(`⏳ Placid poll ${i + 1}/${maxTries}:`, last);

    const url = extractUrl(last);
    if (url) return { url, raw: last };

    const st = String(last?.status || '').toLowerCase();
    if (st === 'failed' || st === 'error') {
      return { url: null, raw: last, reason: 'Render failed' };
    }
  }
  return { url: null, raw: last, reason: 'Render still processing after timeout' };
}

/**
 * JSON-Route:
 * /api/report/:vin  → gibt JSON zurück (inkl. pdf_url)
 */
app.get('/api/report/:vin', async (req, res) => {
  try {
    const vin = req.params.vin.toUpperCase();
    const action = 'decode';

    // Vincario: Kontrollsumme
    const hashString = `${vin}|${action}|${VINCARIO_API_KEY}|${VINCARIO_SECRET_KEY}`;
    const controlSum  = crypto.createHash('sha1').update(hashString).digest('hex').substring(0, 10);

    const vinUrl = `https://api.vindecoder.eu/${API_VERSION}/${VINCARIO_API_KEY}/${controlSum}/${action}/${vin}.json`;
    if (DEBUG) console.log('🔗 VIN API:', vinUrl);

    const vinResp = await getJson(vinUrl);
    if (!vinResp.ok) {
      return res.status(502).json({ error: 'VIN API error', status: vinResp.status, raw: vinResp.rawText });
    }
    const vinData = vinResp.json;
    if (!vinData || !vinData.decode) {
      return res.status(502).json({ error: 'VIN API returned no decode data', vinData });
    }

    // Layer befüllen (müssen exakt zu deinen Placid-Layern passen)
    const d = vinData.decode;
    const layers = {
      make:         { text: pick(d, 'Make') || '—' },
      model:        { text: pick(d, 'Model') || '—' },
      year:         { text: pick(d, 'Production Year') || pick(d, 'Model Year') || '—' },
      ps:           { text: String(pick(d, 'Engine Power (HP)') ?? '—') },
      vin:          { text: vin },

      fuel:         { text: pick(d, 'Fuel Type - Primary') || '—' },
      transmission: { text: pick(d, 'Transmission') || '—' },
      consumption:  { text: String(pick(d, 'Fuel Consumption Combined (l/100km)') ?? '—') },
      co2:          { text: String(pick(d, 'CO2 Emission (g/km)') ?? '—') },

      marketPrice:  { text: '—' }, // später Market Value API
      priceRange:   { text: '—' }, // später
      stolen:       { text: 'Nicht gestohlen' }, // später Stolen Check API

      date:         { text: new Date().toLocaleDateString('de-DE') }
    };
    if (DEBUG) console.log('🧩 layers:', layers);

    // Placid rendern (mit Polling)
    const render = await renderPlacidPDF(layers);

    return res.status(render.url ? 200 : 202).json({
      success: !!render.url,
      pdf_url: render.url,
      vin_basic: { make: layers.make.text, model: layers.model.text, year: layers.year.text },
      placid: render.raw,
      note: render.url ? undefined : render.reason || 'Waiting / no direct URL'
    });

  } catch (err) {
    console.error('❌ Fehler /api/report:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

/**
 * Redirect-Route für Browser:
 * /report/pdf/:vin  → öffnet PDF direkt (oder zeigt "wird erstellt")
 */
app.get('/report/pdf/:vin', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const baseUrl = `http://localhost:${PORT}`; // lokal
    const vin = encodeURIComponent(req.params.vin);

    const r = await fetch(`${baseUrl}/api/report/${vin}`);
    const data = await r.json();

    if (data?.pdf_url) {
      return res.redirect(data.pdf_url);
    }

    return res.status(202).send(`
      <html>
        <body style="font-family:sans-serif">
          <h3>Bericht wird erstellt …</h3>
          <p>Bitte die Seite in 2–3 Sekunden neu laden.</p>
          <pre style="white-space:pre-wrap">${data?.note || 'Wird verarbeitet'}</pre>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('❌ Fehler /report/pdf:', e);
    res.status(500).send('Fehler beim Erstellen/Öffnen des PDFs');
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf http://localhost:${PORT}`);
});
