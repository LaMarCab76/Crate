-- Device sync ya no busca/descarga letras, y el límite de artwork ahora se aplica
-- siempre al copiar PC→MP3 (la pasada "optimizar en sync" pasó a la acción aparte
-- "Optimizar artwork"). Se dropean ambos toggles obsoletos por dispositivo.
-- Ambas columnas tienen sólo un CHECK auto-referencial y no son PK/UNIQUE/index/FK,
-- así que DROP COLUMN funciona directo (SQLite bundleado: 3.53.x).
ALTER TABLE devices DROP COLUMN fetch_lyrics;
ALTER TABLE devices DROP COLUMN optimize_artwork_on_sync;
