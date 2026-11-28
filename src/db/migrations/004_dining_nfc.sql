-- Dining Halls: how a card was read ('code' = barcode scanner, typing or camera; 'nfc' = NFC tag),
-- and an index to recognise records already on the server when a backup file is brought back in.
ALTER TABLE dining_scans ADD COLUMN method text NOT NULL DEFAULT 'code' CHECK (method IN ('code', 'nfc'));
CREATE INDEX dining_scans_barcode_at_idx ON dining_scans (barcode, at);
