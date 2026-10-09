# Piškvorky 15×15 online

Cloudflare Worker + Durable Object (WebSocket) + statický web.

## Nasazení
    npm install
    npx wrangler login      # jednou
    npx wrangler deploy

Dostaneš adresu https://piskvorky.<tvuj-ucet>.workers.dev

## Lokální vývoj
    npx wrangler dev

## Struktura
- public/index.html – celá aplikace (klient)
- src/worker.js – Worker + Durable Object "Lobby": 4 stoly, hodiny, swap, sdílená hromada uložených her
- Totožnost hráče = náhodné ID v localStorage (žádné účty)
- Uložené hry a poznámky jsou společné pro všechny, drží se v úložišti Durable Objectu

## Přenos starých her
Ve staré verzi: Uložené → Export všech. V nové: Uložené → Import souboru.
