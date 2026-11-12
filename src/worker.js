const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PAIR_TTL = 10 * 60 * 1000
const hash = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) return {}
  try { return await request.json() } catch { throw new Error('Ungültige JSON-Anfrage.') }
}

function encode(bytes) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function key(secret) {
  if (!secret) throw new Error('WEBUNTIS_ENCRYPTION_KEY fehlt in den Worker-Secrets.')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encrypt(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), encoder.encode(JSON.stringify(value)))
  return JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(data)) })
}

async function decrypt(value, secret) {
  const payload = JSON.parse(value)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(payload.iv) }, await key(secret), decode(payload.data))
  return JSON.parse(decoder.decode(plain))
}

async function loadProfile(env, deviceId = '') {
  if (deviceId) {
    const row = await env.DB.prepare('SELECT encrypted_profile FROM account_profiles WHERE device_id = ?').bind(deviceId).first()
    if (row) return decrypt(row.encrypted_profile, env.WEBUNTIS_ENCRYPTION_KEY)
    const legacy = await env.DB.prepare('SELECT encrypted_profile FROM app_state WHERE id = 1').first()
    if (!legacy) return null
    const profile = await decrypt(legacy.encrypted_profile, env.WEBUNTIS_ENCRYPTION_KEY)
    return profile?.deviceId === deviceId ? profile : null
  }
  const legacy = await env.DB.prepare('SELECT encrypted_profile FROM app_state WHERE id = 1').first()
  return legacy ? decrypt(legacy.encrypted_profile, env.WEBUNTIS_ENCRYPTION_KEY) : null
}

async function saveProfile(env, profile, deviceId = profile?.deviceId || '') {
  const encrypted = await encrypt(profile, env.WEBUNTIS_ENCRYPTION_KEY)
  if (deviceId) {
    await env.DB.prepare('INSERT INTO account_profiles (device_id, encrypted_profile, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET encrypted_profile = excluded.encrypted_profile, updated_at = excluded.updated_at')
      .bind(deviceId, encrypted, Date.now()).run()
    return
  }
  await env.DB.prepare('INSERT INTO app_state (id, encrypted_profile, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET encrypted_profile = excluded.encrypted_profile, updated_at = excluded.updated_at')
    .bind(encrypted, Date.now()).run()
}

async function rpc(profile, method, params, sessionId = '') {
  const endpoint = new URL('/WebUntis/jsonrpc.do', profile.baseUrl)
  endpoint.searchParams.set('school', profile.school)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { Cookie: `JSESSIONID=${sessionId}; schoolname=_${btoa(profile.school)}` } : {}),
    },
    body: JSON.stringify({ id: String(Date.now()), method, params, jsonrpc: '2.0' }),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    const error = new Error(`WebUntis antwortet mit HTTP ${response.status}.`)
    error.httpStatus = response.status
    throw error
  }
  const payload = await response.json()
  if (payload.error) {
    const error = new Error(payload.error.message || payload.error.data || 'WebUntis-Anfrage fehlgeschlagen.')
    error.webUntisCode = payload.error.code
    throw error
  }
  return payload.result
}

async function authenticate(profile) {
  if (!profile.username || !profile.password) throw new Error('Benutzername und Passwort sind erforderlich.')
  const baseUrl = String(profile.baseUrl || 'https://ggb.webuntis.com').replace(/\/+$/, '')
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('WebUntis muss über eine gültige HTTPS-Adresse erreichbar sein.')
  const clean = { ...profile, baseUrl, school: String(profile.school || 'ggb').trim(), username: String(profile.username).trim() }
  const result = await rpc(clean, 'authenticate', { user: clean.username, password: clean.password, client: 'WebUntis Glasses' })
  if (!result?.sessionId || !Number.isInteger(result.personId) || !Number.isInteger(result.personType)) throw new Error('WebUntis hat keine gültige Sitzung zurückgegeben.')
  return { ...clean, sessionId: result.sessionId, personId: result.personId, personType: result.personType, sessionUpdatedAt: Date.now() }
}

async function timetable(profile) {
  let active = profile
  try {
    if (!active.sessionId) throw new Error('Sitzung fehlt.')
    return { entries: await fetchTimetable(active) }
  } catch (error) {
    if (error.webUntisCode !== -8504 && error.httpStatus !== 401 && error.httpStatus !== 403 && !/session|sitzung|not valid/i.test(error.message)) throw error
    active = await authenticate(active)
    return { entries: await fetchTimetable(active), profile: active }
  }
}

async function fetchTimetable(profile) {
  const start = berlinDate(new Date())
  const finish = new Date(start)
  finish.setUTCDate(finish.getUTCDate() + 7)
  const result = await rpc(profile, 'getTimetable', { options: {
    id: Date.now(), element: { id: profile.personId, type: profile.personType },
    startDate: untisDate(start), endDate: untisDate(finish), showLsText: true, showStudentgroup: true,
    showLsNumber: true, showSubstText: true, showInfo: true, showBooking: true,
    klasseFields: ['id', 'name', 'longname', 'externalkey'], roomFields: ['id', 'name', 'longname', 'externalkey'],
    subjectFields: ['id', 'name', 'longname', 'externalkey'], teacherFields: ['id', 'name', 'longname', 'externalkey'],
  } }, profile.sessionId)
  return result || []
}

function berlinDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
}

function untisDate(date) { return Number(date.toISOString().slice(0, 10).replaceAll('-', '')) }

function hasDashboardSession(request, profile) {
  const cookie = request.headers.get('Cookie') || ''
  const token = cookie.match(/(?:^|;\s*)webuntis_session=([^;]+)/)?.[1]
  return Boolean(token && profile?.dashboardToken && token === profile.dashboardToken)
}

function readCookie(request, name) {
  const value = request.headers.get('Cookie') || ''
  return value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || ''
}

function sharedDeviceCookie(value) {
  return `mda_device=${value}; Domain=henning-orbit-calendar.workers.dev; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`
}

async function centralDeviceForSession(request, env) {
  const cookie = request.headers.get('Cookie') || ''
  if (!cookie) return null
  const response = await env.META_DISPLAY_APPS.fetch(new Request('https://meta-display-apps.henning-orbit-calendar.workers.dev/api/device/me', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(8000) }))
  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  return data?.connected && /^[a-f0-9]{64}$/.test(data.deviceHash || '') ? data.deviceHash : null
}

async function centralDeviceForToken(deviceToken, env) {
  if (!deviceToken) return null
  if (!env.MDA_LINK_SECRET) {
    console.warn('Meta Display Apps device resolution unavailable', { reason: 'missing_secret' })
    return null
  }
  const response = await env.META_DISPLAY_APPS.fetch(new Request('https://meta-display-apps.henning-orbit-calendar.workers.dev/api/device/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MDA_LINK_SECRET}` },
    body: JSON.stringify({ deviceToken }), signal: AbortSignal.timeout(8000),
  }))
  if (!response.ok) {
    console.warn('Meta Display Apps device resolution failed', { status: response.status })
    return null
  }
  const data = await response.json().catch(() => null)
  const validDeviceHash = /^[a-f0-9]{64}$/.test(data?.deviceHash || '')
  if (!data?.connected || !validDeviceHash) console.info('Meta Display Apps device token is not registered', { connected: Boolean(data?.connected), validDeviceHash })
  return data?.connected && validDeviceHash ? data.deviceHash : null
}

async function createPair(env, deviceToken = encode(crypto.getRandomValues(new Uint8Array(24)))) {
  const id = await hash(deviceToken)
  const deviceHash = id
  await env.DB.prepare('DELETE FROM pairings WHERE created_at < ?').bind(Date.now() - PAIR_TTL).run()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000)
    const createdAt = Date.now()
    try {
      await env.DB.prepare(`INSERT INTO pairings (id, code, created_at, mda_device_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at,
          mda_device_hash = excluded.mda_device_hash, status = 'waiting'`)
        .bind(id, code, createdAt, deviceHash).run()
      return { id, code, deviceToken, deviceHash }
    } catch (error) {
      if (attempt === 4) throw error
    }
  }
  throw new Error('Es konnte kein WebUntis-Verbindungscode erstellt werden.')
}

async function route(request, env) {
  const url = new URL(request.url)
  try {
    if (request.method === 'POST' && url.pathname === '/api/pair/create') {
      const pair = await createPair(env, readCookie(request, 'mda_device') || undefined)
      return json({ id: pair.id, code: pair.code }, 200, { 'Set-Cookie': sharedDeviceCookie(pair.deviceToken) })
    }
    if (request.method === 'GET' && url.pathname === '/api/app-status') {
      const accountDevice = await centralDeviceForSession(request, env).catch(() => null)
      const deviceId = accountDevice || readCookie(request, 'webuntis_device')
      const profile = deviceId ? await loadProfile(env, deviceId) : await loadProfile(env)
      return json({ connected: Boolean(profile?.deviceId && (accountDevice || hasDashboardSession(request, profile))) })
    }
    if (request.method === 'POST' && url.pathname === '/api/disconnect') {
      const body = await readJson(request)
      const accountDevice = await centralDeviceForSession(request, env).catch(() => null)
      const deviceId = accountDevice || readCookie(request, 'webuntis_device')
      if (deviceId) {
        const profile = await loadProfile(env, deviceId)
        if (!accountDevice && !hasDashboardSession(request, profile) && body.deviceId !== profile?.deviceId) return json({ error: 'Keine Berechtigung zum Trennen der Verbindung.' }, 401)
        await env.DB.prepare('DELETE FROM account_profiles WHERE device_id = ?').bind(deviceId).run()
        await env.DB.prepare('DELETE FROM pairings WHERE mda_device_hash = ?').bind(deviceId).run()
      } else {
        const profile = await loadProfile(env)
        if (!hasDashboardSession(request, profile) && body.deviceId !== profile?.deviceId) return json({ error: 'Keine Berechtigung zum Trennen der Verbindung.' }, 401)
        await env.DB.prepare('DELETE FROM app_state WHERE id = 1').run()
      }
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      headers.append('Set-Cookie', 'webuntis_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict')
      headers.append('Set-Cookie', 'webuntis_device=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict')
      return new Response(JSON.stringify({ connected: false }), { headers })
    }
    if (request.method === 'GET' && url.pathname === '/api/pair/status') {
      const id = url.searchParams.get('id') || ''
      const profile = await loadProfile(env, id)
      if (profile?.deviceId === id) return json({ status: 'connected', connected: true })
      const legacy = await loadProfile(env)
      if (legacy?.deviceId === id) return json({ status: 'connected', connected: true })
      const pair = await env.DB.prepare('SELECT id, code, created_at, status FROM pairings WHERE id = ?').bind(id).first()
      if (!pair || Date.now() - pair.created_at > PAIR_TTL) return json({ error: 'Kopplung nicht gefunden.' }, 404)
      return json({ status: pair.status, code: pair.code, connected: pair.status === 'connected' })
    }
    if (request.method === 'POST' && url.pathname === '/api/pair/claim') {
      const body = await readJson(request)
      const code = String(body.code || '').replace(/\s/g, '')
      let deviceId
      if (code) {
        if (!/^\d{6}$/.test(code)) return json({ error: 'Bitte den sechsstelligen Verbindungscode eingeben.' }, 400)
        const pair = await env.DB.prepare('SELECT id, created_at, mda_device_hash FROM pairings WHERE code = ? ORDER BY created_at DESC LIMIT 1').bind(code).first()
        if (!pair || Date.now() - pair.created_at > PAIR_TTL) return json({ error: 'Code ungültig oder abgelaufen.' }, 400)
        deviceId = pair.mda_device_hash || pair.id
      } else {
        deviceId = await centralDeviceForSession(request, env).catch(() => null)
        if (!deviceId) return json({ error: 'Melde dich bei Meta Display Apps an und verknüpfe zuerst deine Brille, oder gib den Code ein.' }, 401)
      }
      const profile = await authenticate({ ...body, deviceId })
      profile.dashboardToken = encode(crypto.getRandomValues(new Uint8Array(32)))
      await saveProfile(env, profile, deviceId)
      if (code) await env.DB.prepare('UPDATE pairings SET status = \'connected\' WHERE code = ?').bind(code).run()
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      headers.append('Set-Cookie', `webuntis_session=${profile.dashboardToken}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`)
      headers.append('Set-Cookie', `webuntis_device=${deviceId}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`)
      return new Response(JSON.stringify({ connected: true, deviceId }), { headers })
    }
    if (request.method === 'POST' && url.pathname === '/api/mda/resolve-code') {
      if (!env.MDA_LINK_SECRET || request.headers.get('Authorization') !== `Bearer ${env.MDA_LINK_SECRET}`) return json({ error: 'Unauthorized.' }, 401)
      const body = await readJson(request)
      const code = String(body.code || '').replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) return json({ error: 'Enter the six-digit code shown in WebUntis Glasses.' }, 400)
      const pair = await env.DB.prepare('SELECT id, created_at, mda_device_hash FROM pairings WHERE code = ?').bind(code).first()
      if (!pair || !pair.mda_device_hash || Date.now() - pair.created_at > PAIR_TTL) return json({ error: 'That WebUntis Glasses code is invalid or has expired.' }, 400)
      return json({ deviceId: pair.id, deviceHash: pair.mda_device_hash })
    }
    if (request.method === 'GET' && url.pathname === '/api/glasses/status') {
      const deviceId = url.searchParams.get('deviceId')
      const profile = await loadProfile(env, deviceId)
      return json({ connected: Boolean(profile?.deviceId && profile.deviceId === deviceId), profileMissing: !profile?.deviceId, profile: null })
    }
    if (request.method === 'POST' && url.pathname === '/api/glasses/pair') {
      const body = await readJson(request)
      const mdaToken = readCookie(request, 'mda_device')
      const registeredDevice = await centralDeviceForToken(mdaToken, env).catch(() => null)
      if (registeredDevice) {
        const profile = await loadProfile(env, registeredDevice)
        console.info('WebUntis glasses recognized a shared device', { profileFound: Boolean(profile) })
        return new Response(JSON.stringify({ id: registeredDevice, connected: Boolean(profile), registered: true, setupRequired: !profile }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sharedDeviceCookie(mdaToken) } })
      }
      const cookieId = readCookie(request, 'webuntis_device')
      const profile = body.deviceId ? await loadProfile(env, body.deviceId) : await loadProfile(env)
      const knownId = body.deviceId || cookieId
      if (profile?.deviceId && knownId === profile.deviceId) {
        return new Response(JSON.stringify({ id: profile.deviceId, connected: true }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `webuntis_device=${profile.deviceId}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict` } })
      }
      console.info('WebUntis glasses creating a fresh pairing', { hasSharedDeviceToken: Boolean(mdaToken), hasSavedDeviceId: Boolean(body.deviceId || cookieId) })
      const pair = await createPair(env, mdaToken || undefined)
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      headers.append('Set-Cookie', sharedDeviceCookie(pair.deviceToken))
      headers.append('Set-Cookie', `webuntis_device=${pair.id}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`)
      return new Response(JSON.stringify({ id: pair.id, code: pair.code }), { headers })
    }
    if (request.method === 'GET' && (url.pathname === '/api/timetable' || url.pathname === '/api/glasses/timetable')) {
      const accountDevice = url.pathname === '/api/timetable' ? await centralDeviceForSession(request, env).catch(() => null) : null
      const linkedDevice = url.pathname === '/api/timetable'
        ? accountDevice || readCookie(request, 'webuntis_device')
        : url.searchParams.get('deviceId') || ''
      const profile = linkedDevice ? await loadProfile(env, linkedDevice) : await loadProfile(env)
      if (!profile?.deviceId) return json({ error: 'Noch nicht mit WebUntis verbunden.' }, 401)
      if (url.pathname === '/api/timetable' && !accountDevice && !hasDashboardSession(request, profile)) return json({ error: 'Bitte melde dich erneut an, um den Stundenplan in diesem Browser zu öffnen.' }, 401)
      if (url.pathname === '/api/glasses/timetable' && url.searchParams.get('deviceId') !== profile.deviceId) return json({ error: 'Brillengerät nicht registriert.' }, 401)
      const result = await timetable(profile)
      if (result.profile) await saveProfile(env, result.profile, linkedDevice || undefined)
      const now = berlinDate(new Date())
      const today = untisDate(now)
      const berlinParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
      const currentTime = Number(`${berlinParts.hour}${berlinParts.minute}`)
      const includePast = url.searchParams.get('includePast') === '1'
      const entries = (result.entries || []).map((lesson) => ({ date: lesson.date, startTime: lesson.startTime, endTime: lesson.endTime, subjects: lesson.su || [], rooms: lesson.ro || [], teachers: lesson.te || [], classes: lesson.kl || [], info: lesson.info, substitution: lesson.substText, cancelled: lesson.code === 'cancelled' }))
        .filter((lesson) => {
          const date = Number(String(lesson.date || '').replaceAll('-', ''))
          const end = Number(String(lesson.endTime || '0').padStart(4, '0'))
          return includePast || date > today || (date === today && end > currentTime)
        })
        .sort((a, b) => Number(String(a.date).replaceAll('-', '')) - Number(String(b.date).replaceAll('-', '')) || Number(a.startTime) - Number(b.startTime))
      return json({ entries })
    }
    if (request.method === 'GET' || request.method === 'HEAD') return env.ASSETS.fetch(request)
    return json({ error: 'Nicht gefunden.' }, 404)
  } catch (error) {
    console.error('WebUntis request failed:', error.message)
    const message = error.webUntisCode === -8504 || error.webUntisCode === -1
      ? 'WebUntis lehnt die Anmeldung ab. Prüfe Benutzername, Passwort, Schulkennung und Server.'
      : error.message || 'Unbekannter Fehler.'
    return json({ error: message }, 502)
  }
}

export default { fetch: route }
