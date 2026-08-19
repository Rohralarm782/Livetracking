// Falls Node <18:
// const fetch = require("node-fetch");

let lat = 52.5200;
let lon = 13.4050;

// Bewegungsrichtung
let dLat = 0.0001;
let dLon = 0.00012;

const DEVICE_ID = "simulator-1";

function randomDrift() {
  // leichte zufällige Richtungsänderung
  if (Math.random() > 0.7) {
    dLat *= -1;
  }

  if (Math.random() > 0.7) {
    dLon *= -1;
  }
}

async function sendPosition() {

  try {

    await fetch("http://127.0.0.1:3000/positions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: DEVICE_ID,
        lat,
        lon
      })
    });

    console.log("📡 gesendet:", lat.toFixed(6), lon.toFixed(6));

  } catch (err) {
    console.error("❌ Fehler beim Senden:", err.message);
  }
}

// Loop = 1 Hz GPS Simulation
setInterval(() => {

  // Bewegung simulieren
  lat += dLat;
  lon += dLon;

  randomDrift();

  sendPosition();

}, 1000);
