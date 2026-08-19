// ================================================
// LILYGO T-Call A7670 – GPS Tracker v48.3.0
// ggü. v48.2.0:
//   ✅ Portionsgröße fest auf 20 Byte. v48.2.0 leitete sie aus
//      NimBLEDevice::getMTU() ab – das liefert aber NICHT die
//      ausgehandelte MTU, sondern den lokal gesetzten Wunsch
//      (185). Ergebnis: 182 Byte Nutzlast angenommen, alles in
//      EIN Notify gepackt, vom Stack bei 20 Byte gekappt.
//      20 Byte ist die Untergrenze, die jedes BLE-Gerät kann
//      (23 MTU − 3 ATT). Mehr auszuhandeln ist erlaubt,
//      weniger nicht – deshalb ist der feste Wert sicher.
//   ✅ Die Logzeile heißt jetzt ehrlich "MTU-Wunsch (lokal)".
//      Als "ausgehandelt" beschriftet hat sie zwei Runden lang
//      185 gemeldet, obwohl 23 galten.
//
// ggü. v48.1.0:
//   ✅ BLE-Text wird gerahmt und in Häppchen gesendet. Der
//      MTU-Wunsch von 185 wurde vom Edge 540 nicht bedient –
//      es blieb bei 23 Byte, also 20 Byte Nutzlast, und jeder
//      Text ab 21 Zeichen wurde stumm abgeschnitten.
//      Jetzt: 0x02 vor dem Text, 0x03 danach, dazwischen so
//      viele Notifies wie nötig. Die Gegenstelle sammelt.
//      Der Rahmen kostet 2 Byte und macht Teilverluste
//      erkennbar – bei 0x02 verwirft der Client Halbes.
//   ✅ Serial zeigt Byte-Zahl und Paketzahl je Sendung.
//
// ggü. v48.0.0:
//   ✅ DISPLAY_MAX 20 → 60 Zeichen. Die 20 kamen von der
//      BLE-Standard-MTU (23 Byte − 3 ATT-Header). BLE handelt
//      die MTU beim Verbinden aber aus; Garmin-Geräte landen
//      typisch bei 128–244 Byte. 60 ist konservativ genug,
//      dass auch eine kleine ausgehandelte MTU reicht.
//   ✅ MTU-Wunsch 185 Byte + Ausgabe der tatsächlichen MTU
//
// ggü. v47:
//   ✅ MQTT-EMPFANG: AT+CIPRXGET=1 (Buffer-Modus) + echter
//      PUBLISH-Parser. Vorher gingen gepushte Daten im
//      sendAT()-Flush verloren.
//   ✅ BLE-Server (NimBLE): gibt Display-Text an die
//      Connect-IQ-App auf dem Garmin Edge weiter.
//   ✅ Zweites Topic livetracking-fq4l/display/<DEVICE_ID>
//   ✅ subscribeConfig() entfällt – der 30s-Neu-Subscribe war
//      nur ein Notbehelf gegen den verlorenen Push-Empfang.
//   ✅ Client-ID aus DEVICE_ID abgeleitet (Kollisionsschutz
//      auf dem öffentlichen Broker, sobald t2 dazukommt)
//   ✅ modeChanged nur noch bei echtem Moduswechsel
//
// Funktionsübersicht:
//   • MQTT über TCP zu broker.emqx.io:1883
//   • Adaptives Polling: Race 2s/30s, Training 10s/60s
//   • Modus-Wechsel via retained MQTT (livetracking-fq4l/config)
//   • Display-Text via retained MQTT → BLE → Garmin
//   • firstFixDone + fixConsecutive (2 stabile Reads vor erstem Send)
//   • mode-Feld nur beim ersten Send + nach Modus-Wechsel
// ================================================

#include <HardwareSerial.h>
#include <math.h>
#include <NimBLEDevice.h>

// -----------------------------
// BLE – muss IDENTISCH mit der Connect-IQ-App sein
// -----------------------------
#define SERVICE_UUID        "43b5d113-a206-4011-8218-95705d3300cd"
#define CHARACTERISTIC_UUID "14515bd1-cc1d-4ff4-9580-246228a21c8a"

// Maximale Länge des Anzeigetextes.
// Muss unter (ausgehandelte MTU − 3) bleiben, sonst schneidet
// der BLE-Stack ab. Bei 185 angefragten Byte reichlich Reserve.
#define DISPLAY_MAX 60

// Rahmenbytes. Müssen ausserhalb 32..126 liegen, damit der
// Zeichenfilter der Gegenstelle sie ohnehin verwerfen würde,
// falls doch mal eines durchrutscht.
#define BLE_STX 0x02
#define BLE_ETX 0x03

// Nutzlast je Notify. Bewusst FEST, nicht aus der MTU abgeleitet:
// 23 Byte MTU − 3 Byte ATT-Header ist das garantierte Minimum
// jedes BLE-Geräts. Ein Gerät darf mehr aushandeln, nie weniger.
// Bei 62 Byte Maximum sind das vier Pakete, also ~100 ms.
#define BLE_CHUNK 20

// Gewünschte MTU. Der Client (Garmin) bestimmt am Ende, was
// tatsächlich ausgehandelt wird – das ist nur unsere Obergrenze.
#define BLE_MTU_WISH 185

// -----------------------------
// MQTT BROKER
// -----------------------------
const char* MQTT_HOST   = "broker.emqx.io";
const int   MQTT_PORT   = 1883;
const char* MQTT_TOPIC  = "livetracking-fq4l/positions";
const char* DEVICE_ID   = "t1";

const char* MQTT_CONFIG = "livetracking-fq4l/config";

// Zur Laufzeit aus DEVICE_ID gebaut – siehe setup()
char MQTT_CLIENT[24];      // z.B. "lt-t1"
char MQTT_DISPLAY[64];     // z.B. "livetracking-fq4l/display/t1"

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
// BLE
// -----------------------------
NimBLEServer*         pServer         = nullptr;
NimBLECharacteristic* pCharacteristic = nullptr;
char     bleName[16];
char     displayText[DISPLAY_MAX + 1] = "";
uint32_t lastBleBeat = 0;
const uint32_t BLE_BEAT_MS = 5000;

// -----------------------------
// MQTT-EMPFANG
// -----------------------------
#define RAW_BUF  1024
#define MQTT_BUF 512
uint8_t  rawBuf[RAW_BUF];
uint8_t  mqttBuf[MQTT_BUF];
int      mqttLen  = 0;
uint32_t lastRxPoll = 0;
const uint32_t RX_POLL_MS = 1000;

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
// BLE SERVER
// Aufbau 1:1 aus BLE_Test_v1.ino übernommen.
// Läuft auf eigenem FreeRTOS-Task – die blockierenden
// delay()/sendAT()-Aufrufe der Loop stören nicht.
// =================================================
void bleInit() {
  snprintf(bleName, sizeof(bleName), "LT-%s", DEVICE_ID);

  NimBLEDevice::init(bleName);
  NimBLEDevice::setMTU(BLE_MTU_WISH);
  pServer = NimBLEDevice::createServer();

  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  pCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );
  // CCCD (0x2902) NICHT manuell anlegen – NimBLE macht das bei NOTIFY selbst.

  strncpy(displayText, "-- warte --", DISPLAY_MAX);
  displayText[DISPLAY_MAX] = 0;
  pCharacteristic->setValue((uint8_t*)displayText, strlen(displayText));

  pService->start();

  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setName(bleName);
  pAdvertising->start();

  Serial.printf("📶 BLE aktiv, Advertising als '%s'\n", bleName);
}

// Wert setzen und – falls ein Client verbunden ist – senden.
// verbose=true nur bei echter Änderung, damit der 5s-Heartbeat
// den Serial Monitor nicht zumüllt.
void bleSend(bool verbose) {
  if (pCharacteristic == nullptr) return;

  // Einmalig melden, womit gerechnet wird. getMTU() gibt den
  // LOKALEN Wunsch zurück, nicht das Verhandlungsergebnis – der
  // Wert ist also nur informativ und wird nicht mehr zum Rechnen
  // benutzt. Gesendet wird immer in BLE_CHUNK großen Stücken.
  static bool mtuLogged = false;
  if (!mtuLogged && pServer != nullptr && pServer->getConnectedCount() > 0) {
    Serial.printf("📏 BLE MTU-Wunsch (lokal): %u | gesendet wird in %d-Byte-Paketen\n",
                  NimBLEDevice::getMTU(), BLE_CHUNK);
    mtuLogged = true;
  }

  // Nachricht rahmen: STX <Text> ETX
  size_t  len = strlen(displayText);
  uint8_t buf[DISPLAY_MAX + 2];
  buf[0] = BLE_STX;
  memcpy(buf + 1, displayText, len);
  buf[len + 1] = BLE_ETX;
  size_t total = len + 2;

  if (pServer == nullptr || pServer->getConnectedCount() == 0) {
    pCharacteristic->setValue(buf, total);
    if (verbose) Serial.println("   📲 BLE: kein Client verbunden – Wert nur gesetzt");
    return;
  }

  const size_t pay = BLE_CHUNK;

  size_t sent = 0;
  int    pkt  = 0;
  while (sent < total) {
    size_t n = total - sent;
    if (n > pay) n = pay;
    pCharacteristic->setValue(buf + sent, n);
    pCharacteristic->notify();
    sent += n;
    pkt++;
    // Ohne Pause verwirft der Stack Notifies, die schneller
    // kommen als der Client sie abholt.
    if (sent < total) delay(25);
  }
  if (verbose) {
    Serial.printf("   📲 BLE Notify → [%s] (%u Byte, %d Pakete)\n",
                  displayText, (unsigned)total, pkt);
  }
}

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

  int clientIdLen = strlen(MQTT_CLIENT);   // MQTT_CLIENT wird in setup() gebaut
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
  mqttLen = 0;                       // halbe Pakete aus der alten Sitzung verwerfen
  sendAT("AT+CIPRXGET=1", 2000);     // Buffer-Modus sicherstellen
  if (mqttConnect()) { subscribeAll(); return true; }
  Serial.println("🔄 PDP wird neu aufgebaut...");
  activatePDP();
  sendAT("AT+CIPRXGET=1", 2000);
  if (mqttConnect()) { subscribeAll(); return true; }
  return false;
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
// MQTT-EMPFANG
// Aus MQTT_BLE_Test_v2_0_2.ino übernommen (dort auf dieser
// Hardware verifiziert). Parser mit 10 Testfällen geprüft.
// =================================================
int findBytes(const uint8_t* hay, int hayLen, const char* needle) {
  int nLen = strlen(needle);
  if (nLen == 0 || hayLen < nLen) return -1;
  for (int i = 0; i <= hayLen - nLen; i++) {
    if (memcmp(hay + i, needle, nLen) == 0) return i;
  }
  return -1;
}

// Vorwärtsdeklaration – applyModeFromString steht weiter unten
bool applyModeFromString(const String& s);

void handlePublish(const uint8_t* p, int headerLen, uint32_t remLen) {
  uint8_t flags = p[0];
  int i   = headerLen;
  int end = headerLen + (int)remLen;

  if (i + 2 > end) return;
  int topicLen = (p[i] << 8) | p[i + 1];
  i += 2;
  if (i + topicLen > end) return;

  char topic[96];
  int tl = topicLen < 95 ? topicLen : 95;
  memcpy(topic, p + i, tl);
  topic[tl] = 0;
  i += topicLen;

  uint8_t qos = (flags >> 1) & 0x03;
  if (qos > 0) {
    if (i + 2 > end) return;
    i += 2;
  }

  int payLen = end - i;
  if (payLen < 0) payLen = 0;

  // --- Verteilung nach Topic ---
  if (strcmp(topic, MQTT_DISPLAY) == 0) {
    // Bewusst abschneiden statt verwerfen: eine zu lange Nachricht
    // soll das Display nie komplett stumm schalten.
    int copyLen = payLen < DISPLAY_MAX ? payLen : DISPLAY_MAX;
    memcpy(displayText, p + i, copyLen);
    displayText[copyLen] = 0;
    Serial.printf("📥 Display (%d Byte) → [%s]\n", payLen, displayText);
    bleSend(true);
  } else if (strcmp(topic, MQTT_CONFIG) == 0) {
    String payload = "";
    for (int j = 0; j < payLen; j++) payload += (char)p[i + j];
    Serial.printf("📥 Config → %s\n", payload.c_str());
    applyModeFromString(payload);
  }
}

void mqttParse() {
  while (true) {
    if (mqttLen < 2) return;

    uint8_t type = mqttBuf[0] & 0xF0;
    if (type < 0x10 || type > 0xE0) {          // nicht synchron
      memmove(mqttBuf, mqttBuf + 1, mqttLen - 1);
      mqttLen--;
      continue;
    }

    uint32_t remLen = 0;
    uint32_t mult   = 1;
    int      i      = 1;
    bool     done   = false;
    while (i < mqttLen && i <= 4) {
      uint8_t b = mqttBuf[i];
      remLen += (uint32_t)(b & 0x7F) * mult;
      mult   *= 128;
      i++;
      if ((b & 0x80) == 0) { done = true; break; }
    }
    if (!done) {
      if (i > 4) {                              // Varint kaputt
        memmove(mqttBuf, mqttBuf + 1, mqttLen - 1);
        mqttLen--;
        continue;
      }
      return;                                   // noch unvollständig
    }

    int  headerLen = i;
    long total     = (long)headerLen + (long)remLen;

    if (total > MQTT_BUF) {
      Serial.printf("⚠️ MQTT-Paket zu groß (%ld Byte) – verworfen\n", total);
      mqttLen = 0;
      return;
    }
    if (mqttLen < total) return;

    switch (type) {
      case 0x30: handlePublish(mqttBuf, headerLen, remLen); break;
      case 0x90: Serial.println("✅ SUBACK"); break;
      case 0x20: Serial.println("✅ CONNACK"); break;
      case 0xD0: break;                          // PINGRESP
      default: break;
    }

    memmove(mqttBuf, mqttBuf + total, mqttLen - total);
    mqttLen -= total;
  }
}

void mqttFeed(const uint8_t* data, int len) {
  if (len <= 0) return;
  if (mqttLen + len > MQTT_BUF) {
    Serial.println("⚠️ MQTT-Puffer voll – wird geleert");
    mqttLen = 0;
    if (len > MQTT_BUF) len = MQTT_BUF;
  }
  memcpy(mqttBuf + mqttLen, data, len);
  mqttLen += len;
  mqttParse();
}

// Wie viele Bytes liegen im Modem-Puffer bereit?
int cipRxAvailable() {
  String cmd = String("AT+CIPRXGET=4,") + TCP_LINK;
  String r = sendAT(cmd.c_str(), 2000);
  int idx = r.indexOf("+CIPRXGET: 4,");
  if (idx < 0) return 0;
  int c1 = r.indexOf(',', idx);
  int c2 = r.indexOf(',', c1 + 1);
  if (c2 < 0) return 0;
  return r.substring(c2 + 1).toInt();
}

// Daten abholen. Bewusst byteweise in ein uint8_t-Array,
// weil die Nutzlast beliebige Bytes enthalten kann.
int cipRxRead(int want) {
  if (want <= 0) return 0;
  if (want > 512) want = 512;

  while (modemSerial.available()) modemSerial.read();
  modemSerial.print("AT+CIPRXGET=2,");
  modemSerial.print(TCP_LINK);
  modemSerial.print(",");
  modemSerial.println(want);

  int n = 0;
  unsigned long start    = millis();
  unsigned long lastByte = millis();
  while (millis() - start < 3000 && n < RAW_BUF) {
    bool got = false;
    while (modemSerial.available() && n < RAW_BUF) {
      rawBuf[n++] = (uint8_t)modemSerial.read();
      got = true;
    }
    if (got) lastByte = millis();
    else if (n > 0 && millis() - lastByte > 300) break;
    delay(5);
  }
  if (n == 0) return 0;

  int h = findBytes(rawBuf, n, "+CIPRXGET: 2,");
  if (h < 0) return 0;

  // Format: +CIPRXGET: 2,<link>,<readLen>,<restLen>\r\n<daten>
  int p = h + 13;
  while (p < n && rawBuf[p] != ',') p++;   // Link überspringen
  p++;
  int readLen = 0;
  while (p < n && rawBuf[p] >= '0' && rawBuf[p] <= '9') {
    readLen = readLen * 10 + (rawBuf[p] - '0');
    p++;
  }
  while (p < n && rawBuf[p] != '\n') p++;
  p++;

  if (readLen <= 0) return 0;
  if (p + readLen > n) readLen = n - p;
  if (readLen <= 0) return 0;

  mqttFeed(rawBuf + p, readLen);
  return readLen;
}

// =================================================
// MODUS ANWENDEN
// Sucht "training"/"race" in raw Bytes (inkl. Null-Bytes)
// =================================================
bool applyModeFromString(const String& s) {
  if (bytesContain(s, "training")) {
    intervalMoving  = 10000; intervalStopped = 60000;
    // Nur flaggen, wenn sich der Modus wirklich ändert. Sonst würde
    // jede erneut zugestellte retained Config das mode-Feld auslösen.
    if (strcmp(trackerMode, "training") != 0) {
      modeChanged = true;
      Serial.println("🏋️ Training-Modus: 10s / 60s");
    }
    strncpy(trackerMode, "training", sizeof(trackerMode));
    return true;
  }
  if (bytesContain(s, "race")) {
    intervalMoving  = 2000; intervalStopped = 30000;
    if (strcmp(trackerMode, "race") != 0) {
      modeChanged = true;
      Serial.println("🏁 Renn-Modus: 2s / 30s");
    }
    strncpy(trackerMode, "race", sizeof(trackerMode));
    return true;
  }
  return false;
}

// =================================================
// MQTT SUBSCRIBE
// Einmal pro Verbindung. Der Broker liefert retained
// Messages direkt beim Subscribe – der 30s-Neu-Subscribe
// aus v47 ist mit dem gepufferten Empfang überflüssig.
// =================================================
bool mqttSubscribe(const char* topic, uint8_t packetId) {
  int topicLen  = strlen(topic);
  int remaining = 5 + topicLen;
  uint8_t pkt[128];
  int i = 0;
  pkt[i++] = 0x82;
  pkt[i++] = (uint8_t)remaining;
  pkt[i++] = 0x00; pkt[i++] = packetId;
  pkt[i++] = (topicLen >> 8) & 0xFF;
  pkt[i++] = topicLen & 0xFF;
  for (int j = 0; j < topicLen; j++) pkt[i++] = topic[j];
  pkt[i++] = 0x00;                       // QoS 0

  modemSerial.print("AT+CIPSEND="); modemSerial.print(TCP_LINK);
  modemSerial.print(","); modemSerial.println(i);
  delay(300);
  modemSerial.write(pkt, i);
  delay(500);

  Serial.printf("📡 SUBSCRIBE: %s\n", topic);
  return true;
}

void subscribeAll() {
  mqttSubscribe(MQTT_CONFIG,  0x01);
  mqttSubscribe(MQTT_DISPLAY, 0x02);
}

// =================================================
// EMPFANG + BLE-HEARTBEAT
// Wird oben in loop() aufgerufen. Die Loop iteriert
// mindestens alle 3s, das reicht für beides.
// =================================================
void serviceLink() {
  uint32_t now = millis();

  if (now - lastRxPoll >= RX_POLL_MS) {
    lastRxPoll = now;
    int avail = cipRxAvailable();
    if (avail > 0) cipRxRead(avail);
  }

  if (now - lastBleBeat >= BLE_BEAT_MS) {
    lastBleBeat = now;
    bleSend(false);
  }
}

// =================================================
// SETUP
// =================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n🚀 A7670 GPS Tracker v48.3.0");

  // Laufzeit-Strings aus DEVICE_ID bauen
  snprintf(MQTT_CLIENT,  sizeof(MQTT_CLIENT),  "lt-%s", DEVICE_ID);
  snprintf(MQTT_DISPLAY, sizeof(MQTT_DISPLAY), "livetracking-fq4l/display/%s", DEVICE_ID);
  Serial.printf("   Device %s | ClientID %s\n", DEVICE_ID, MQTT_CLIENT);
  Serial.printf("   Display-Topic: %s\n", MQTT_DISPLAY);

  // BLE zuerst: der Garmin kann sich schon verbinden,
  // während das Modem noch im Netz sucht.
  bleInit();

  modemSerial.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
  delay(100);
  modemPowerOn();

  if (!initModem())   { Serial.println("💀 Modem Init fehlgeschlagen – Neustart");  delay(5000); ESP.restart(); }

  // GNSS früh starten – sucht bereits während PDP/MQTT aufgebaut wird
  initGNSS();

  if (!activatePDP()) { Serial.println("💀 PDP fehlgeschlagen – Neustart");          delay(5000); ESP.restart(); }

  // WICHTIG: vor CIPOPEN setzen. Ohne Buffer-Modus verschwinden
  // eingehende Daten im sendAT()-Flush. A76XX kennt KEIN
  // AT+CIPRECVMODE – der Befehl heißt hier AT+CIPRXGET=1.
  if (sendAT("AT+CIPRXGET=1", 3000).indexOf("OK") < 0) {
    Serial.println("❌ AT+CIPRXGET=1 abgelehnt – Empfang wird nicht funktionieren!");
  } else {
    Serial.println("✅ AT+CIPRXGET=1 aktiv (Modem puffert)");
  }

  if (!mqttConnect()) { Serial.println("💀 MQTT fehlgeschlagen – Neustart"); delay(5000); ESP.restart(); }

  // Beide Topics abonnieren – retained Messages kommen sofort
  subscribeAll();

  gpsSearchStart = millis();
  Serial.println("\n⏳ Warte auf GPS Fix (Kaltstart kann 2-5 min dauern)...\n");
}

// =================================================
// LOOP  –  Debug-Rohausgabe noch aktiv
// =================================================
void loop() {
  // Empfang abholen + BLE-Heartbeat. Muss vor den AT-Befehlen
  // stehen; die Nutzdaten liegen dank CIPRXGET=1 im Modem-Puffer
  // und überleben den sendAT()-Flush.
  serviceLink();

  // Verbindungsprüfung (alle 30s). Bei Reconnect wird in
  // ensureMqtt() automatisch neu subscribed.
  if (firstFixDone && millis() - lastModeCheck >= MODE_CHECK_MS) {
    ensureMqtt();
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
