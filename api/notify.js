// Reenvía a Telegram los avisos que dejan las tareas de Claude en outbox.json.
// GET /api/notify?sha=<commit>
// Lo llama la acción de GitHub .github/workflows/telegram.yml cada vez que un commit a main cambia outbox.json.
// No hace falta clave: solo reenvía los mensajes que ese commit agregó a outbox.json (comparado con el commit anterior),
// y solo si el commit es de los últimos 20 minutos, así que no se puede usar para mandar otra cosa ni repetir avisos viejos.

const tg = require("./_telegram");
const REPO = "aguslopez03072000-ship-it/radar-bursatil";
const UA = "radar-bursatil-notify";
const MAX_AGE = 20 * 60 * 1000;

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
  return r.json();
}

async function outboxAt(sha) {
  const j = await getJson("https://raw.githubusercontent.com/" + REPO + "/" + sha + "/outbox.json");
  return (j && Array.isArray(j.messages)) ? j.messages : [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const sha = String((req.query && req.query.sha) || "");
  if (!/^[0-9a-f]{40}$/.test(sha)) { res.status(400).json({ error: "Falta sha" }); return; }
  const cfg = tg.config();
  if (!cfg.token || !cfg.chat) { res.status(500).json({ error: "Falta TELEGRAM_TOKEN o TELEGRAM_CHAT_ID" }); return; }

  let commit, now, before;
  try {
    commit = await getJson("https://api.github.com/repos/" + REPO + "/commits/" + sha);
    if (!commit) { res.status(404).json({ error: "Commit inexistente" }); return; }
    const when = Date.parse(commit.commit && commit.commit.committer && commit.commit.committer.date);
    if (!when || Date.now() - when > MAX_AGE) { res.status(200).json({ ok: true, skipped: "Commit viejo" }); return; }
    const parent = commit.parents && commit.parents[0] && commit.parents[0].sha;
    [now, before] = await Promise.all([outboxAt(sha), parent ? outboxAt(parent) : Promise.resolve([])]);
  } catch (e) {
    res.status(503).json({ error: String(e && e.message || e) }); // la acción reintenta: todavía no se mandó nada
    return;
  }

  const old = {};
  before.forEach(function (m) { if (m && m.id) old[m.id] = true; });
  const fresh = now.filter(function (m) { return m && m.id && !old[m.id] && m.text; });
  const host = req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  const site = host ? "https://" + host + "/" : null;
  const sent = [], errors = [];
  for (const m of fresh) {
    try { await tg.send(cfg.token, cfg.chat, m.kind, m.title || "", m.text, m.link || site); sent.push(m.id); }
    catch (e) { errors.push(m.id + ": " + String(e && e.message || e)); }
  }
  res.status(200).json({ ok: !errors.length, sent: sent, errors: errors });
};
