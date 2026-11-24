// Movimientos fuera del horario normal para el Radar bursátil.
// GET /api/extended?symbols=NVDA,DELL&min=15
// Para cada acción compara contra su último cierre normal:
//   - el precio de pre-apertura o de después del cierre (Yahoo Finance, horario extendido);
//   - el precio del contrato perpetuo de BingX que sigue a esa acción y opera 24/7.
// Además de los símbolos pedidos revisa una lista fija de acciones grandes y muy operadas.

const futures = require("./_futures");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SYMBOL_OK = /^[A-Z0-9.\-]{1,12}$/;
const POPULAR = ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA", "AVGO", "AMD", "NFLX", "ORCL", "INTC", "QCOM", "MU", "ARM", "TSM", "ASML", "PLTR", "COIN", "MSTR", "HOOD", "SMCI", "DELL", "CRWD", "PANW", "SHOP", "UBER", "BABA", "PDD", "MRNA", "LLY", "NVO", "UNH", "JPM", "XOM", "MELI", "NU", "GGAL", "YPF", "VIST", "BMA", "PAM", "CRWV", "NBIS", "IREN", "RIOT", "HUT", "MARA"];
const MAX_SYMBOLS = 70;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function sessionAt(tp, now) {
  if (!tp) return null;
  const inside = function (p) { return p && now >= p.start && now < p.end; };
  if (inside(tp.pre)) return "pre";
  if (inside(tp.regular)) return "regular";
  if (inside(tp.post)) return "post";
  return "closed";
}

async function yahooExt(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1d&interval=5m&includePrePost=true";
  const j = await getJson(url);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error("Sin datos");
  const m = res.meta || {};
  const ts = res.timestamp || [];
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  let lastPx = null, lastT = null;
  for (let i = closes.length - 1; i >= 0; i--) { if (typeof closes[i] === "number") { lastPx = closes[i]; lastT = ts[i]; break; } }
  const now = Math.floor(Date.now() / 1000);
  const session = sessionAt(m.currentTradingPeriod, now);
  const regular = typeof m.regularMarketPrice === "number" ? m.regularMarketPrice : null;
  const prevClose = typeof m.chartPreviousClose === "number" ? m.chartPreviousClose : null;
  // Fuera de la rueda normal, la referencia es el último cierre normal (regularMarketPrice).
  const ref = session === "regular" ? prevClose : regular;
  let ext = null;
  const tp = m.currentTradingPeriod || {};
  const inExtended = lastT && ((tp.pre && lastT >= tp.pre.start && lastT < tp.pre.end) || (tp.post && lastT >= tp.post.start && lastT < tp.post.end));
  if (session !== "regular" && inExtended && lastPx && ref) {
    ext = {
      price: lastPx,
      pct: (lastPx / ref - 1) * 100,
      session: tp.pre && lastT >= tp.pre.start && lastT < tp.pre.end ? "pre" : "post",
      time: new Date(lastT * 1000).toISOString()
    };
  }
  return { symbol: symbol, name: m.shortName || m.longName || null, currency: m.currency || "USD", session: session, regular: regular, prevClose: prevClose, ref: ref, ext: ext };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { symbol: items[k], error: String(e && e.message || e) }; } } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

module.exports = async function handler(req, res) {
  const min = Math.max(5, Math.min(100, parseFloat((req.query && req.query.min) || "15") || 15));
  const asked = String((req.query && req.query.symbols) || "").split(",").map(function (s) { return s.trim().toUpperCase(); })
    .filter(function (s) { return SYMBOL_OK.test(s) && !/-USD$/.test(s); });
  const symbols = Array.from(new Set(asked.concat(POPULAR))).slice(0, MAX_SYMBOLS);

  const [quotes, bx] = await Promise.all([
    pool(symbols, 12, yahooExt),
    futures.futuresMaps()
  ]);

  let marketSession = null;
  const items = [];
  quotes.forEach(function (q) {
    if (!q || q.error) return;
    if (!marketSession && q.session) marketSession = q.session;
    const b = futures.match(bx.bingx, q.symbol, q.regular || q.prevClose);
    let bingx = null;
    if (b && q.ref) bingx = { symbol: b.symbol, price: b.price, pct: (b.price / q.ref - 1) * 100, time: b.time };
    const moves = [q.ext ? Math.abs(q.ext.pct) : 0, bingx ? Math.abs(bingx.pct) : 0];
    items.push({ symbol: q.symbol, name: q.name, currency: q.currency, session: q.session, ref: q.ref, ext: q.ext, bingx: bingx, futures: futures.futuresFor(bx, q.symbol, q.regular || q.prevClose), maxAbs: Math.max.apply(null, moves) });
  });
  items.sort(function (a, b) { return b.maxAbs - a.maxAbs; });

  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  res.status(200).json({
    updated: new Date().toISOString(),
    min: min,
    marketSession: marketSession,
    bingxOk: !!bx.bingx,
    bingxError: bx.bingxError || null,
    bitgetOk: !!bx.bitget,
    bitgetError: bx.bitgetError || null,
    checked: items.length,
    alerts: items.filter(function (x) { return x.maxAbs >= min; }),
    items: items
  });
};
