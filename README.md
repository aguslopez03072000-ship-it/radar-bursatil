# Radar de oportunidades bursátiles

Revisión diaria del mercado argentino y de los CEDEARs, con cotizaciones en vivo.

- `index.html`: la página.
- `data.json`: la revisión del día. La actualiza Claude cada día hábil a las 8:40 (hora de Argentina) con un commit a `main`; Vercel vuelve a publicar solo.
- `api/quotes.js`: función de Vercel que trae cotizaciones en vivo de Yahoo Finance, DolarApi y ArgentinaDatos.
- `manifest.webmanifest` e íconos: permiten instalar la página como app desde Chrome.

No es asesoramiento financiero.
