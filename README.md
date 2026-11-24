# Radar de oportunidades bursátiles

Revisión diaria del mercado argentino y de los CEDEARs, con cotizaciones en vivo.

- `index.html`: la página.
- `data.json`: la revisión del día. La actualiza Claude cada día hábil a las 8:40 (hora de Argentina) con un commit a `main`; Vercel vuelve a publicar solo.
- `api/quotes.js`: función de Vercel que trae cotizaciones en vivo de Yahoo Finance, DolarApi y ArgentinaDatos.
- `manifest.webmanifest` e íconos: permiten instalar la página como app desde Chrome.

No es asesoramiento financiero.
- `api/rapid.js`: avisos de movimientos rápidos (8% o más en 4 minutos) y de movimientos fuertes (15% en la rueda, 10% fuera de horario contra el último cierre, bitcoin 10% en 24 horas) en los futuros perpetuos de acciones de Bitget y BingX. La llama cron-job.org cada minuto y manda la notificación al celular por ntfy y/o Telegram. Necesita en Vercel `NTFY_TOPIC` o `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID` (y opcionalmente `RAPID_KEY`). `/api/rapid?dry=1` muestra el resultado sin avisar y `/api/rapid?test=1` manda un aviso de prueba.
