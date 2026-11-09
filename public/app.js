const pairForm = document.querySelector("#pair-form");
const pairMessage = document.querySelector("#pair-message");
const entries = document.querySelector("#entries");
const glassStatus = document.querySelector("#glass-status");
const nextSubject = document.querySelector("#next-subject");
const nextDetails = document.querySelector("#next-details");

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Anfrage fehlgeschlagen.");
  return body;
}

function formatEntry(item) {
  const subject = item.subjects?.map((subject) => subject.name).join(", ") || item.te?.map((subject) => subject.name).join(", ") || "Unterricht";
  const room = item.rooms?.map((room) => room.name).join(", ") || item.ro?.map((room) => room.name).join(", ") || "Raum offen";
  const start = String(item.startTime || "").padStart(4, "0");
  const end = String(item.endTime || "").padStart(4, "0");
  return { subject, room, time: `${start.slice(0, 2)}:${start.slice(2)}–${end.slice(0, 2)}:${end.slice(2)}`, date: item.date };
}

async function loadTimetable() {
  try {
    const data = await api("/api/timetable");
    const formatted = (data.entries || []).map(formatEntry).slice(0, 30);
    entries.innerHTML = formatted.length ? formatted.map((item) => `<div class="entry"><time>${item.time}</time><div><strong>${item.subject}</strong><small>${item.date || ""}</small></div><small>${item.room}</small></div>`).join("") : '<p class="muted">Keine Stunden gefunden.</p>';
    const next = formatted[0];
    if (next) { nextSubject.textContent = next.subject; nextDetails.textContent = `${next.time} · ${next.room}`; glassStatus.textContent = "Verbunden · nächster Unterricht"; }
  } catch (error) {
    glassStatus.textContent = "Nicht verbunden";
    nextDetails.textContent = error.message;
  }
}

async function loadExistingConnection() {
  const saved = window.localStorage.getItem("webuntis-phone-session");
  if (saved) {
    try {
      const session = JSON.parse(saved);
      await api("/api/session/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session)
      });
    } catch (error) {
      window.localStorage.removeItem("webuntis-phone-session");
    }
  }
  const status = await api("/api/app-status");
  if (!status.connected) return false;
  pairMessage.className = "message ok";
  pairMessage.textContent = "Bereits verbunden. Lade Stundenplan ...";
  await loadTimetable();
  return true;
}

async function keepPhoneSessionAlive() {
  const saved = window.localStorage.getItem("webuntis-phone-session");
  if (!saved) return;
  const session = JSON.parse(saved);
  await api("/api/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session)
  });
}

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pairMessage.className = "message";
  pairMessage.textContent = "Verbinde mit WebUntis …";
  const form = new FormData(pairForm);
  try {
    const session = Object.fromEntries(form);
    const result = await api("/api/pair/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session) });
    session.deviceId = result.deviceId;
    window.localStorage.setItem("webuntis-phone-session", JSON.stringify(session));
    pairMessage.className = "message ok";
    pairMessage.textContent = "Erfolgreich gekoppelt. Zugang bleibt lokal verschlüsselt gespeichert.";
    await loadTimetable();
  } catch (error) { pairMessage.className = "message error"; pairMessage.textContent = error.message; }
});
document.querySelector("#refresh").addEventListener("click", loadTimetable);
document.querySelector("#disconnect").addEventListener("click", async () => {
  const button = document.querySelector("#disconnect");
  button.disabled = true;
  try {
    await api("/api/disconnect", { method: "POST" });
    window.localStorage.removeItem("webuntis-phone-session");
    pairForm.reset();
    document.querySelector("#baseUrl").value = "https://ggb.webuntis.com";
    document.querySelector("#school").value = "ggb";
    pairMessage.className = "message ok";
    pairMessage.textContent = "Verbindung getrennt. Du kannst jetzt neu koppeln.";
    glassStatus.textContent = "Nicht verbunden";
    nextSubject.textContent = "—";
    nextDetails.textContent = "Öffne die Web-App auf der Brille neu.";
    entries.innerHTML = '<p class="muted">Noch keine Daten geladen.</p>';
  } catch (error) {
    pairMessage.className = "message error";
    pairMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
loadExistingConnection().catch((error) => {
  pairMessage.className = "message error";
  pairMessage.textContent = error.message;
});
setInterval(async () => {
  try {
    await keepPhoneSessionAlive();
    await loadTimetable();
  } catch (error) {
    pairMessage.className = "message error";
    pairMessage.textContent = `Handy-Verbindung wartet auf Wiederherstellung: ${error.message}`;
  }
}, 5 * 60 * 1000);
