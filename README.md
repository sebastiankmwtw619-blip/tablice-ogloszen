# Tablice Ogłoszeń

PWA pokazująca wszystkie tablice ogłoszeń i słupy ogłoszeniowe (opcjonalnie też tablice informacyjne i reklamowe) w wybranym mieście lub wsi w Polsce.

- Miejscowości: Nominatim (OpenStreetMap), z granicami administracyjnymi, gdy są w OSM; inaczej promień wokół środka wsi.
- Tablice: Overpass API — `amenity=notice_board`, `advertising=column|board|poster_box`, `tourism=information` + `information=board`.
- Własne tablice (których brakuje w OSM) zapisują się w telefonie (localStorage); można je zgłosić do OSM.
- Ostatnio oglądane miejscowości są zapamiętane, więc lista działa też, gdy serwer Overpass jest przeciążony.

Uruchomienie lokalne: `python3 -m http.server 8000` i otwórz http://localhost:8000
Po każdej zmianie podbij `CACHE` w `sw.js`.
