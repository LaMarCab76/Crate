-- User-facing identity for a registered library location. The icon is a
-- renderer-owned monochrome glyph name; NULL falls back to the provider icon.

ALTER TABLE folders ADD COLUMN display_icon TEXT;
