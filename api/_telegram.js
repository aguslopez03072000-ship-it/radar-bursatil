// Envío de mensajes al bot de Telegram de Agus. Empieza con "_" para que Vercel no lo publique como ruta.
// Cada tipo de aviso lleva un encabezado distinto para que se distingan de un vistazo.

const HEADERS = {
  rapido: "⚡ MOVIMIENTO RÁPIDO",
  fuerte: "📊 MOVIMIENTO FUERTE",
  motivo: "📰 MOVIMIENTOS DEL DÍA (con el motivo)",
  reporte: "📅 REPORTES DE TU LISTA",
  bitcoin: "₿ BITCOIN",
  radar: "🗂️ RADAR",
  error: "⚠️ RADAR: ALGO FALLÓ",
  previa: "⏰ REPORTA EN 1 HORA",
  post: "📣 MOVIMIENTO TRAS EL REPORTE",
  prueba: "✅ PRUEBA"
};

function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function send(token, chatId, kind, title, body, link) {
  const head = HEADERS[kind] || HEADERS.radar;
  const text = "<b>" + esc(head) + "</b>" + (title ? "\n<b>" + esc(title) + "</b>" : "") + (body ? "\n\n" + esc(body) : "") + (link ? "\n\n" + esc(link) : "");
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

function config() {
  return { token: process.env.TELEGRAM_TOKEN || "", chat: process.env.TELEGRAM_CHAT_ID || "" };
}

module.exports = { send: send, config: config, HEADERS: HEADERS };
