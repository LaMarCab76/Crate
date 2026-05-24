-- Configurable embedded artwork downscale limit for portable devices.
ALTER TABLE devices ADD COLUMN artwork_max_edge INTEGER NOT NULL DEFAULT 600
  CHECK (artwork_max_edge BETWEEN 64 AND 4096);
