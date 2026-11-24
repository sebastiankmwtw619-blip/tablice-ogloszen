// Pobiera wszystkie tablice w Polsce z OpenStreetMap (Overpass) i dzieli je na kafelki 1°×1°
// w katalogu data/. Aplikacja czyta potem tylko kafelki swojej miejscowości, bez czekania na Overpass.
// Użycie: node scripts/build-data.mjs [plik.json]  — z plikiem: zamiast pobierać, użyj gotowej odpowiedzi Overpass.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const QUERY = `[out:json][timeout:900];area(id:3600049715)->.pl;(
  nwr["amenity"="notice_board"](area.pl);
  nwr["advertising"~"^(column|board|poster_box)$"](area.pl);
  nwr["tourism"="information"]["information"="board"](area.pl);
);out center tags qt;`;
// tylko tagi, które aplikacja pokazuje
const KEEP = ['name', 'name:pl', 'description', 'operator', 'board_type', 'addr:street', 'addr:place', 'addr:housenumber', 'covered', 'lit', 'access'];

async function download() {
  for (let round = 0; round < 3; round++) {
    for (const url of SERVERS) {
      try {
        console.log('Pobieram z', url);
        const r = await fetch(url, {
          method: 'POST', body: 'data=' + encodeURIComponent(QUERY),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'tablice-ogloszen-data/1.0 (github.com/sebastiankmwtw619-blip/tablice-ogloszen)' },
          signal: AbortSignal.timeout(1000 * 1000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark);
        return j;
      } catch (e) { console.log('  nie wyszło:', e.message); }
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  throw new Error('Żaden serwer Overpass nie odpowiedział');
}

function category(t) {
  if (t.amenity === 'notice_board' || t.board_type === 'notice') return 'notice'; // w Polsce tablice ogłoszeń mają board_type=notice
  if (t.advertising === 'column') return 'column';
  if (t.tourism === 'information') return 'info';
  if (t.advertising) return 'ad';
  return null;
}

// Wynik `osmium export -f geojsonseq --add-unique-id=type_id` (z wyciągu Geofabrik) → kształt jak z Overpass.
function fromGeojsonSeq(file) {
  const elements = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.replace(/^\x1e/, '').trim();
    if (!s) continue;
    const f = JSON.parse(s);
    const id = String(f.id ?? ''); // np. "n123", "w456"
    const type = { n: 'node', w: 'way', r: 'relation', a: 'way' }[id[0]];
    if (!type) continue;
    const pts = [];
    (function walk(c) { if (typeof c[0] === 'number') pts.push(c); else c.forEach(walk); })(f.geometry.coordinates);
    const lon = pts.reduce((a, p) => a + p[0], 0) / pts.length, lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    elements.push({ type, id: id.slice(1), lat, lon, tags: f.properties || {} });
  }
  // osmium tags-filter nie umie warunku „tourism=information ORAZ information=board”, więc odsiewamy tutaj
  return { elements: elements.filter((e) => e.tags.tourism !== 'information' || e.tags.information === 'board' || e.tags.amenity || e.tags.advertising) };
}

const input = process.argv[2];
const data = !input ? await download() : input.endsWith('.geojsonseq') ? fromGeojsonSeq(input) : JSON.parse(fs.readFileSync(input, 'utf8'));
if (process.argv[3]) data.osm3s = { timestamp_osm_base: process.argv[3] }; // data stanu OSM podana z zewnątrz
const tiles = new Map();
const counts = {};
for (const el of data.elements) {
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  const cat = category(el.tags || {});
  if (lat == null || !cat) continue;
  const tags = {};
  for (const k of KEEP) if (el.tags[k]) tags[k] = el.tags[k];
  const key = `${Math.floor(lat)}_${Math.floor(lon)}`;
  if (!tiles.has(key)) tiles.set(key, []);
  // [id, lat, lon, kategoria, tagi]
  tiles.get(key).push([el.type[0] + el.id, +lat.toFixed(6), +lon.toFixed(6), cat, tags]);
  counts[cat] = (counts[cat] || 0) + 1;
}
if (tiles.size < +(process.env.MIN_TILES ?? 20)) throw new Error(`Podejrzanie mało danych (${tiles.size} kafelków) — nie nadpisuję`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [key, rows] of tiles) {
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1)); // stała kolejność = brak zbędnych zmian w git
  fs.writeFileSync(path.join(OUT, key + '.json'), '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
}
const osmDate = data.osm3s?.timestamp_osm_base || new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ updated: osmDate, tiles: [...tiles.keys()].sort(), counts }, null, 1) + '\n');
console.log('Gotowe:', tiles.size, 'kafelków', counts, 'stan OSM', osmDate);
