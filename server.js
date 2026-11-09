import http from "node:http";
import https from "node:https";
import { randomBytes, randomInt, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const credentialsFile = path.join(dataDir, "credentials.enc");
const certificateFile = process.env.TLS_CERT || path.join(dataDir, "localhost-cert.pem");
const keyFile = process.env.TLS_KEY || path.join(dataDir, "localhost-key.pem");
const port = Number(process.env.PORT || 3000);
const encryptionKey = scryptSync(
  process.env.WEBUNTIS_ENCRYPTION_KEY || "local-development-key-change-me",
  "webuntis-glasses-salt",
  32
);
const pairs = new Map();
let cachedCredentials = null;
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function createPair() {
  let code;
  do code = String(randomInt(100000, 1000000)); while ([...pairs.values()].some((pair) => pair.code === code));
  const id = randomBytes(18).toString("base64url");
  pairs.set(id, { code, createdAt: Date.now(), status: "waiting", credentials: null });
  return { id, code };
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const content = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString("base64");
}

function decrypt(value) {
  const input = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, input.subarray(0, 12));
  decipher.setAuthTag(input.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString("utf8"));
}

async function saveCredentials(credentials) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(credentialsFile, encrypt(credentials), { mode: 0o600 });
  cachedCredentials = credentials;
}

async function loadCredentials() {
  if (cachedCredentials) return cachedCredentials;
  if (!existsSync(credentialsFile)) return null;
  try {
    cachedCredentials = decrypt(await readFile(credentialsFile, "utf8"));
    return cachedCredentials;
  } catch { return null; }
}

async function webUntisCall(credentials, method, params) {
  const endpoint = `${credentials.baseUrl}/WebUntis/jsonrpc.do?school=${encodeURIComponent(credentials.school)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credentials.jsessionId || credentials.sessionId
        ? { Cookie: `JSESSIONID=${credentials.jsessionId || credentials.sessionId}` }
        : {})
    },
    body: JSON.stringify({
      id: String(Date.now()),
      jsonrpc: "2.0",
      method,
      params: credentials.sessionId ? { ...params, _: credentials.sessionId } : params
    })
  });
  if (!response.ok) throw new Error(`WebUntis antwortet mit HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    const detail = payload.error.message || payload.error.data || "WebUntis-Anfrage fehlgeschlagen";
    const error = new Error(String(detail));
    error.webUntisCode = payload.error.code;
    throw error;
  }
  return payload.result;
}

async function authenticate({ username, password, school = "ggb", baseUrl = "https://ggb.webuntis.com" }) {
  if (!username || !password) throw new Error("Benutzername und Passwort sind erforderlich.");
  username = username.trim();
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  const result = await webUntisCall({ baseUrl: cleanBaseUrl, school }, "authenticate", {
    user: username, password, client: "webuntis-glasses"
  });
  return {
    baseUrl: cleanBaseUrl,
    school,
    username,
    password,
    sessionId: result.sessionId,
    jsessionId: result.jsessionId || result.sessionId,
    personId: result.personId ?? result.userId,
    personType: result.personType ?? 5,
    role: result.role
  };
}

async function timetable(credentials) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  const startDate = Number(startIso.replaceAll("-", ""));
  const endDate = Number(endIso.replaceAll("-", ""));
  try {
    return await webUntisCall(credentials, "getTimetable", {
      options: {
        element: { id: credentials.personId, type: credentials.personType || 5, keyType: "id" },
        startDate,
        endDate,
        showInfo: true,
        showSubstText: true,
        showBooking: false,
        hideErrors: true
      }
    });
  } catch (error) {
    if (error.webUntisCode !== -32601) throw error;
    const legacyType = { 1: "CLASS", 2: "TEACHER", 3: "SUBJECT", 4: "ROOM", 5: "STUDENT" }[credentials.personType || 5] || "STUDENT";
    const result = await webUntisCall(credentials, "getTimetable2017", {
      id: credentials.personId,
      type: legacyType,
      startDate: startIso,
      endDate: endIso,
      masterDataTimestamp: 0,
      timetableTimestamp: 0,
      timetableTimestamps: [0, 0, 0, 0, 0, 0, 0]
    });
    if (Array.isArray(result)) return result;
    return result?.periods || result?.timetable || [];
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === "POST" && url.pathname === "/api/pair/create") return json(response, 200, createPair());
    if (request.method === "POST" && url.pathname === "/api/glasses/pair") {
      const credentials = await loadCredentials();
      if (credentials?.deviceId) return json(response, 200, { id: credentials.deviceId, connected: true });
      const pair = createPair();
      return json(response, 200, pair);
    }
    if (request.method === "GET" && url.pathname === "/api/app-status") {
      const credentials = await loadCredentials();
      return json(response, 200, { connected: Boolean(credentials?.deviceId) });
    }
    if (request.method === "POST" && url.pathname === "/api/disconnect") {
      cachedCredentials = null;
      if (existsSync(credentialsFile)) {
        await writeFile(credentialsFile, "", { mode: 0o600 });
      }
      return json(response, 200, { connected: false });
    }
    if (request.method === "GET" && url.pathname === "/api/pair/status") {
      const pair = pairs.get(url.searchParams.get("id"));
      const credentials = await loadCredentials();
      if (credentials?.deviceId === url.searchParams.get("id")) {
        return json(response, 200, { status: "connected", connected: true });
      }
      if (!pair) return json(response, 404, { error: "Kopplung nicht gefunden." });
      return json(response, 200, { status: pair.status, code: pair.code, connected: pair.status === "connected" });
    }
    if (request.method === "POST" && url.pathname === "/api/pair/claim") {
      const body = await readJson(request);
      const pair = [...pairs.values()].find((item) => item.code === String(body.code));
      if (!pair || Date.now() - pair.createdAt > 10 * 60 * 1000) return json(response, 400, { error: "Code ungültig oder abgelaufen." });
      pair.status = "connected";
      pair.credentials = await authenticate(body);
      pair.credentials.deviceId = pair.id;
      cachedCredentials = pair.credentials;
      await saveCredentials(pair.credentials);
      return json(response, 200, { connected: true });
    }
    if (request.method === "GET" && url.pathname === "/api/timetable") {
      const credentials = await loadCredentials();
      if (!credentials) return json(response, 401, { error: "Noch nicht mit WebUntis verbunden." });
      try {
        return json(response, 200, { entries: await timetable(credentials) });
      } catch (error) {
        if (!credentials.password) throw error;
        const renewed = await authenticate(credentials);
        renewed.deviceId = credentials.deviceId;
        cachedCredentials = renewed;
        await saveCredentials(renewed);
        return json(response, 200, { entries: await timetable(renewed) });
      }
    }
    if (request.method === "GET") {
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
      const filename = path.normalize(path.join(publicDir, relative));
      if (filename !== publicDir && !filename.startsWith(`${publicDir}${path.sep}`)) return json(response, 403, { error: "Nicht erlaubt." });
      const content = await readFile(filename);
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] || "application/octet-stream" });
      return response.end(content);
    }
    return json(response, 404, { error: "Nicht gefunden." });
  } catch (error) {
    console.error(error);
    const message = error.webUntisCode === -1
      ? "WebUntis lehnt die Anmeldung ab. Prüfe Benutzername, Passwort und dass du nicht den WebUntis-QR-Schlüssel als Passwort eingibst."
      : error.message || "Unbekannter Fehler.";
    return json(response, 502, { error: message });
  }
}

if (!existsSync(certificateFile) || !existsSync(keyFile)) {
  console.error(`HTTPS-Zertifikat fehlt. Erwartet:\n  ${certificateFile}\n  ${keyFile}`);
  console.error("Erzeuge es mit dem Zertifikatsbefehl aus README.md.");
  process.exitCode = 1;
} 
const hasTls = existsSync(certificateFile) && existsSync(keyFile);
const server = hasTls
  ? https.createServer({ cert: await readFile(certificateFile), key: await readFile(keyFile) }, route)
  : http.createServer(route);
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} ist bereits belegt. Beende den laufenden Server oder starte mit: $env:PORT=3001; npm start`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
server.listen(port, () => {
  console.log(`WebUntis Glasses läuft auf ${hasTls ? "https" : "http"}://localhost:${port}`);
});
