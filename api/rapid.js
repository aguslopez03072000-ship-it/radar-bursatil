// Avisos de movimientos rápidos en los futuros perpetuos de acciones de BingX, para el Radar bursátil.
// GET /api/rapid            revisa y, si hay algo nuevo, manda la notificación por ntfy
// GET /api/rapid?dry=1      revisa y devuelve el resultado sin mandar nada (para probar desde el navegador)
// GET /api/rapid?test=1     manda una notificación de prueba
// La llama cron-job.org cada minuto. Un movimiento rápido es una variación de 8% o más en los últimos
// 4 minutos (velas de 1 minuto del perpetuo). Para no repetir el aviso, solo avisa cuando la variación
// pasa a un escalón nuevo (8%, 16%, 24%...) respecto de lo que se veía en la revisión anterior.
//
// También avisa de los movimientos fuertes (los mismos que muestra la página), solo de acciones con perpetuo:
//   - en la rueda normal, acciones de Wall Street que suben o bajan 15% o más en el día (listas de Yahoo);
//   - fuera de la rueda (pre-apertura, después del cierre, noches y fines de semana), el perpetuo de las
//     acciones vigiladas contra su último cierre normal, desde 10%;
//   - bitcoin, 10% o más en 24 horas.
// Para no repetirlos, avisa la primera vez que la variación llega a 15% (o 10%) y después cada 10 puntos más,
// comparando contra lo que ya se veía antes en el día (o en las últimas dos horas, para los perpetuos).
//
// Variables de entorno en Vercel:
//   NTFY_TOPIC         nombre secreto del canal de ntfy al que está suscripto el celular
//   TELEGRAM_TOKEN     token del bot de Telegram (de BotFather)
//   TELEGRAM_CHAT_ID   chat al que manda el bot; si falta, ?test=1 lo busca y lo muestra
//   (hace falta al menos uno de los dos canales)
//   RAPID_KEY    si se define, la ruta exige ?key=<RAPID_KEY>
//   RAPID_EXTRA  tickers extra separados por coma (opcional)

const futures = require("./_futures");
const tg = require("./_telegram");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// Acciones con perpetuo confirmado en BingX (noviembre de 2026).
const TICKERS = [
  "TSLA", "AAPL", "GOOGL", "AMZN", "META", "MSTR", "COIN", "HOOD", "INTC", "APP", "ORCL", "PLTR", "RIOT", "GME",
  "NVDA", "MRVL", "ARM", "BABA", "ASML", "CRCL", "GE", "MCD",
  "MSFT", "AVGO", "MU", "SNDK", "COST", "MDLZ", "CTAS", "GH", "COF", "KMB", "FISV", "ENPH", "ALNY", "ULTA", "GM", "MSCI",
  "PLD", "FRHC", "CCJ", "GLXY", "ONON", "ANT", "ADI",
  // Lista de seguimiento y oportunidades: se vigilan solo si tienen perpetuo (si no, quedan como "Sin contrato encontrado").
  "DELL", "ANF", "PANW", "TSM", "AMD", "LLY", "HUT", "NU", "BRK-B", "YPF", "MELI"
];
const NAMES = { ANT: "Anthropic" };
const CANDLE_MIN = 1;
const REF_TTL = 10 * 60 * 1000;
const refCache = {};
const SYMBOL_OK = /^[A-Z0-9.\-]{1,10}$/;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e && e.message || e) }; } } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// Precio de referencia de la acción (último precio normal), para reconocer el contrato correcto.
async function refPrice(symbol) {
  const j = await getJson("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=5d&interval=1d");
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const m = (res && res.meta) || {};
  const px = typeof m.regularMarketPrice === "number" ? m.regularMarketPrice : m.chartPreviousClose;
  if (!px) throw new Error("Sin precio");
  return { price: px, name: m.shortName || m.longName || null };
}

// Sesión de Wall Street según la hora de Nueva York (sin contemplar feriados: en un feriado el último
// precio normal de Yahoo es el cierre anterior, así que la comparación igual es correcta).
function nySession(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = function (t) { const p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ""; };
  const wd = get("weekday"), mins = (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10);
  if (wd === "Sat" || wd === "Sun") return "fin de semana";
  if (mins >= 570 && mins < 960) return "rueda";
  if (mins >= 240 && mins < 570) return "pre-apertura";
  if (mins >= 960 && mins < 1200) return "después del cierre";
  return "noche";
}

// Los precios de referencia cambian poco: se guardan 10 minutos mientras la función siga activa.
async function cachedRef(symbol) {
  const c = refCache[symbol];
  const sess = nySession(Date.now());
  // Si el precio se guardó durante la rueda y la rueda ya terminó, se vuelve a pedir para tener el cierre.
  const stale = c && c.sess === "rueda" && sess !== "rueda";
  if (c && !stale && Date.now() - c.at < REF_TTL) return c.v;
  const v = await refPrice(symbol);
  refCache[symbol] = { at: Date.now(), v: v, sess: sess };
  return v;
}

// Velas de 1 minuto, de la más vieja a la más nueva: [{t, o, c}]
async function bingxCandles(symbol, n) {
  const j = await getJson("https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=" + encodeURIComponent(symbol) + "&interval=1m&limit=" + n);
  if (!j || !Array.isArray(j.data)) throw new Error((j && j.msg) || "Sin velas");
  return normalize(j.data.map(function (k) {
    if (Array.isArray(k)) return { t: +k[0], o: +k[1], c: +k[4] };
    return { t: +(k.time != null ? k.time : k.openTime), o: +k.open, c: +k.close };
  }));
}

async function bitgetCandles(symbol, n) {
  const j = await getJson("https://api.bitget.com/api/v2/mix/market/candles?symbol=" + encodeURIComponent(symbol) + "&productType=usdt-futures&granularity=1m&limit=" + n);
  if (!j || !Array.isArray(j.data)) throw new Error((j && j.msg) || "Sin velas");
  return normalize(j.data.map(function (k) { return { t: +k[0], o: +k[1], c: +k[4] }; }));
}

function normalize(arr) {
  return arr.filter(function (k) { return isFinite(k.t) && k.o > 0 && k.c > 0; }).sort(function (a, b) { return a.t - b.t; });
}

// Mayor variación dentro de la ventana que termina en la vela "end" (incluida):
// del precio actual contra el mínimo o el máximo de la ventana (apertura de la primera vela y cierres).
function moveAt(c, end, w) {
  const start = end - w + 1;
  if (start < 0) return null;
  const now = c[end].c;
  const pts = [c[start].o];
  for (let i = start; i < end; i++) pts.push(c[i].c);
  const lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
  const up = (now / lo - 1) * 100, down = (now / hi - 1) * 100;
  return Math.abs(up) >= Math.abs(down) ? { pct: up, from: lo, now: now } : { pct: down, from: hi, now: now };
}

function level(pct, min) { return Math.floor(Math.abs(pct) / min) * (pct < 0 ? -1 : 1); }

// Hay aviso nuevo si la variación llegó a un escalón que no se veía en la revisión anterior (vela previa).
function evaluate(candles, min, w, nowMs) {
  if (!candles || candles.length < w + 1) return null;
  const last = candles[candles.length - 1];
  if (nowMs - last.t > 5 * 60000) return null; // el contrato no está operando
  const cur = moveAt(candles, candles.length - 1, w);
  const prev = moveAt(candles, candles.length - 2, w);
  if (!cur) return null;
  const L = level(cur.pct, min);
  const P = prev ? level(prev.pct, min) : 0;
  const fresh = L !== 0 && (Math.sign(L) !== Math.sign(P) || Math.abs(L) > Math.abs(P));
  return { pct: cur.pct, from: cur.from, price: cur.now, level: L, prevLevel: P, alert: fresh };
}

function fmtPct(x) { return (x >= 0 ? "+" : "") + x.toFixed(1).replace(".", ",") + "%"; }
function fmtPx(x) { return "US$" + (x >= 100 ? x.toFixed(2) : x.toPrecision(4)).replace(".", ","); }

async function ntfy(topic, title, message, high, click) {
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: topic, title: title, message: message, priority: high ? 5 : 4, tags: ["chart_with_upwards_trend"], click: click || undefined })
  });
  if (!r.ok) throw new Error("ntfy HTTP " + r.status);
}

// Chats que le escribieron al bot (para averiguar el TELEGRAM_CHAT_ID).
async function telegramChats(token) {
  const j = await getJson("https://api.telegram.org/bot" + token + "/getUpdates");
  const seen = {};
  ((j && j.result) || []).forEach(function (u) {
    const c = (u.message || u.edited_message || u.channel_post || {}).chat;
    if (c && c.id != null) seen[c.id] = { chatId: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || c.username || null };
  });
  return Object.keys(seen).map(function (k) { return seen[k]; });
}

// Manda por todos los canales configurados; devuelve los errores (vacío si salió todo bien).
// "kind" define el encabezado en Telegram (⚡ rápido, 📊 fuerte...), para distinguir los avisos.
async function notify(ch, kind, title, message, high, click) {
  const errors = [];
  if (ch.topic) { try { await ntfy(ch.topic, title, message, high, click); } catch (e) { errors.push(String(e && e.message || e)); } }
  if (ch.tgToken && ch.tgChat) { try { await tg.send(ch.tgToken, ch.tgChat, kind, title, message, click); } catch (e) { errors.push(String(e && e.message || e)); } }
  return errors;
}

// ---------- Movimientos fuertes (los de la página) ----------
const STRONG_REGULAR = 15, STRONG_EXTENDED = 10, STRONG_STEP = 10, STRONG_LOOKBACK = 121;
const movers = require("./movers");

// Escalón de un movimiento fuerte: 0 debajo del umbral; 1 al llegar al umbral y uno más cada 10 puntos. Con signo.
function strongLevel(pct, thr, step) {
  const a = Math.abs(pct);
  if (a < thr) return 0;
  return (1 + Math.floor((a - thr) / (step || STRONG_STEP))) * (pct < 0 ? -1 : 1);
}

// Aviso nuevo si el escalón actual supera a todos los que ya se vieron antes (misma dirección).
function freshLevel(cur, prevs) {
  if (!cur) return false;
  for (const p of prevs) { if (Math.sign(p) === Math.sign(cur) && Math.abs(p) >= Math.abs(cur)) return false; }
  return true;
}

// Perpetuo contra el último cierre normal, fuera de la rueda. Usa las velas de 1 minuto de las últimas dos horas.
function evaluateStrongPerp(candles, ref, nowMs, thr, step) {
  if (!candles || candles.length < 2 || !ref) return null;
  thr = thr || STRONG_EXTENDED;
  const last = candles[candles.length - 1];
  if (nowMs - last.t > 5 * 60000) return null;
  const pct = (last.c / ref - 1) * 100;
  const L = strongLevel(pct, thr, step);
  const prevs = candles.slice(0, -1).map(function (k) { return strongLevel((k.c / ref - 1) * 100, thr, step); });
  return { pct: pct, price: last.c, ref: ref, level: L, alert: freshLevel(L, prevs) };
}

// Rueda normal: candidatas de las listas de Yahoo; para no repetir, se mira la variación de más temprano en el día.
async function regularStrong(maps, nowMs) {
  const lists = await Promise.all(movers.LISTS.map(function (id) { return movers.screener(id).catch(function () { return []; }); }));
  const seen = {}, cands = [];
  lists.forEach(function (qs) {
    qs.forEach(function (q) {
      const chg = movers.num(q.regularMarketChangePercent), price = movers.num(q.regularMarketPrice), cap = movers.num(q.marketCap);
      if (chg === null || Math.abs(chg) < STRONG_REGULAR || seen[q.symbol]) return;
      if (price !== null && price < movers.MIN_PRICE) return;
      if (cap !== null && cap < movers.MIN_CAP) return;
      if (!futures.isCommonStock(q.symbol)) return;
      seen[q.symbol] = true;
      if (!futures.match(maps.bingx, q.symbol, price)) return; // Agus solo quiere avisos de acciones con perpetuo en BingX
      const where = "BingX";
      cands.push({ ticker: q.symbol, name: q.shortName || q.longName || q.symbol, pct: chg, price: price, where: where });
    });
  });
  const out = await pool(cands, 6, async function (c) {
    const j = await getJson("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(c.ticker) + "?range=1d&interval=1m");
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const prevClose = res && res.meta && res.meta.chartPreviousClose;
    const ts = (res && res.timestamp) || [];
    const closes = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
    const L = strongLevel(c.pct, STRONG_REGULAR);
    const prevs = [];
    if (prevClose) for (let i = 0; i < ts.length; i++) {
      if (typeof closes[i] === "number" && ts[i] * 1000 < nowMs - 60000) prevs.push(strongLevel((closes[i] / prevClose - 1) * 100, STRONG_REGULAR));
    }
    return Object.assign(c, { kind: "fuerte", session: "en la rueda", level: L, alert: freshLevel(L, prevs) });
  });
  return out.filter(function (x) { return x && !x.error; });
}

// Bitcoin: 10% o más en 24 horas (velas de 15 minutos del perpetuo de BingX).
async function bitcoinStrong() {
  const j = await getJson("https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=BTC-USDT&interval=15m&limit=106");
  const c = normalize(((j && j.data) || []).map(function (k) {
    if (Array.isArray(k)) return { t: +k[0], o: +k[1], c: +k[4] };
    return { t: +(k.time != null ? k.time : k.openTime), o: +k.open, c: +k.close };
  }));
  if (c.length < 97) return null;
  const at = function (i) { return (c[i].c / c[i - 96].c - 1) * 100; };
  const n = c.length - 1;
  const pct = at(n), L = strongLevel(pct, STRONG_EXTENDED);
  const prevs = [];
  for (let i = Math.max(96, n - 8); i < n; i++) prevs.push(strongLevel(at(i), STRONG_EXTENDED));
  return { ticker: "BTC", name: "Bitcoin", kind: "fuerte", session: "en 24 horas", pct: pct, price: c[n].c, where: "BingX", level: L, alert: freshLevel(L, prevs) };
}


// ---------- Aviso una hora antes de cada reporte de la lista ----------
// Lee watchlist.json de la propia página. Si el reporte tiene hora confirmada ("hour", hora de Nueva York) usa esa;
// si no, toma 7:00 para "antes de la apertura" y 16:05 para "después del cierre". Sin horario no avisa
// (la tarea de las 9:20 ya avisa las que reportan ese día).
const REMIND_BEFORE = 60, REMIND_WINDOW = 3; // minutos
const remindSent = {}; // evita repetir el aviso mientras la función sigue activa

// Milisegundos UTC de una fecha y hora de Nueva York (contempla el horario de verano).
function nyToUtc(dateIso, hhmm) {
  const [y, m, d] = dateIso.split("-").map(Number), [h, mi] = hhmm.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, h + 5, mi);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess));
    const gh = parseInt(parts.find(function (x) { return x.type === "hour"; }).value, 10) % 24;
    const gm = parseInt(parts.find(function (x) { return x.type === "minute"; }).value, 10);
    guess += ((h * 60 + mi) - (gh * 60 + gm)) * 60000;
  }
  return guess;
}

function fmtAR(ms) {
  return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

async function loadWatchlist(site, nowMs) {
  if (!site) return [];
  const base = site.replace(/#.*$/, "").replace(/\/$/, "");
  const j = await getJson(base + "/watchlist.json?t=" + Math.floor(nowMs / 60000));
  return (j && j.items) || [];
}

function reportReminders(items, nowMs) {
  const out = [];
  (items || []).forEach(function (w) {
    const n = w.next || {};
    if (!n.date || !n.confirmed) return;
    const hour = /^\d{1,2}:\d{2}$/.test(n.hour || "") ? n.hour : n.time === "antes de la apertura" ? "07:00" : n.time === "después del cierre" ? "16:05" : null;
    if (!hour) return;
    const at = nyToUtc(n.date, hour);
    const mins = (at - nowMs) / 60000;
    const due = mins <= REMIND_BEFORE && mins > REMIND_BEFORE - REMIND_WINDOW;
    const key = w.ticker + "|" + n.date;
    out.push({ ticker: w.ticker, name: w.name, at: new Date(at).toISOString(), minutesLeft: Math.round(mins), due: due && !remindSent[key], hourNY: hour, exact: !!n.hour, time: n.time || null, quarter: n.quarter || null, expect: w.expect || "", key: key });
  });
  return out;
}


// ---------- Movimientos tras el reporte ----------
// Desde que una empresa de la lista presenta su balance y durante la conferencia (unas 3 horas; si reporta antes
// de la apertura, hasta las 9:30 de Nueva York), avisa cuando su perpetuo de BingX se mueve 7% o más contra el
// último cierre normal, y después cada 7 puntos más (14%, 21%...).
const EARN_THR = 7, EARN_STEP = 7, EARN_HOURS = 3;
function normTicker(t) { return String(t || "").toUpperCase().replace(/[.\-]/g, ""); }
function nyDate(ms) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

function earningsWindows(items, nowMs) {
  const today = nyDate(nowMs), out = {};
  (items || []).forEach(function (w) {
    const n = w.next || {}, key = normTicker(w.ticker);
    let start = null, end = null;
    if (n.date === today && n.confirmed) {
      const hour = /^\d{1,2}:\d{2}$/.test(n.hour || "") ? n.hour : n.time === "antes de la apertura" ? "07:00" : n.time === "después del cierre" ? "16:05" : null;
      if (hour) {
        start = nyToUtc(today, hour) - 5 * 60000;
        end = start + EARN_HOURS * 3600000 + 5 * 60000;
        if (n.time === "antes de la apertura" || parseInt(hour, 10) < 9) end = Math.min(end, nyToUtc(today, "09:30"));
      }
    }
    // Si la tarea ya pasó el resultado a "last", el reporte fue hoy: se vigila el resto de la rueda extendida.
    if (!start && w.last && w.last.date === today) {
      const pre = [nyToUtc(today, "04:00"), nyToUtc(today, "09:30")], post = [nyToUtc(today, "16:00"), nyToUtc(today, "20:00")];
      if (nowMs >= pre[0] && nowMs < pre[1]) { start = pre[0]; end = pre[1]; } else { start = post[0]; end = post[1]; }
    }
    if (start && nowMs >= start && nowMs < end) out[key] = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), name: w.name };
  });
  return out;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Cache-Control", "no-store");
  if (process.env.RAPID_KEY && q.key !== process.env.RAPID_KEY) { res.status(401).json({ error: "Falta la clave" }); return; }
  const topic = process.env.NTFY_TOPIC || "";
  const host = req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  const site = host ? "https://" + host + "/#movimientos" : null;
  const ch = { topic: topic, tgToken: process.env.TELEGRAM_TOKEN || "", tgChat: process.env.TELEGRAM_CHAT_ID || "" };
  const hasChannel = !!(ch.topic || (ch.tgToken && ch.tgChat));
  const dry = q.dry === "1" || !hasChannel;
  const min = Math.max(1, Math.min(50, parseFloat(q.min || "8") || 8));
  const windowMin = Math.max(2, Math.min(60, parseInt(q.window || "4", 10) || 4));
  const w = Math.round(windowMin / CANDLE_MIN);

  if (q.test === "1") {
    if (ch.tgToken && !ch.tgChat) {
      let chats = [];
      try { chats = await telegramChats(ch.tgToken); } catch (e) { res.status(200).json({ error: "No pude leer el bot de Telegram: " + String(e && e.message || e) }); return; }
      res.status(200).json({ telegram: chats.length ? "Copiá el chatId en la variable TELEGRAM_CHAT_ID de Vercel y hacé Redeploy" : "Mandale un mensaje cualquiera a tu bot en Telegram y volvé a abrir esta dirección", chats: chats });
      return;
    }
    if (!hasChannel) { res.status(400).json({ error: "Falta NTFY_TOPIC o TELEGRAM_TOKEN y TELEGRAM_CHAT_ID en Vercel" }); return; }
    const errs = await notify(ch, "prueba", "Radar bursátil", "Los avisos están funcionando.", false, site);
    res.status(200).json({ ok: !errs.length, sent: "prueba", ntfy: !!ch.topic, telegram: !!(ch.tgToken && ch.tgChat), errors: errs });
    return;
  }

  // ?check=A,B,C: dice en qué exchange tiene perpetuo cada acción, sin revisar movimientos.
  if (q.check) {
    const syms = String(q.check).split(",").map(function (s) { return s.trim().toUpperCase(); }).filter(function (s) { return SYMBOL_OK.test(s); }).slice(0, 60);
    const [mp, rf] = await Promise.all([futures.futuresMaps(), pool(syms, 10, cachedRef)]);
    const out = {};
    syms.forEach(function (t, i) {
      const r = rf[i];
      if (!r || r.error) { out[t] = { error: "Sin precio de la acción" }; return; }
      const bx = futures.match(mp.bingx, t, r.price), bg = futures.match(mp.bitget, t, r.price);
      out[t] = { price: r.price, bingx: bx ? bx.symbol + " " + bx.price : null, bitget: bg ? bg.symbol + " " + bg.price : null };
    });
    res.status(200).json({ updated: new Date().toISOString(), bingxOk: !!mp.bingx, bitgetOk: !!mp.bitget, check: out });
    return;
  }

  const extra = String(process.env.RAPID_EXTRA || "").split(",").map(function (s) { return s.trim().toUpperCase(); }).filter(function (s) { return SYMBOL_OK.test(s); });
  const tickers = Array.from(new Set(TICKERS.concat(extra)));
  const nowMs = Date.now();
  const session = nySession(nowMs);
  const outside = session !== "rueda";
  const nCandles = outside ? STRONG_LOOKBACK : w + 3;

  const [maps, refs, wl] = await Promise.all([futures.futuresMaps(), pool(tickers, 10, cachedRef), loadWatchlist(site, nowMs).catch(function () { return null; })]);
  const earnWin = outside ? earningsWindows(wl, nowMs) : {};

  const plan = [];
  tickers.forEach(function (t, i) {
    const ref = refs[i];
    if (!ref || ref.error) { plan.push({ ticker: t, error: "Sin precio de la acción" }); return; }
    // Agus solo opera en BingX: se vigilan únicamente las acciones con perpetuo en BingX.
    const bx = futures.match(maps.bingx, t, ref.price);
    if (!bx) { plan.push({ ticker: t, error: maps.bingx ? "Sin perpetuo en BingX" : "BingX no respondió" }); return; }
    plan.push({ ticker: t, name: NAMES[t] || ref.name || t, where: "BingX", bx: bx, ref: ref.price });
  });

  const strongP = Promise.all([
    outside ? Promise.resolve([]) : regularStrong(maps, nowMs).catch(function () { return []; }),
    bitcoinStrong().catch(function () { return null; })
  ]);

  const results = await pool(plan, 10, async function (p) {
    if (p.error) return p;
    const candles = await bingxCandles(p.bx.symbol, nCandles);
    const src = "BingX " + p.bx.symbol;
    const ev = evaluate(candles, min, w, nowMs);
    const out = Object.assign({ ticker: p.ticker, name: p.name, where: p.where, source: src }, ev || { idle: true });
    if (outside && earnWin[normTicker(p.ticker)]) out.earn = evaluateStrongPerp(candles, p.ref, nowMs, EARN_THR, EARN_STEP);
    else if (outside) out.strong = evaluateStrongPerp(candles, p.ref, nowMs);
    return out;
  });

  const [regular, btc] = await strongP;
  let reminders = [];
  try { reminders = wl ? reportReminders(wl, nowMs) : [{ error: "No pude leer watchlist.json" }]; } catch (e) { reminders = [{ error: String(e && e.message || e) }]; }
  const earn = results.filter(function (r) { return r && r.earn && r.earn.alert; }).map(function (r) {
    return { ticker: r.ticker, name: r.name, pct: r.earn.pct, price: r.earn.price, ref: r.earn.ref };
  });
  const alerts = results.filter(function (r) { return r && r.alert; }).sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });
  const label = { "pre-apertura": "antes de la apertura", "después del cierre": "después del cierre", "noche": "a la noche (perpetuo 24/7)", "fin de semana": "en el fin de semana (perpetuo 24/7)" }[session] || session;
  const strong = regular.filter(function (x) { return x.alert; })
    .concat(results.filter(function (r) { return r && r.strong && r.strong.alert; }).map(function (r) {
      return { ticker: r.ticker, name: r.name, kind: "fuerte", session: label, pct: r.strong.pct, price: r.strong.price, ref: r.strong.ref, where: r.where, perp: true };
    }))
    .concat(btc && btc.alert ? [btc] : [])
    .sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });

  let sent = false, sendError = null;
  const errsAll = [];
  // Los movimientos fuertes y los rápidos van en mensajes separados, cada uno con su encabezado.
  if (strong.length && !dry) {
    const lines = strong.slice(0, 8).map(function (a) {
      let t = a.ticker + (a.name && a.name !== a.ticker ? " (" + a.name + ")" : "") + " " + fmtPct(a.pct) + " " + a.session + ", a " + fmtPx(a.price);
      if (a.perp) t += " en el perpetuo contra el cierre de " + fmtPx(a.ref);
      return t + ". Futuro en " + a.where + ".";
    });
    const f = strong[0];
    const title = strong.length === 1 ? f.ticker + " " + fmtPct(f.pct) + " " + f.session : strong.length + " acciones con movimientos fuertes";
    Array.prototype.push.apply(errsAll, await notify(ch, f.ticker === "BTC" && strong.length === 1 ? "bitcoin" : "fuerte", title, lines.join("\n"), true, site));
    sent = true;
  }
  if (alerts.length && !dry) {
    const lines = alerts.slice(0, 8).map(function (a) {
      return a.ticker + " (" + a.name + ") " + fmtPct(a.pct) + " en " + windowMin + " min: de " + fmtPx(a.from) + " a " + fmtPx(a.price) + ". Futuro en " + a.where + ".";
    });
    const f = alerts[0];
    const title = alerts.length === 1 ? f.ticker + " " + fmtPct(f.pct) + " en " + windowMin + " minutos" : alerts.length + " acciones con movimientos rápidos";
    Array.prototype.push.apply(errsAll, await notify(ch, "rapido", title, lines.join("\n"), alerts.some(function (a) { return Math.abs(a.pct) >= 2 * min; }), site));
    sent = true;
  }
  if (earn.length && !dry) {
    const lines = earn.map(function (a) {
      return a.ticker + " (" + a.name + ") " + fmtPct(a.pct) + " después de su reporte: el perpetuo de BingX está en " + fmtPx(a.price) + " contra el cierre de " + fmtPx(a.ref) + ".";
    });
    const f = earn[0];
    const title = earn.length === 1 ? f.ticker + " " + fmtPct(f.pct) + " tras el reporte" : earn.length + " acciones se mueven tras su reporte";
    Array.prototype.push.apply(errsAll, await notify(ch, "post", title, lines.join("\n"), true, site));
    sent = true;
  }
  for (const r of reminders) {
    if (!r.due || dry) continue;
    const when = (r.time ? r.time + ", " : "") + (r.exact ? "a las " : "alrededor de las ") + r.hourNY + " de Nueva York (" + fmtAR(Date.parse(r.at)) + " de Argentina)";
    let body = r.name + " presenta su balance" + (r.quarter ? " del " + r.quarter : "") + " hoy " + when + ".";
    if (r.expect) body += "\n\nQué espera el mercado: " + (r.expect.length > 600 ? r.expect.slice(0, 600) + "…" : r.expect);
    const errs = await notify(ch, "previa", r.ticker + " reporta en 1 hora", body, false, site);
    if (!errs.length) remindSent[r.key] = true;
    Array.prototype.push.apply(errsAll, errs);
    sent = true;
  }
  if (errsAll.length) sendError = errsAll.join("; ");

  res.status(200).json({
    updated: new Date(nowMs).toISOString(),
    session: session,
    min: min, windowMin: windowMin, dry: dry, topicSet: !!topic, telegramSet: !!(ch.tgToken && ch.tgChat),
    bingxOk: !!maps.bingx, bitgetOk: !!maps.bitget, bingxError: maps.bingxError, bitgetError: maps.bitgetError,
    alerts: alerts, strong: strong, sent: sent, sendError: sendError,
    regularCandidates: regular, bitcoin: btc, reminders: reminders, earningsWindows: earnWin, earnings: earn,
    items: results
  });
};

module.exports._test = { earningsWindows: earningsWindows, nyToUtc: nyToUtc, reportReminders: reportReminders, moveAt: moveAt, evaluate: evaluate, level: level, strongLevel: strongLevel, freshLevel: freshLevel, evaluateStrongPerp: evaluateStrongPerp, nySession: nySession };
