-- Migration: split series refresh counter out of items_added
-- Date: 2026-09-24
-- Description: series get rewritten periodically even when nothing changed,
-- because a new episode on an existing series is only ever discovered by
-- asking the provider again. That rewrite used to be counted the same as a
-- genuinely new series in items_added, so a routine recheck of an unchanged
-- library looked identical to a fresh import in the UI.
--
-- items_refreshed holds that periodic-recheck count separately. Movies never
-- populate it and it defaults to 0 there. Existing rows get 0 too, which is
-- correct: no run before this migration ever split the two.
--
-- This runner re-applies every migration at each boot, and skips the ADD
-- COLUMN once the column is there.

ALTER TABLE sync_state ADD COLUMN items_refreshed INTEGER DEFAULT 0;
