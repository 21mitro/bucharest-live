# București Live – versiunea 1

Hartă live cu tramvaie, troleibuze, autobuze și linii de noapte din București.

## Pornire
Ai nevoie de Node.js 18 sau mai nou (https://nodejs.org).

```
cd bucharest-live
npm install
npm start
```

Deschide http://localhost:3000. Pe telefon (aceeași rețea Wi-Fi): http://IP-UL-CALCULATORULUI:3000

## Structură
- `server.js` – ia datele oficiale TPBI, separă liniile pe tipuri, servește API-ul
- `public/index.html` – aplicația (hartă, meniu, filtre)
- `data/lines.json` – lista liniilor pe tipuri, creată automat la pornire

## Date și termeni
Datele vin de la TPBI (gtfs.tpbi.ro). Citește termenii de utilizare de pe mo-bi.ro
(meniu → Source Code and Open Data) înainte de a publica aplicația.
Harta: © OpenStreetMap, OpenFreeMap, OpenMapTiles (se afișează automat pe hartă).

## Setări rapide
În `public/index.html`: `STYLE_URL` (hartă întunecată OpenFreeMap), `HEX_R` (mărimea hexagoanelor), `TYPES` (culori pe tip de vehicul).

Căutarea, lista de linii și click pe un număr deschid traseul. Un vehicul selectat arată numărul de parc, destinația și stația, dacă feed-ul le trimite.
