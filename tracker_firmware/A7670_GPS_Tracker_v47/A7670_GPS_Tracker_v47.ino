// ================================================
// LILYGO T-Call A7670 – GPS Tracker v47
// ggü. v46:
//   ✅ Debug-Output entfernt (Produktionsversion)
//
// Funktionsübersicht:
//   • MQTT über TCP zu broker.emqx.io:1883
//   • Adaptives Polling: Race 2s/30s, Training 10s/60s
//   • Modus-Wechsel via retained MQTT (livetracking-fq4l/config)
//   • A7670E pusht TCP-Daten direkt auf UART → direktes Serial-Lesen
//   • firstFixDone + fixConsecutive (2 stabile Reads vor erstem Send)
//   • mode-Feld nur beim ersten Send + nach Modus-Wechsel
// ================================================

#include <HardwareSerial.h>
#include <math.h>

// -----------------------------
// MQTT BROKER
// -----------------------------
const char* MQTT_HOST   = "broker.emqx.io";
const int   MQTT_PORT   = 1883;
const char* MQTT_TOPIC  = "livetracking-fq4l/positions";
const char* MQTT_CLIENT = "tcall1-esp32";
const char* DEVICE_ID   = "t1";

const char* MQTT_CONFIG = "livetracking-fq4l/config";

const char* APN = "web.vodafone.de";

#define TCP_LINK 0

// -----------------------------
// TRACKING-PARAMETER
// Werden zur Laufzeit per Modus-Wechsel angepasst
// -----------------------------
const float    MIN_MOVE_METERS     = 5.0;
const uint32_t INTERVAL_MOVING_MS  = 2000;   // Race-Default
const uint32_t INTERVAL_STOPPED_MS = 30000;  // Race-Default

uint32_t intervalMoving  = INTERVAL_MOVING_MS;
uint32_t intervalStopped = INTERVAL_STOPPED_MS;


// -----------------------------
// PINS
// -----------------------------
#define MODEM_TX      26
#define MODEM_RX      25
#define MODEM_PWRKEY  4

HardwareSerial modemSerial(1);

// -----------------------------
// STATE
// -----------------------------
float    lastLat        = 0, lastLon = 0;
uint32_t lastSendTime   = 0;
uint32_t gpsSearchStart = 0;
uint32_t lastModeCheck  = 0;
bool     firstFixDone   = false;        // Mode-Check erst nach erstem Fix
uint8_t  fixConsecutive = 0;            // Stabile Reads in Folge (min. 2 für echten Fix)
char     trackerMode[12] = "race";      // Aktueller Modus – wird im Payload mitgesendet
bool     modeChanged    = true;         // true = mode beim nächsten Send einmalig mitsenden
const uint32_t MODE_CHECK_MS = 30000;

// =================================================
// MODEM POWER ON
// =================================================
void modemPowerOn() {
  pinMode(MODEM_PWRKEY, OUTPUT);
  digitalWrite(MODEM_PWRKEY, HIGH); delay(300);
  digitalWrite(MODEM_PWRKEY, LOW);  delay(1200);
  digitalWrite(MODEM_PWRKEY, HIGH);
  Serial.println("⏳ Modem startet...");
  delay(5000);
}

// =================================================
// AT COMMAND
// =================================================
String sendAT(const char* cmd, int timeout = 3000, const char* waitFor = nullptr) {
  while (modemSerial.available()) modemSerial.read();
  if (strlen(cmd) > 0) modemSerial.println(cmd);
  unsigned long start = millis();
  String response = "";
  while (millis() - start < (unsigned long)timeout) {
    while (modemSerial.available()) {
      char c = modemSerial.read();
      response += c;
    }
    if (waitFor && response.indexOf(waitFor) >= 0) break;
    if (!waitFor && (response.indexOf("OK") >= 0 || response.indexOf("ERROR") >= 0)) break;
  }
  return response;
}

// =================================================
// MODEM INIT
// =================================================
bool isRegistered(const String& r, const char* tag) {
  return r.indexOf(String(tag) + " 0,1") >= 0 || r.indexOf(String(tag) + " 0,5") >= 0 ||
         r.indexOf(String(tag) + " 1,1") >= 0 || r.indexOf(String(tag) + " 1,5") >= 0 ||
         r.indexOf(String(tag) + " 2,1") >= 0 || r.indexOf(String(tag) + " 2,5") >= 0;
}

bool initModem() {
  bool alive = false;
  for (int i = 0; i < 15; i++) {
    if (sendAT("AT", 1000).indexOf("OK") >= 0) { alive = true; break; }
    delay(1000);
  }
  if (!alive) { Serial.println("⚠️ Modem antwortet nicht"); return false; }
  sendAT("ATE0");
  sendAT("AT+CMEE=2");
  Serial.print("⏳ Warte auf Netz-Registrierung");
  unsigned long start = millis();
  while (millis() - start < 90000) {
    String e = sendAT("AT+CEREG?", 2000);
    if (isRegistered(e, "+CEREG:")) { Serial.println("\n✅ Im Netz (LTE)"); return true; }
    String c = sendAT("AT+CREG?", 2000);
    if (isRegistered(c, "+CREG:"))  { Serial.println("\n✅ Im Netz"); return true; }
    Serial.print(".");
    delay(2000);
  }
  Serial.println("\n⚠️ Netz nicht registriert (Timeout 90s)");
  return false;
}

// =================================================
// PDP
// =================================================
bool activatePDP() {
  String apnCmd = String("AT+CGDCONT=1,\"IP\",\"") + APN + "\"";
  sendAT(apnCmd.c_str(), 3000, "OK");
  sendAT("AT+NETCLOSE", 5000, "OK");
  delay(1000);
  String r = sendAT("AT+NETOPEN", 12000, "+NETOPEN: 0");
  if (r.indexOf("+NETOPEN: 0") < 0) { Serial.println("❌ NETOPEN fehlgeschlagen"); return false; }
  Serial.println("✅ PDP aktiv");
  return true;
}

// =================================================
// GNSS READY WAIT
// =================================================
bool waitForGnssReady(uint32_t timeout = 30000) {
  unsigned long start = millis();
  String buf = "";
  while (millis() - start < timeout) {
    while (modemSerial.available()) {
      buf += (char)modemSerial.read();
      if (buf.indexOf("+CGNSSPWR: READY") >= 0) return true;
    }
    delay(20);
  }
  return false;
}

// =================================================
// GNSS INIT  ← Kernfix in dieser Version
// =================================================
void initGNSS() {
  sendAT("AT+CGNSSPWR=0", 3000);    // GNSS komplett ausschalten
  delay(1000);

  // ✅ Mode JETZT setzen – während GNSS aus ist
  sendAT("AT+CGNSSMODE=1", 2000);   // GPS + GLONASS

  // ✅ Erst danach einschalten → Mode ist korrekt aktiv beim Start
  sendAT("AT+CGNSSPWR=1", 5000, "OK");

  Serial.print("⏳ Warte auf GNSS READY... ");
  bool ready = waitForGnssReady(30000);
  Serial.println(ready ? "✅" : "(Timeout – fahre trotzdem fort)");

  // AT+CGNSSIPR entfernt: nur für NMEA-UART nötig, nicht für Polling
  Serial.println("📡 GNSS gestartet");
}

// =================================================
// GPS PARSE
// =================================================
bool parseGNSS(String& data, float& lat, float& lon, int& sats) {
  sats = 0;
  int idx = data.indexOf("+CGNSSINFO:");
  if (idx < 0) return false;
  String line = data.substring(idx + 12);
  line.trim();
  if (line.startsWith(",") || line.length() < 10) return false;

  int c1 = line.indexOf(',');
  int c2 = line.indexOf(',', c1+1);
  int c3 = line.indexOf(',', c2+1);
  int c4 = line.indexOf(',', c3+1);
  int c5 = line.indexOf(',', c4+1);
  if (c1<0||c2<0||c3<0||c4<0||c5<0) return false;

  String satStr = line.substring(c1+1, c2);
  sats = satStr.toInt();

  int c6 = line.indexOf(',', c5+1);
  int c7 = line.indexOf(',', c6+1);
  int c8 = line.indexOf(',', c7+1);
  if (c6<0||c7<0||c8<0) return false;

  String latVal = line.substring(c5+1, c6);
  String latDir = line.substring(c6+1, c7);
  String lonVal = line.substring(c7+1, c8);
  String lonDir = line.substring(c8+1, line.indexOf(',', c8+1));

  if (latVal.length() < 4 || lonVal.length() < 4) return false;

  lat = latVal.toFloat();
  lon = lonVal.toFloat();
  if (latDir == "S") lat = -lat;
  if (lonDir == "W") lon = -lon;
  return (lat != 0 || lon != 0);
}

// =================================================
// DISTANZ
// =================================================
float distanceMeters(float lat1, float lon1, float lat2, float lon2) {
  float dlat = (lat2 - lat1) * 111320.0;
  float dlon = (lon2 - lon1) * 111320.0 * cos(lat1 * 0.01745);
  return sqrt(dlat*dlat + dlon*dlon);
}

// =================================================
// MQTT
// =================================================
bool mqttConnect() {
  Serial.println("🔌 MQTT verbinden...");
  String atCmd = String("AT+CIPOPEN=") + TCP_LINK +
                 ",\"TCP\",\"" + MQTT_HOST + "\"," + MQTT_PORT;
  String r = sendAT(atCmd.c_str(), 15000, "+CIPOPEN:");
  if (r.indexOf("+CIPOPEN: 0,0") < 0) { Serial.println("❌ TCP zu Broker fehlgeschlagen"); return false; }

  int clientIdLen = strlen(MQTT_CLIENT);
  int totalLen    = 10 + 2 + clientIdLen;
  uint8_t pkt[128];
  int i = 0;
  pkt[i++] = 0x10; pkt[i++] = totalLen;
  pkt[i++] = 0x00; pkt[i++] = 0x04;
  pkt[i++] = 'M'; pkt[i++] = 'Q'; pkt[i++] = 'T'; pkt[i++] = 'T';
  pkt[i++] = 0x04; pkt[i++] = 0x02;
  pkt[i++] = 0x01; pkt[i++] = 0x2C; // keepalive = 300s (5min)
  pkt[i++] = 0x00; pkt[i++] = clientIdLen;
  for (int j = 0; j < clientIdLen; j++) pkt[i++] = MQTT_CLIENT[j];

  modemSerial.print("AT+CIPSEND="); modemSerial.print(TCP_LINK);
  modemSerial.print(","); modemSerial.println(i);
  delay(300);
  modemSerial.write(pkt, i);
  delay(1000);

  String resp = sendAT("", 3000);
  if (resp.indexOf("ERROR") < 0) { Serial.println("✅ MQTT verbunden"); return true; }
  Serial.println("❌ MQTT CONNECT fehlgeschlagen");
  return false;
}

bool mqttPublish(const char* topic, const char* payload) {
  int topicLen   = strlen(topic);
  int payloadLen = strlen(payload);
  int remaining  = 2 + topicLen + payloadLen;
  uint8_t pkt[256];
  int i = 0;
  pkt[i++] = 0x30; pkt[i++] = remaining;
  pkt[i++] = (topicLen >> 8) & 0xFF; pkt[i++] = topicLen & 0xFF;
  for (int j = 0; j < topicLen;   j++) pkt[i++] = topic[j];
  for (int j = 0; j < payloadLen; j++) pkt[i++] = payload[j];

  modemSerial.print("AT+CIPSEND="); modemSerial.print(TCP_LINK);
  modemSerial.print(","); modemSerial.println(i);
  delay(300);
  modemSerial.write(pkt, i);
  delay(500);
  return sendAT("", 1000).indexOf("ERROR") < 0;
}

bool ensureMqtt() {
  if (sendAT("AT+CIPOPEN?", 2000).indexOf("+CIPOPEN: 0,\"TCP\"") >= 0) return true;
  Serial.println("⚠️ MQTT Verbindung verloren – reconnect...");
  sendAT("AT+CIPCLOSE=0", 3000);
  delay(500);
  if (mqttConnect()) return true;
  Serial.println("🔄 PDP wird neu aufgebaut...");
  activatePDP();
  return mqttConnect();
}

// =================================================
// HILFSFUNKTION: Sucht needle in Rohbytes inkl. Null-Bytes
// indexOf() würde beim ersten \x00 im MQTT-Header stoppen
// =================================================
bool bytesContain(const String& s, const char* needle) {
  int nLen = strlen(needle);
  int sLen = s.length();
  const char* buf = s.c_str();
  for (int i = 0; i <= sLen - nLen; i++) {
    if (memcmp(buf + i, needle, nLen) == 0) return true;
  }
  return false;
}

// =================================================
// MODUS ANWENDEN
// Sucht "training"/"race" in raw Bytes (inkl. Null-Bytes)
// =================================================
bool applyModeFromString(const String& s) {
  if (bytesContain(s, "training")) {
    intervalMoving  = 10000; intervalStopped = 60000;
    strncpy(trackerMode, "training", sizeof(trackerMode));
    modeChanged = true;
    Serial.println("🏋️ Training-Modus: 10s / 60s");
    return true;
  }
  if (bytesContain(s, "race")) {
    intervalMoving  = 2000; intervalStopped = 30000;
    strncpy(trackerMode, "race", sizeof(trackerMode));
    modeChanged = true;
    Serial.println("🏁 Renn-Modus: 2s / 30s");
    return true;
  }
  return false;
}

// =================================================
// CONFIG SUBSCRIBE + MODUS-CHECK
// Einmalig beim Start, dann alle 30s im Loop.
// Re-Subscribe → Broker liefert retained Message neu.
// CIPRECVMODE=1 hält TCP-Daten in separatem Buffer –
// sendAT/Flush löscht sie NICHT.
// =================================================
void subscribeConfig() {
  // --- 1. Ausstehende URC/Daten vor Subscribe prüfen ---
  String pending = "";
  while (modemSerial.available()) pending += (char)modemSerial.read();
  if (pending.length() > 0 && applyModeFromString(pending)) return;

  // --- 2. SUBSCRIBE senden ---
  int topicLen  = strlen(MQTT_CONFIG);
  int remaining = 5 + topicLen;
  uint8_t pkt[128];
  int i = 0;
  pkt[i++] = 0x82;
  pkt[i++] = (uint8_t)remaining;
  pkt[i++] = 0x00; pkt[i++] = 0x01;
  pkt[i++] = (topicLen >> 8) & 0xFF;
  pkt[i++] = topicLen & 0xFF;
  for (int j = 0; j < topicLen; j++) pkt[i++] = MQTT_CONFIG[j];
  pkt[i++] = 0x00;

  modemSerial.print("AT+CIPSEND="); modemSerial.print(TCP_LINK);
  modemSerial.print(","); modemSerial.println(i);
  delay(300);
  modemSerial.write(pkt, i);

  // --- 3. Serial direkt lesen – Broker pusht Daten auf UART ---
  String r = "";
  unsigned long t = millis();
  while (millis() - t < 2000) {
    while (modemSerial.available()) r += (char)modemSerial.read();
    delay(10);
  }
  applyModeFromString(r);
}

// =================================================
// SETUP
// =================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n🚀 A7670 GPS Tracker v47");

  modemSerial.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
  delay(100);
  modemPowerOn();

  if (!initModem())   { Serial.println("💀 Modem Init fehlgeschlagen – Neustart");  delay(5000); ESP.restart(); }

  // GNSS früh starten – sucht bereits während PDP/MQTT aufgebaut wird
  initGNSS();

  if (!activatePDP()) { Serial.println("💀 PDP fehlgeschlagen – Neustart");          delay(5000); ESP.restart(); }
  if (!mqttConnect()) { Serial.println("💀 MQTT fehlgeschlagen – Neustart"); delay(5000); ESP.restart(); }

  // Config-Topic subscriben + initialen Modus laden
  subscribeConfig();

  gpsSearchStart = millis();
  Serial.println("\n⏳ Warte auf GPS Fix (Kaltstart kann 2-5 min dauern)...\n");
}

// =================================================
// LOOP  –  Debug-Rohausgabe noch aktiv
// =================================================
void loop() {
  // Eingehende URC/Broker-Daten VOR AT-Befehlen abfangen
  {
    String urc = "";
    while (modemSerial.available()) urc += (char)modemSerial.read();
    if (urc.length() > 0) applyModeFromString(urc);
  }

  // Periodischer Modus-Check (alle 30s)
  if (firstFixDone && millis() - lastModeCheck >= MODE_CHECK_MS) {
    if (ensureMqtt()) subscribeConfig();
    lastModeCheck = millis();
  }

  Serial.println("\n--- GNSS RAW ---");
  String gnss = sendAT("AT+CGNSSINFO", 3000);
  Serial.println(gnss);

  float lat = 0, lon = 0;
  int   sats = 0;

  if (!parseGNSS(gnss, lat, lon, sats)) {
    fixConsecutive = 0; // Zähler zurücksetzen bei verlorenem Signal
    Serial.printf("⏳ Kein Fix (seit %lus)\n", (millis() - gpsSearchStart) / 1000);
    delay(3000);
    return;
  }

  // Fix vorhanden – erst nach 2 stabilen Reads weiterverarbeiten
  fixConsecutive++;
  if (fixConsecutive < 2) {
    Serial.printf("🔄 Fix instabil [%d Sat] – warte auf Bestätigung...\n", sats);
    delay(3000);
    return;
  }

  Serial.printf("✅ Fix: %.6f, %.6f  [%d Sat]\n", lat, lon, sats);
  if (!firstFixDone) {
    firstFixDone  = true;
    lastModeCheck = millis(); // Timer erst jetzt starten
    Serial.println("🔓 GPS-Fix: Modus-Check aktiviert");
  }

  float    moved   = (lastLat == 0) ? 9999 : distanceMeters(lat, lon, lastLat, lastLon);
  uint32_t elapsed = millis() - lastSendTime;
  bool     moving  = moved >= MIN_MOVE_METERS;
  bool     send    = moving || (elapsed >= intervalStopped);

  if (send) {
    char payload[128];
    if (modeChanged) {
      snprintf(payload, sizeof(payload),
        "{\"id\":\"%s\",\"lat\":%.5f,\"lon\":%.5f,\"mode\":\"%s\"}",
        DEVICE_ID, lat, lon, trackerMode);
    } else {
      snprintf(payload, sizeof(payload),
        "{\"id\":\"%s\",\"lat\":%.5f,\"lon\":%.5f}",
        DEVICE_ID, lat, lon);
    }
    Serial.printf("%s [%d Sat] → %s\n", moving ? "🚗" : "🅿️", sats, payload);
    if (ensureMqtt() && mqttPublish(MQTT_TOPIC, payload)) {
      Serial.println("✅ OK");
      lastLat = lat; lastLon = lon;
      lastSendTime = millis();
      modeChanged  = false; // Flag zurücksetzen
    } else {
      Serial.println("❌ Fehler");
    }
  } else {
    Serial.printf("⏸ %.1fm [%d Sat], Heartbeat in %ds\n",
      moved, sats, (intervalStopped - elapsed) / 1000);
  }

  delay(moving ? intervalMoving : 3000);
}
