-- The batter-runner is a baserunner.
--
-- `runner_opportunities` was built for runners already standing on a base, so
-- its check constraints only ever allowed first/second/third. That left the
-- most common extra-base decision in the game -- the hitter deciding whether
-- to stretch a single into a double -- with nowhere to be recorded, and so
-- the defensive play that settled it had nowhere either. A fielder who cuts a
-- ball off in the gap and holds the batter to a single produced no opportunity
-- row, no runner value and no arm value; across the local archive the batter
-- took two or more bases 305 times and stopped at the base his hit guaranteed
-- him 1,234 times, against 18 rows in this table.
--
-- `origin_base = 'plate'` is load-bearing, not cosmetic. On a single with a
-- runner already on first the batter's origin is NOT first: pricing his
-- decision from that base would clear a bit belonging to the runner ahead of
-- him and value the hit itself as part of his baserunning. The plate is the
-- only honest origin, and src/utils/advancedDefense.js keys the batter's
-- run-expectancy baseline off it -- his hold state is the state WITH him
-- standing on the base the hit gave him.
--
-- ONE CONSTRAINT, BECAUSE ONLY ONE IS IN THE WAY. The live catalog carries
-- checks on competition_type, origin_base, outcome and target_base, and
-- nothing on runner_id or opportunity_type. The batter's row is 'hold' /
-- 'advance_safe' / 'advance_out' to a target of 'second' or 'third', all of
-- which the existing checks already allow, so widening origin_base is the
-- whole change. Adding checks this deployment has never had would be a
-- different decision from unblocking this one.
--
-- Dropped by name and rebuilt so this is safe to re-run and does not depend on
-- the current definition's exact spelling. The new set is a superset of the
-- old one, so no existing row can fail it.

alter table runner_opportunities
  drop constraint if exists runner_opportunities_origin_base_check;
alter table runner_opportunities
  add constraint runner_opportunities_origin_base_check
  check (origin_base in ('plate', 'first', 'second', 'third'));
