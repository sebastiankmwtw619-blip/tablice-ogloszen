/*
 * Tablice Ogłoszeń — wszystkie tablice i słupy ogłoszeniowe w wybranym mieście lub wsi.
 * Mapa: OpenStreetMap. Wyszukiwanie miejscowości: Nominatim. Tablice: Overpass API (dane OSM).
 * Własne tablice użytkownika zapisują się tylko w tym urządzeniu (localStorage).
 */
'use strict';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const CATS = {
  notice: { label: 'Tablice ogłoszeń', one: 'Tablica ogłoszeń', color: 'var(--board)', on: true },
  column: { label: 'Słupy ogłoszeniowe', one: 'Słup ogłoszeniowy', color: 'var(--column)', on: true },
  info:   { label: 'Informacyjne', one: 'Tablica informacyjna', color: 'var(--info)', on: false },
  ad:     { label: 'Reklamowe / plakaty', one: 'Tablica reklamowa', color: 'var(--ad)', on: false },
  mine:   { label: 'Moje', one: 'Moja tablica', color: 'var(--mine)', on: true },
};

const KIND = {
  city: 'Miasto', town: 'Miasto', village: 'Wieś', hamlet: 'Przysiółek', isolated_dwelling: 'Osada',
  suburb: 'Dzielnica', quarter: 'Osiedle', neighbourhood: 'Osiedle', borough: 'Dzielnica',
  municipality: 'Gmina', county: 'Powiat', city_district: 'Dzielnica', locality: 'Miejscowość',
};
// promień szukania, gdy miejscowość w OSM jest tylko punktem (bez granic)
const RADIUS = { city: 6000, town: 3000, village: 1500, hamlet: 800, isolated_dwelling: 500, suburb: 1500, quarter: 1000, neighbourhood: 700 };

/* ---------------- stan ---------------- */
const state = {
  place: null,         // { key, name, kind, sub, lat, lon, bbox:[s,w,n,e], poly, radius }
  items: [],           // tablice z OSM w obszarze
  filters: Object.fromEntries(Object.entries(CATS).map(([k, c]) => [k, c.on])),
  me: null,            // [lat, lon]
  activeId: null,
  adding: false,
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* brak miejsca lub tryb prywatny */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- mapa ---------------- */
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.07, 19.48], 6);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const markersLayer = L.layerGroup().addTo(map);
let outline = null;
let meMarker = null;
const markerById = new Map();

function pinIcon(cat, active) {
  return L.divIcon({
    className: 'pin-icon' + (active ? ' active' : ''),
    html: `<div class="p" style="--c:${CATS[cat].color}"></div>`,
    iconSize: [26, 26], iconAnchor: [4, 30], popupAnchor: [9, -28],
  });
}

/* ---------------- geometria ---------------- */
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inRing(pt, ring) { // pt=[lon,lat]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPoly(lat, lon, geo) {
  const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : null;
  if (!polys) return true;
  const pt = [lon, lat];
  return polys.some((p) => inRing(pt, p[0]) && !p.slice(1).some((hole) => inRing(pt, hole)));
}
function inPlace(lat, lon, place = state.place) {
  if (!place) return false;
  if (place.poly) return inPoly(lat, lon, place.poly);
  return distM([place.lat, place.lon], [lat, lon]) <= place.radius;
}
function fmtDist(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

/* ---------------- Nominatim ---------------- */
function placeFromNominatim(r) {
  const a = r.address || {};
  const typ = r.addresstype || r.type;
  const name = r.name || a.city || a.town || a.village || a.hamlet || r.display_name.split(',')[0];
  const gmina = a.municipality ? a.municipality : '';
  const sub = [gmina, a.county, a.state].filter(Boolean).join(' · ');
  const lat = +r.lat, lon = +r.lon;
  const geo = r.geojson;
  const poly = geo && (geo.type === 'Polygon' || geo.type === 'MultiPolygon') ? geo : null;
  let bbox, radius = null;
  if (poly) {
    const [s, n, w, e] = r.boundingbox.map(Number);
    bbox = [s, w, n, e];
  } else {
    radius = RADIUS[typ] || 1500;
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  }
  return {
    key: r.osm_type[0].toUpperCase() + r.osm_id, name, kind: KIND[typ] || 'Miejscowość', sub, lat, lon, bbox, poly, radius,
  };
}

let suggestCtl = null;
async function searchPlaces(q) {
  suggestCtl?.abort();
  suggestCtl = new AbortController();
  const p = new URLSearchParams({
    q, countrycodes: 'pl', format: 'jsonv2', addressdetails: '1', limit: '8', 'accept-language': 'pl',
    polygon_geojson: '1', polygon_threshold: '0.0003', layer: 'address', featureType: 'settlement',
  });
  const r = await fetch(`${NOMINATIM}/search?${p}`, { signal: suggestCtl.signal });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  return r.json();
}
async function lookupPlace(key) {
  const p = new URLSearchParams({ osm_ids: key, format: 'jsonv2', addressdetails: '1', polygon_geojson: '1', polygon_threshold: '0.0003', 'accept-language': 'pl' });
  const r = await fetch(`${NOMINATIM}/lookup?${p}`);
  const res = await r.json();
  return res[0] ? placeFromNominatim(res[0]) : null;
}
async function reverseName(lat, lon) {
  const p = new URLSearchParams({ lat, lon, zoom: '14', format: 'jsonv2', addressdetails: '1', 'accept-language': 'pl' });
  const r = await fetch(`${NOMINATIM}/reverse?${p}`);
  const j = await r.json();
  const a = j.address || {};
  return a.village || a.town || a.city || a.hamlet || a.suburb || null;
}

/* ---------------- Overpass ---------------- */
async function overpass(q, onRetry) {
  let last, attempt = 0;
  // publiczne serwery bywają przeciążone — próbujemy po kolei, dwie rundy
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, 4000));
    for (const url of OVERPASS) {
      if (attempt++) onRetry?.();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!r.ok) throw new Error('overpass ' + r.status);
        return await r.json();
      } catch (e) { last = e; } finally { clearTimeout(timer); }
    }
  }
  throw last;
}

function categorize(t) {
  if (t.amenity === 'notice_board' || t.board_type === 'notice') return 'notice'; // w Polsce tablice ogłoszeń mają board_type=notice
  if (t.advertising === 'column') return 'column';
  if (t.tourism === 'information') return 'info';
  if (t.advertising) return 'ad';
  return null;
}

/* Gotowe kafelki z tablicami całej Polski (data/), odświeżane co tydzień przez GitHub Actions. */
let metaPromise = null;
function getMeta() {
  metaPromise ??= fetch('data/meta.json').then((r) => { if (!r.ok) throw new Error('meta ' + r.status); return r.json(); })
    .then((m) => { showDataDate(m.updated); return m; })
    .catch((e) => { metaPromise = null; throw e; });
  return metaPromise;
}
function showDataDate(iso) {
  const d = new Date(iso);
  if (!isNaN(d)) $('data-date').textContent = `, stan z ${d.toLocaleDateString('pl-PL')}`;
}
async function boardsFromTiles(place) {
  const meta = await getMeta();
  const [s, w, n, e] = place.bbox;
  const keys = [];
  for (let la = Math.floor(s); la <= Math.floor(n); la++)
    for (let lo = Math.floor(w); lo <= Math.floor(e); lo++)
      if (meta.tiles.includes(`${la}_${lo}`)) keys.push(`${la}_${lo}`);
  const tiles = await Promise.all(keys.map((k) => fetch(`data/${k}.json`).then((r) => { if (!r.ok) throw new Error('tile ' + r.status); return r.json(); })));
  return tiles.flat()
    .map(([id, lat, lon, cat, tags]) => ({ id, osm: `${{ n: 'node', w: 'way', r: 'relation' }[id[0]]}/${id.slice(1)}`, cat, lat, lon, tags }))
    .filter((b) => inPlace(b.lat, b.lon, place));
}

async function fetchBoards(place, onRetry) {
  try { return await boardsFromTiles(place); } catch { /* brak gotowych danych — pytamy Overpass na żywo */ }
  return fetchBoardsLive(place, onRetry);
}

async function fetchBoardsLive(place, onRetry) {
  const [s, w, n, e] = place.bbox.map((v) => v.toFixed(6));
  const bb = `(${s},${w},${n},${e})`;
  const q = `[out:json][timeout:25];(
    nwr["amenity"="notice_board"]${bb};
    nwr["advertising"~"^(column|board|poster_box)$"]${bb};
    nwr["tourism"="information"]["information"="board"]${bb};
  );out center tags;`;
  const data = await overpass(q, onRetry);
  return data.elements.map((el) => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const cat = categorize(el.tags || {});
    return cat && lat != null ? { id: el.type[0] + el.id, osm: `${el.type}/${el.id}`, cat, lat, lon, tags: el.tags } : null;
  }).filter((b) => b && inPlace(b.lat, b.lon, place));
}

/* ---------------- opis tablicy ---------------- */
const BOARD_TYPE = { notice: 'ogłoszenia', history: 'historia', nature: 'przyroda', wildlife: 'przyroda', public_transport: 'komunikacja', welcome: 'powitalna', plants: 'rośliny', geology: 'geologia', tourism: 'turystyka', village: 'wieś', community: 'lokalna społeczność' };
function describe(b) {
  const t = b.tags || {};
  const title = t.name || t['name:pl'] || (t.description && t.description.length < 60 ? t.description : '') || (t.operator ? `${CATS[b.cat].one} · ${t.operator}` : CATS[b.cat].one);
  const bits = [];
  if (b.cat === 'mine') { if (t.note) bits.push(t.note); }
  else {
    if (t.description && t.description !== title) bits.push(t.description);
    if (t.operator && !title.includes(t.operator)) bits.push(t.operator);
    if (t.board_type && BOARD_TYPE[t.board_type]) bits.push(BOARD_TYPE[t.board_type]);
    const addr = [t['addr:street'] || t['addr:place'], t['addr:housenumber']].filter(Boolean).join(' ');
    if (addr) bits.push(addr);
    if (t.covered === 'yes') bits.push('zadaszona');
    if (t.lit === 'yes') bits.push('oświetlona');
    if (t.access === 'private') bits.push('teren prywatny');
  }
  return { title, meta: bits.join(' · ') };
}

/* ---------------- moje tablice ---------------- */
const mine = () => store.get('tab:mine', []);
function mineItems() {
  return mine().map((m) => ({ id: m.id, cat: 'mine', lat: m.lat, lon: m.lon, tags: { name: m.name, note: m.note } }));
}

/* ---------------- render ---------------- */
function allItems() {
  const own = state.place ? mineItems().filter((m) => inPlace(m.lat, m.lon)) : mineItems();
  return [...state.items, ...own];
}
function origin() { return state.me && state.place && inPlace(state.me[0], state.me[1]) ? state.me : state.place ? [state.place.lat, state.place.lon] : null; }

function renderFilters() {
  const counts = {};
  for (const b of allItems()) counts[b.cat] = (counts[b.cat] || 0) + 1;
  $('filters').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<button type="button" class="chip" data-cat="${k}" aria-pressed="${state.filters[k]}" style="--c:${c.color}"><span class="dot"></span>${c.label}<span class="n">${counts[k] || 0}</span></button>`
  ).join('');
}

function render() {
  renderFilters();
  markersLayer.clearLayers();
  markerById.clear();
  const o = origin();
  const visible = allItems().filter((b) => state.filters[b.cat]).map((b) => ({ ...b, d: o ? distM(o, [b.lat, b.lon]) : null }));
  visible.sort((a, b) => (a.d ?? 0) - (b.d ?? 0));

  for (const b of visible) {
    const { title, meta } = describe(b);
    const m = L.marker([b.lat, b.lon], { icon: pinIcon(b.cat, b.id === state.activeId), title }).addTo(markersLayer);
    m.bindPopup(`<b>${esc(title)}</b><br><span style="color:var(--muted)">${esc(CATS[b.cat].one)}</span>${meta ? '<br>' + esc(meta) : ''}`);
    m.on('click', () => select(b.id, false));
    markerById.set(b.id, m);
  }

  $('list').innerHTML = visible.map((b) => {
    const { title, meta } = describe(b);
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}`;
    const extra = b.cat === 'mine'
      ? `<button type="button" data-del="${esc(b.id)}">Usuń</button><a href="https://www.openstreetmap.org/note/new#map=19/${b.lat}/${b.lon}" target="_blank" rel="noopener">Zgłoś do OSM</a>`
      : `<a href="https://www.openstreetmap.org/${b.osm}" target="_blank" rel="noopener">OSM</a>`;
    return `<li class="item${b.id === state.activeId ? ' active' : ''}" tabindex="0" data-id="${esc(b.id)}" style="--c:${CATS[b.cat].color}">
      <span class="dot"></span><span class="t">${esc(title)}</span><span class="d">${b.d != null ? fmtDist(b.d) : ''}</span>
      <span class="meta">${esc(CATS[b.cat].one)}${meta ? ' · ' + esc(meta) : ''}</span>
      <span class="acts"><a href="${nav}" target="_blank" rel="noopener">Prowadź</a>${extra}</span>
    </li>`;
  }).join('');

  if (state.place && !visible.length && !state.loading) {
    const total = allItems().length;
    setStatus(total
      ? 'Żadna tablica nie pasuje do wybranych rodzajów. Włącz więcej filtrów powyżej.'
      : `W mapie OpenStreetMap nie ma jeszcze tablic w miejscowości ${esc(state.place.name)}. Dodaj je ręcznie przyciskiem „Dodaj własną tablicę”.`);
  }
}

function setStatus(html, cls = '') {
  const s = $('status');
  s.hidden = !html;
  s.className = 'status ' + cls;
  s.innerHTML = html || '';
}

function select(id, fromList) {
  state.activeId = id;
  document.querySelectorAll('.item').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  markerById.forEach((m, k) => m.setIcon(pinIcon(allItems().find((b) => b.id === k)?.cat || 'notice', k === id)));
  const m = markerById.get(id);
  if (m && fromList) {
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 17), { duration: .6 });
    setTimeout(() => m.openPopup(), 650);
    if (isPhone()) setPanel('min');
  }
  if (!fromList) {
    const li = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ---------------- wybór miejscowości ---------------- */
async function openPlace(place, { fit = true } = {}) {
  state.place = place;
  state.items = [];
  state.activeId = null;
  if (!place.key.startsWith('@')) {
    store.set('tab:last', place.key);
    history.replaceState(null, '', '#' + place.key);
  }

  $('place-kind').textContent = place.kind;
  $('place-name').textContent = place.name;
  $('place-sub').textContent = place.sub || '';

  if (outline) { outline.remove(); outline = null; }
  if (place.poly) {
    outline = L.geoJSON(place.poly, { style: { color: '#1E5A44', weight: 2, fill: true, fillOpacity: .04, dashArray: '6 6' }, interactive: false }).addTo(map);
    if (fit) map.fitBounds(outline.getBounds(), { padding: [20, 20] });
  } else {
    outline = L.circle([place.lat, place.lon], { radius: place.radius, color: '#1E5A44', weight: 2, fillOpacity: .04, dashArray: '6 6', interactive: false }).addTo(map);
    if (fit) map.fitBounds(outline.getBounds(), { padding: [20, 20] });
  }

  const cacheKey = 'tab:c:' + place.key;
  const cached = store.get(cacheKey, null);
  state.loading = true;
  // od razu pokaż zapisaną listę, a świeżą dociągnij w tle
  if (cached) state.items = cached.items;
  setStatus('<span class="spinner"></span>Szukam tablic w mapie OpenStreetMap…');
  render();
  try {
    const fresh = await fetchBoards(place, () => {
      if (state.place === place) setStatus('<span class="spinner"></span>Serwer map jest przeciążony, próbuję innego… To może potrwać do minuty.');
    });
    if (state.place !== place) return; // w międzyczasie wybrano inną miejscowość
    state.items = fresh;
    state.loading = false;
    setStatus('');
    if (!place.key.startsWith('@')) saveCache(cacheKey, state.items);
  } catch (e) {
    if (state.place !== place) return;
    state.loading = false;
    if (cached) {
      state.items = cached.items;
      const ago = Math.round((Date.now() - cached.t) / 86400000);
      setStatus(`Serwer map nie odpowiada, więc pokazuję zapisaną listę${ago ? ` sprzed ${ago} dni` : ' z dzisiaj'}. <br><button type="button" class="btn btn-small" data-retry>Spróbuj ponownie</button>`, 'err');
    } else {
      setStatus('Serwery map OSM są teraz przeciążone albo nie masz internetu. Spróbuj za chwilę. <br><button type="button" class="btn btn-small" data-retry>Spróbuj ponownie</button>', 'err');
    }
  }
  render();
}

function saveCache(key, items) {
  store.set(key, { t: Date.now(), items });
  const keys = store.get('tab:ck', []).filter((k) => k !== key);
  keys.unshift(key);
  for (const old of keys.splice(15)) { try { localStorage.removeItem(old); } catch { /* ignore */ } }
  store.set('tab:ck', keys);
}

/* ---------------- podpowiedzi ---------------- */
let suggestTimer = null;
let lastResults = [];
function showSuggest(results, q) {
  lastResults = results;
  const ul = $('suggest');
  ul.hidden = false;
  if (!results.length) { ul.innerHTML = `<li class="s-empty">Nie znam miejscowości „${esc(q)}”. Sprawdź pisownię.</li>`; return; }
  ul.innerHTML = results.map((r, i) => {
    const p = placeFromNominatim(r);
    return `<li><button type="button" data-i="${i}"><span class="s-kind">${esc(p.kind)}</span><span class="s-name">${esc(p.name)}</span><span class="s-sub">${esc(p.sub)}</span></button></li>`;
  }).join('');
}
function hideSuggest() { $('suggest').hidden = true; }

$('q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (q.length < 3) { hideSuggest(); return; }
  suggestTimer = setTimeout(async () => { // Nominatim: maks. 1 zapytanie na sekundę
    try { showSuggest(await searchPlaces(q), q); } catch (e) { if (e.name !== 'AbortError') hideSuggest(); }
  }, 700);
});
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTimeout(suggestTimer);
  const q = $('q').value.trim();
  if (!q) return;
  try {
    const res = await searchPlaces(q);
    if (res.length === 1) { hideSuggest(); $('q').blur(); openPlace(placeFromNominatim(res[0])); }
    else showSuggest(res, q);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('Nie udało się wyszukać miejscowości. Sprawdź internet i spróbuj ponownie.', 'err');
  }
});
$('suggest').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  const r = lastResults[+btn.dataset.i];
  hideSuggest();
  $('q').value = '';
  $('q').blur();
  openPlace(placeFromNominatim(r));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hideSuggest(); });

/* ---------------- w pobliżu mnie ---------------- */
$('near-me').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Ta przeglądarka nie udostępnia lokalizacji.', 'err'); return; }
  setStatus('<span class="spinner"></span>Ustalam, gdzie jesteś…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    state.me = [lat, lon];
    if (meMarker) meMarker.remove();
    meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
    const radius = 2000;
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const place = { key: '@me', name: 'W pobliżu', kind: 'Twoja okolica', sub: 'Promień 2 km od Ciebie', lat, lon, radius, poly: null, bbox: [lat - dLat, lon - dLon, lat + dLat, lon + dLon] };
    history.replaceState(null, '', location.pathname);
    openPlace(place);
    try {
      const n = await reverseName(lat, lon);
      if (n && state.place === place) { place.name = `W pobliżu: ${n}`; $('place-name').textContent = place.name; }
    } catch { /* nazwa to tylko dodatek */ }
  }, () => setStatus('Nie mam dostępu do lokalizacji. Zezwól na nią w ustawieniach albo wpisz nazwę miejscowości.', 'err'),
  { enableHighAccuracy: true, timeout: 15000 });
});

/* ---------------- lista i filtry ---------------- */
$('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filters[chip.dataset.cat] = !state.filters[chip.dataset.cat];
  store.set('tab:filters', state.filters);
  if (!state.loading) setStatus('');
  render();
});
$('list').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const del = e.target.closest('[data-del]');
  if (del) {
    store.set('tab:mine', mine().filter((m) => m.id !== del.dataset.del));
    render();
    return;
  }
  const li = e.target.closest('.item');
  if (li) select(li.dataset.id, true);
});
$('list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('item')) select(e.target.dataset.id, true);
});
$('status').addEventListener('click', (e) => { if (e.target.closest('[data-retry]') && state.place) openPlace(state.place, { fit: false }); });

/* ---------------- dodawanie własnych tablic ---------------- */
let pendingLatLng = null;
function setAdding(on) {
  state.adding = on;
  $('add-hint').hidden = !on;
  document.querySelector('.map-wrap').classList.toggle('adding', on);
  if (on && isPhone()) setPanel('min');
}
$('add-mode').addEventListener('click', () => setAdding(true));
$('add-cancel').addEventListener('click', () => setAdding(false));
map.on('click', (e) => {
  if (!state.adding) return;
  pendingLatLng = e.latlng;
  setAdding(false);
  $('add-name').value = '';
  $('add-note').value = '';
  $('add-dialog').showModal();
});
$('add-dialog-cancel').addEventListener('click', () => $('add-dialog').close());
$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('add-name').value.trim();
  if (!name || !pendingLatLng) return;
  const list = mine();
  list.push({ id: 'm' + Date.now(), name, note: $('add-note').value.trim(), lat: pendingLatLng.lat, lon: pendingLatLng.lng });
  store.set('tab:mine', list);
  state.filters.mine = true;
  $('add-dialog').close();
  setStatus('');
  render();
});

/* ---------------- panel na telefonie ---------------- */
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function setPanel(size) {
  const p = $('panel');
  p.classList.toggle('min', size === 'min');
  p.classList.toggle('max', size === 'max');
}
$('panel-grip').addEventListener('click', () => {
  const p = $('panel');
  setPanel(p.classList.contains('min') ? 'mid' : p.classList.contains('max') ? 'min' : 'max');
});

/* ---------------- start ---------------- */
(async function start() {
  const savedFilters = store.get('tab:filters', null);
  if (savedFilters) Object.assign(state.filters, savedFilters);
  render();
  const key = (location.hash.slice(1) || store.get('tab:last', '') || '').trim();
  if (/^[NWR]\d+$/.test(key)) {
    try {
      const place = await lookupPlace(key);
      if (place) { openPlace(place); return; }
    } catch { /* pokaż ekran startowy */ }
  }
  const ex = ['Wadowice', 'Zakopane', 'Kazimierz Dolny'];
  $('place-sub').innerHTML = 'Wpisz nazwę miasta lub wsi albo stuknij celownik, żeby zobaczyć tablice wokół siebie. Na przykład: ' +
    ex.map((n) => `<button type="button" class="chip" data-ex="${n}">${n}</button>`).join(' ');
  $('place-sub').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex]');
    if (b) { $('q').value = b.dataset.ex; $('search-form').requestSubmit(); }
  });
})();
window.addEventListener('hashchange', async () => {
  const key = location.hash.slice(1);
  if (/^[NWR]\d+$/.test(key) && key !== state.place?.key) { const p = await lookupPlace(key).catch(() => null); if (p) openPlace(p); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
