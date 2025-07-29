const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// === Deine API Keys ===
const API_KEY = "31f6470bb229";     // Dein API Key
const SECRET_KEY = "c0a6b79245";    // Dein Secret Key
const API_VERSION = "3.2";

app.use(cors());

// VIN Decode Endpoint
app.get("/api/vin/:vin", async (req, res) => {
    try {
        const vin = req.params.vin.toUpperCase();
        const action = "decode";

        // Control Sum korrekt berechnen mit Pipes
        const stringForHash = `${vin}|${action}|${API_KEY}|${SECRET_KEY}`;
        const fullHash = crypto.createHash("sha1").update(stringForHash).digest("hex");
        const controlSum = fullHash.substring(0, 10);

        // Debug Ausgabe
        console.log("===== DEBUG START =====");
        console.log("VIN:", vin);
        console.log("Action:", action);
        console.log("String für SHA1:", stringForHash);
        console.log("Full SHA1 Hash:", fullHash);
        console.log("Control Sum (erste 10 Zeichen):", controlSum);
        console.log("===== DEBUG ENDE =====");

        // API URL zusammenbauen
        const url = `https://api.vindecoder.eu/${API_VERSION}/${API_KEY}/${controlSum}/${action}/${vin}.json`;
        console.log("🔗 API URL:", url);

        // API Request ausführen
        const response = await fetch(url);
        const text = await response.text();

        // Prüfen ob Antwort JSON ist
        if (!text.trim().startsWith("{")) {
            console.error("❌ API gab keine JSON-Daten zurück!");
            return res.status(500).json({ error: "Invalid response from API", raw: text });
        }

        const data = JSON.parse(text);
        res.json(data);

    } catch (err) {
        console.error("❌ Fehler bei der API-Abfrage:", err.message);
        res.status(500).json({ error: "Fehler bei der Abfrage", details: err.message });
    }
});

// Server starten
app.listen(PORT, () => {
    console.log(`✅ VIN Decode API läuft auf http://localhost:${PORT}`);
});
