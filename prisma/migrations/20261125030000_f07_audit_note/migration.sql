-- F07: the note of a stock audit.
--
-- The owner writes a note when creating the audit ("kiểm kê định kỳ hàng tháng", "kiểm kê sau khi
-- nhập hàng", ...). The column did not exist, so the note was accepted by the form and then
-- dropped: nothing was ever written and nothing could be shown.
--
-- The note belongs to the audit, not to a row, so it is one nullable TEXT column.
-- Idempotent so it can be re-run safely on a database that already has part of it.

ALTER TABLE "stock_audits"
  ADD COLUMN IF NOT EXISTS "note" TEXT;
