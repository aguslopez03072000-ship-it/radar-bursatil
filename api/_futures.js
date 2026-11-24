// Futuros perpetuos de acciones en Bitget y BingX, para el Radar bursátil.
// Agus solo quiere avisos de acciones que tengan un perpetuo en alguno de los dos exchanges.
// Los listados completos se piden una vez y se guardan 10 minutos en memoria de la función.
// El archivo empieza con "_" para que Vercel no lo publique como ruta.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TTL = 10 * 60 * 1000;
const cache = { bingx: null, bitget: null };

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function cached(key, loader) {
  const c = cache[key];
  if (c && Date.now() - c.at < TTL) return c.map;
  try {
    const map = await loader();
    cache[key] = { at: Date.now(), map: map };
    return map;
  } catch (e) {
    if (c) return c.map; // mejor un listado de hace un rato que ninguno
    throw e;
  }
}

async function loadBingx() {
  const j = await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/ticker?timestamp=" + Date.now());
  if (!j || !Array.isArray(j.data)) throw new Error((j && j.msg) || "Respuesta sin datos");
  const map = {};
  j.data.forEach(function (t) {
    if (!t || !t.symbol) return;
    const base = String(t.symbol).toUpperCase().replace(/-USDT$|-USDC$|-USD$/, "");
    const px = parseFloat(t.lastPrice);
    if (isFinite(px) && px > 0) map[base] = { symbol: t.symbol, price: px, change24h: parseFloat(t.priceChangePercent), time: t.closeTime ? new Date(Number(t.closeTime)).toISOString() : null };
  });
  return map;
}

async function loadBitget() {
  const j = await getJson("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
  if (!j || !Array.isArray(j.data)) throw new Error((j && j.msg) || "Respuesta sin datos");
  const map = {};
  j.data.forEach(function (t) {
    if (!t || !t.symbol) return;
    const base = String(t.symbol).toUpperCase().replace(/USDT$/, "");
    const px = parseFloat(t.lastPr != null ? t.lastPr : t.last);
    if (isFinite(px) && px > 0) map[base] = { symbol: t.symbol, price: px };
  });
  return map;
}

// Devuelve los dos listados; si un exchange no responde, su mapa queda en null.
async function futuresMaps() {
  const [bx, bg] = await Promise.all([
    cached("bingx", loadBingx).then(function (m) { return { map: m }; }, function (e) { return { error: String(e && e.message || e) }; }),
    cached("bitget", loadBitget).then(function (m) { return { map: m }; }, function (e) { return { error: String(e && e.message || e) }; })
  ]);
  return { bingx: bx.map || null, bitget: bg.map || null, bingxError: bx.error || null, bitgetError: bg.error || null };
}

// Los nombres de los contratos varían (NVDA, NVDAX, NVDAUS, NVDAON...), así que se acepta
// un contrato solo si su precio es coherente con el de la acción, para no confundirlo con una cripto de igual sigla.
function match(map, symbol, refPrice) {
  if (!map || !refPrice) return null;
  const t = String(symbol).toUpperCase().replace(/[.\-]/g, "");
  const cands = [t, t + "X", t + "US", t + "ON", "NCSK" + t];
  for (const c of cands) {
    const hit = map[c];
    if (!hit) continue;
    const ratio = hit.price / refPrice;
    if (ratio > 0.5 && ratio < 2) return hit;
  }
  return null;
}

// Acciones preferidas, warrants, units y derechos: no son la acción común y no tienen perpetuo.
function isCommonStock(symbol) {
  return !/-P[A-Z]?$|-P$|\.PR|-WT$|-WS$|-U$|-R$|\^/.test(String(symbol).toUpperCase());
}

// Texto para mostrar ("Bitget y BingX", "BingX"...) o null si no tiene perpetuo en ninguno.
function futuresFor(maps, symbol, refPrice) {
  if (!isCommonStock(symbol)) return null;
  const bg = match(maps.bitget, symbol, refPrice);
  const bx = match(maps.bingx, symbol, refPrice);
  const where = [];
  if (bg) where.push("Bitget");
  if (bx) where.push("BingX");
  return where.length ? where.join(" y ") : null;
}

module.exports = { futuresMaps: futuresMaps, match: match, futuresFor: futuresFor, isCommonStock: isCommonStock };
