-- A show is a category of its own: the enum value, alone (TV show & season ranking, WS1).
--
-- Whole TV shows become rankable as an independent comparison pool, `tv_shows`, beside
-- `movies` and `tv_seasons`. Shows compare with shows, seasons with seasons, movies with
-- movies; nothing is ever derived from one level for the other.
--
-- **This file adds the value and does nothing else, deliberately.** PostgreSQL refuses to
-- *use* an enum value inside the transaction that added it ("unsafe use of new value"),
-- and a migration runner may wrap each file in one transaction. `rankable_category()` is
-- `language sql`, so its body is parsed when it is created, and parsing
-- `'tv_shows'::ranking_category` here would fail. Everything that uses the value lives in
-- the next file, 20261114000200, which starts after this one has committed.
--
-- Additive and old-client safe: no existing row, function or client call mentions the
-- value, so nothing changes until 20261114000200 maps `series` onto it.
--
-- Version 20261114000100 sorts after every in-flight migration on the QA integration
-- branch (the latest is 20261113000100, #261).

alter type ranking_category add value if not exists 'tv_shows';
