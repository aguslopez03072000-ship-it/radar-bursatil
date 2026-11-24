// Avisos de movimientos rápidos en los futuros perpetuos de acciones (Bitget y BingX), para el Radar bursátil.
// GET /api/rapid            revisa y, si hay algo nuevo, manda la notificación por ntfy
// GET /api/rapid?dry=1      revisa y devuelve el resultado sin mandar nada (para probar desde el navegador)
// GET /api/rapid?test=1     manda una notificación de prueba
// La llama cron-job.org cada minuto. Un movimiento rápido es una variación de 8% o más en los últimos
// 4 minutos (velas de 1 minuto del perpetuo). Para no repetir el aviso, solo avisa cuando la variación
// pasa a un escalón nuevo (8%, 16%, 24%...) respecto de lo que se veía en la revisión anterior.
//
// Variables de entorno en Vercel:
//   NTFY_TOPIC   nombre secreto del canal de ntfy al que está suscripto el celular (obligatoria)
//   RAPID_KEY    si se define, la ruta exige ?key=<RAPID_KEY>
//   RAPID_EXTRA  tickers extra separados por coma (opcional)

const futures = require("./_futures");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// Acciones con perpetuo confirmado en Bitget o BingX (noviembre de 2026).
const TICKERS = [
  "TSLA", "AAPL", "GOOGL", "AMZN", "META", "MSTR", "COIN", "HOOD", "IBM", "INTC", "APP", "ORCL", "PLTR", "RIOT", "GME",
  "NVDA", "MRVL", "ARM", "BABA", "ASML", "CRCL", "DFDV", "GE", "MCD",
  "MSFT", "AVGO", "MU", "SNDK", "COST", "MDLZ", "CTAS", "GH", "COF", "KMB", "FISV", "ENPH", "ALNY", "ULTA", "GM", "MSCI",
  "PLD", "FRHC", "CCJ", "GLXY", "ONON", "ANT", "ADI"
];
const NAMES = { ANT: "Anthropic" };
const CANDLE_MIN = 1;
const REF_TTL = 30 * 60 * 1000;
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

// Los precios de referencia cambian poco: se guardan 30 minutos mientras la función siga activa.
async function cachedRef(symbol) {
  const c = refCache[symbol];
  if (c && Date.now() - c.at < REF_TTL) return c.v;
  const v = await refPrice(symbol);
  refCache[symbol] = { at: Date.now(), v: v };
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

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Cache-Control", "no-store");
  if (process.env.RAPID_KEY && q.key !== process.env.RAPID_KEY) { res.status(401).json({ error: "Falta la clave" }); return; }
  const topic = process.env.NTFY_TOPIC || "";
  const host = req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  const site = host ? "https://" + host + "/#movimientos" : null;
  const dry = q.dry === "1" || !topic;
  const min = Math.max(1, Math.min(50, parseFloat(q.min || "8") || 8));
  const windowMin = Math.max(2, Math.min(60, parseInt(q.window || "4", 10) || 4));
  const w = Math.round(windowMin / CANDLE_MIN);

  if (q.test === "1") {
    if (!topic) { res.status(400).json({ error: "Falta NTFY_TOPIC en Vercel" }); return; }
    await ntfy(topic, "Radar bursátil: prueba", "Los avisos de movimientos rápidos están funcionando.", false, site);
    res.status(200).json({ ok: true, sent: "prueba" });
    return;
  }

  const extra = String(process.env.RAPID_EXTRA || "").split(",").map(function (s) { return s.trim().toUpperCase(); }).filter(function (s) { return SYMBOL_OK.test(s); });
  const tickers = Array.from(new Set(TICKERS.concat(extra)));
  const nowMs = Date.now();

  const [maps, refs] = await Promise.all([futures.futuresMaps(), pool(tickers, 10, cachedRef)]);

  const plan = [];
  tickers.forEach(function (t, i) {
    const ref = refs[i];
    if (!ref || ref.error) { plan.push({ ticker: t, error: "Sin precio de la acción" }); return; }
    const bg = futures.match(maps.bitget, t, ref.price);
    const bx = futures.match(maps.bingx, t, ref.price);
    const where = [bg ? "Bitget" : null, bx ? "BingX" : null].filter(Boolean).join(" y ");
    if (!where) { plan.push({ ticker: t, error: "Sin contrato encontrado" }); return; }
    plan.push({ ticker: t, name: NAMES[t] || ref.name || t, where: where, bg: bg, bx: bx });
  });

  const results = await pool(plan, 10, async function (p) {
    if (p.error) return p;
    let candles = null, src = null;
    try { if (p.bx) { candles = await bingxCandles(p.bx.symbol, w + 3); src = "BingX " + p.bx.symbol; } } catch (e) { candles = null; }
    if (!candles && p.bg) { candles = await bitgetCandles(p.bg.symbol, w + 3); src = "Bitget " + p.bg.symbol; }
    const ev = evaluate(candles, min, w, nowMs);
    return Object.assign({ ticker: p.ticker, name: p.name, where: p.where, source: src }, ev || { idle: true });
  });

  const alerts = results.filter(function (r) { return r && r.alert; }).sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });
  let sent = false, sendError = null;
  if (alerts.length && !dry) {
    const title = alerts.length === 1
      ? "Movimiento rápido: " + alerts[0].ticker + " " + fmtPct(alerts[0].pct) + " en " + windowMin + " min"
      : alerts.length + " movimientos rápidos en " + windowMin + " min";
    const body = alerts.slice(0, 8).map(function (a) {
      return a.ticker + " (" + a.name + ") " + fmtPct(a.pct) + ": de " + fmtPx(a.from) + " a " + fmtPx(a.price) + ". Futuro en " + a.where + ".";
    }).join("\n");
    try { await ntfy(topic, title, body, alerts.some(function (a) { return Math.abs(a.pct) >= 2 * min; }), site); sent = true; }
    catch (e) { sendError = String(e && e.message || e); }
  }

  res.status(200).json({
    updated: new Date(nowMs).toISOString(),
    min: min, windowMin: windowMin, dry: dry, topicSet: !!topic,
    bingxOk: !!maps.bingx, bitgetOk: !!maps.bitget, bingxError: maps.bingxError, bitgetError: maps.bitgetError,
    alerts: alerts, sent: sent, sendError: sendError,
    items: results
  });
};

module.exports._test = { moveAt: moveAt, evaluate: evaluate, level: level };
