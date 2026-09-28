-- Prevent concurrent bet-resolution from writing duplicate ledger rows.
-- Each (bet_id, reason) pair must be unique: one placement debit and one
-- settlement credit per bet. Allows idempotent upsert on conflict.
ALTER TABLE points_ledger
  ADD CONSTRAINT points_ledger_bet_id_reason_unique UNIQUE (bet_id, reason);
ALTER TABLE season_betting_ledger
  ADD CONSTRAINT season_betting_ledger_bet_id_reason_unique UNIQUE (bet_id, reason);
