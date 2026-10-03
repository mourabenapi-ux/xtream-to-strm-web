-- Migration: dashboard conditions, what was really sent
-- Date: 2026-10-03
-- Description: app_conditions.notified means "no push is due for this problem",
-- which is also set when notifications are switched on so that the problems
-- already open are not replayed. pushed says a notification really went out.
-- The screen shows "sent to your phone" from pushed only.
--
-- This runner re-applies every file at boot and splits on the statement
-- terminator, so this comment block must never contain one.

ALTER TABLE app_conditions ADD COLUMN pushed BOOLEAN NOT NULL DEFAULT 0
