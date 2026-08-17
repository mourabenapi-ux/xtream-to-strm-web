-- Migration: Add use_channel_numbers to live_playlists
-- Date: 2026-08-17
-- Description: Lets a playlist publish its channel orders as tvg-chno, so a
-- player shows the numbering the playlist was built with instead of its own.
-- Defaults to 0: the playlists that already exist store plain positions
-- (0, 1, 2...) in that column, and broadcasting those as channel numbers would
-- renumber a working setup for no reason. The organiser sets it on the
-- playlists it creates, where the order really is a channel number.

ALTER TABLE live_playlists
ADD COLUMN use_channel_numbers BOOLEAN NOT NULL DEFAULT 0;
