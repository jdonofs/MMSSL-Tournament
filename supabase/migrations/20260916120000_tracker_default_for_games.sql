
-- Automated scoring is the normal path for new games. Existing unplayed games
-- move to it as well; active and completed games keep their current source.
alter table public.games alter column stats_source set default 'tracker';
alter table public.season_schedule alter column stats_source set default 'tracker';

update public.games
set stats_source = 'tracker'
where status = 'pending' and stats_source is distinct from 'tracker';

update public.season_schedule
set stats_source = 'tracker'
where status = 'scheduled' and stats_source is distinct from 'tracker';
;
