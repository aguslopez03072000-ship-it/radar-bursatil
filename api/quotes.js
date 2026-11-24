// Cotizaciones en vivo para el Radar bursátil.
// GET /api/quotes?symbols=YPF,GOOGL,BRK-B
// Devuelve índices fijos (S&P 500, Nasdaq, VIX, WTI, Bitcoin), dólares, riesgo país
// y los símbolos pedidos, con precio, variación de la última rueda, distancia al máximo de 52 semanas,
// variación del último mes, del año y posición frente a su promedio de 50 ruedas (para ver cómo llega a su reporte).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const INDICES = ["^GSPC", "^IXIC", "^VIX", "CL=F", "BTC-USD"];
const SYMBOL_OK = /^[A-Z0-9.\-^=]{1,15}$/i;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
  return r.json();
}

async function yahoo(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1y&interval=1d";
  const j = await getJson(url);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error("Sin datos para " + symbol);
  const m = res.meta || {};
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const ts = res.timestamp || [];
  const pairs = [];
  (q.close || []).forEach(function (c, i) { if (typeof c === "number") pairs.push([ts[i], c]); });
  const closes = pairs.map(function (p) { return p[1]; });
  const highs = (q.high || []).filter(function (x) { return typeof x === "number"; });
  const lows = (q.low || []).filter(function (x) { return typeof x === "number"; });
  const price = typeof m.regularMarketPrice === "number" ? m.regularMarketPrice : closes[closes.length - 1];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : m.chartPreviousClose;
  const high52 = Math.max(m.fiftyTwoWeekHigh || 0, highs.length ? Math.max.apply(null, highs) : 0, price || 0);
  const lowCandidates = [m.fiftyTwoWeekLow, lows.length ? Math.min.apply(null, lows) : undefined].filter(function (x) { return typeof x === "number" && x > 0; });
  const low52 = lowCandidates.length ? Math.min.apply(null, lowCandidates) : null;
  const n = closes.length;
  const monthAgo = n > 22 ? closes[n - 22] : null;
  const last50 = closes.slice(-50);
  const sma50 = last50.length >= 20 ? last50.reduce(function (a, b) { return a + b; }, 0) / last50.length : null;
  const year = new Date().getUTCFullYear();
  let yearStart = null;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] && new Date(pairs[i][0] * 1000).getUTCFullYear() === year) { yearStart = i > 0 ? pairs[i - 1][1] : pairs[i][1]; break; }
  }
  return {
    symbol: symbol,
    currency: m.currency || null,
    price: price,
    prevClose: prevClose,
    changePct: price && prevClose ? (price / prevClose - 1) * 100 : null,
    high52: high52 || null,
    low52: low52,
    fromHighPct: price && high52 ? (price / high52 - 1) * 100 : null,
    change1mPct: price && monthAgo ? (price / monthAgo - 1) * 100 : null,
    ytdPct: price && yearStart ? (price / yearStart - 1) * 100 : null,
    vsSma50Pct: price && sma50 ? (price / sma50 - 1) * 100 : null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null
  };
}

async function dolares() {
  const arr = await getJson("https://dolarapi.com/v1/dolares");
  const out = {};
  (arr || []).forEach(function (d) { out[d.casa] = { compra: d.compra, venta: d.venta, fecha: d.fechaActualizacion }; });
  return {
    ccl: out.contadoconliqui || null,
    mep: out.bolsa || null,
    oficial: out.oficial || null,
    blue: out.blue || null,
    mayorista: out.mayorista || null
  };
}

async function riesgoPais() {
  const j = await getJson("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo");
  return { valor: j.valor, fecha: j.fecha };
}

function settle(p) {
  return p.then(function (v) { return v; }, function (e) { return { error: String(e && e.message || e) }; });
}

module.exports = async function handler(req, res) {
  const raw = String((req.query && req.query.symbols) || "");
  const asked = raw.split(",").map(function (s) { return s.trim().toUpperCase(); }).filter(function (s) { return SYMBOL_OK.test(s); }).slice(0, 45);
  const all = Array.from(new Set(INDICES.concat(asked)));

  const results = await Promise.all(all.map(function (s) { return settle(yahoo(s)); }));
  const quotes = {};
  all.forEach(function (s, i) { quotes[s] = results[i]; });

  const extra = await Promise.all([settle(dolares()), settle(riesgoPais())]);

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({ updated: new Date().toISOString(), quotes: quotes, dolar: extra[0], riesgo: extra[1] });
};
