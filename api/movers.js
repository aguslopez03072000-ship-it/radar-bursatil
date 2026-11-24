// Movimientos fuertes del día en Wall Street para el Radar bursátil.
// GET /api/movers?min=15
// Usa las listas predefinidas de Yahoo Finance (mayores subas y mayores bajas del día)
// y devuelve las acciones que se mueven al menos `min` por ciento, en cualquier dirección.

const futures = require("./_futures");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const LISTS = ["day_gainers", "day_losers", "small_cap_gainers"];
const MIN_CAP = 300e6; // descarta empresas muy chicas, donde los saltos suelen ser ruido
const MIN_PRICE = 1;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function screener(id) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const url = host + "/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&count=100&scrIds=" + id;
      const j = await getJson(url);
      const res = j && j.finance && j.finance.result && j.finance.result[0];
      if (res && Array.isArray(res.quotes)) return res.quotes;
      lastErr = new Error("Respuesta sin datos");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function num(x) { return typeof x === "number" ? x : (x && typeof x.raw === "number" ? x.raw : null); }

module.exports = async function handler(req, res) {
  const min = Math.max(5, Math.min(100, parseFloat((req.query && req.query.min) || "15") || 15));
  const mapsP = futures.futuresMaps();
  const results = await Promise.all(LISTS.map(function (id) {
    return screener(id).then(function (q) { return { id: id, quotes: q }; }, function (e) { return { id: id, error: String(e && e.message || e) }; });
  }));

  const seen = {};
  const items = [];
  const errors = [];
  results.forEach(function (r) {
    if (r.error) { errors.push(r.id + ": " + r.error); return; }
    r.quotes.forEach(function (q) {
      const chg = num(q.regularMarketChangePercent);
      const price = num(q.regularMarketPrice);
      const cap = num(q.marketCap);
      if (chg === null || Math.abs(chg) < min) return;
      if (price !== null && price < MIN_PRICE) return;
      if (cap !== null && cap < MIN_CAP) return;
      if (seen[q.symbol]) return;
      if (!futures.isCommonStock(q.symbol)) return; // preferidas, warrants, etc.
      seen[q.symbol] = true;
      items.push({
        symbol: q.symbol,
        name: q.shortName || q.longName || q.symbol,
        price: price,
        changePct: chg,
        marketCap: cap,
        currency: q.currency || "USD",
        marketState: q.marketState || null,
        time: q.regularMarketTime ? new Date(num(q.regularMarketTime) * 1000).toISOString() : null
      });
    });
  });
  items.sort(function (a, b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  const maps = await mapsP;
  items.forEach(function (it) { it.futures = futures.futuresFor(maps, it.symbol, it.price); });

  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  res.status(200).json({
    updated: new Date().toISOString(),
    min: min,
    ok: errors.length < LISTS.length,
    errors: errors,
    futuresOk: !!(maps.bingx || maps.bitget),
    futuresErrors: [maps.bingxError && "BingX: " + maps.bingxError, maps.bitgetError && "Bitget: " + maps.bitgetError].filter(Boolean),
    items: items.slice(0, 60)
  });
};

// Para que /api/rapid use las mismas listas de Yahoo.
module.exports.screener = screener;
module.exports.num = num;
module.exports.LISTS = LISTS;
module.exports.MIN_CAP = MIN_CAP;
module.exports.MIN_PRICE = MIN_PRICE;
