create table if not exists stadiums (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lf_distance integer,
  cf_distance integer,
  rf_distance integer,
  chaos_level integer default 0,
  fielding_disruption_level integer default 0,
  description text,
  night_only boolean default false,
  day_only boolean default false
);

insert into stadiums (name, lf_distance, cf_distance, rf_distance, chaos_level, fielding_disruption_level, description, night_only, day_only) values
  ('Mario Stadium', 259, 317, 259, 0, 0, 'No gimmicks. Pure baseball. True neutral park.', false, false),
  ('Peach Ice Garden', 314, 402, 313, 1, 2, 'Massive walls suppress HRs. Freezies stun fielders. Night: stadium blackout event.', false, false),
  ('DK Jungle', 274, 323, 275, 2, 2, 'Barrels crush fielders. Poison flowers slow them. Tree roots suppress center field hits.', false, false),
  ('Wario City', 292, 297, 289, 2, 2, 'Short fence everywhere, especially shallow center. Manholes and directional arrows disrupt plays.', false, false),
  ('Yoshi Park', 253, 324, 254, 3, 3, 'Short lines. Day: warp pipes teleport the ball randomly. Night: Piranha Plants eat and spit ball.', false, false),
  ('Bowser Jr. Playroom', 262, 328, 264, 2, 2, 'High walls suppress HRs hard. Chain Chomps and Bullet Bills chase fielders.', false, true),
  ('Daisy Cruiser', 232, 328, 231, 3, 3, 'Shortest lines in the game. Day: tables stun fielders. Night: Cheep Cheeps + Gooper Blooper tilts entire field.', false, false),
  ('Luigi''s Mansion', 282, 351, 287, 3, 3, 'Ghosts attack fielders. Tall grass hides the ball. Night only.', true, false),
  ('Bowser Castle', 278, 334, 277, 4, 4, 'Tall walls + Thwomps suppress HRs. Lava Bubbles, fireballs, and Bob-ombs create constant chaos.', true, false)
on conflict (name) do update set
  lf_distance = excluded.lf_distance,
  cf_distance = excluded.cf_distance,
  rf_distance = excluded.rf_distance,
  chaos_level = excluded.chaos_level,
  fielding_disruption_level = excluded.fielding_disruption_level,
  description = excluded.description,
  night_only = excluded.night_only,
  day_only = excluded.day_only;

alter table games
  add column if not exists stadium_id uuid references stadiums(id),
  add column if not exists is_night boolean default false;

create table if not exists stadium_game_log (
  id uuid primary key default gen_random_uuid(),
  game_id integer unique references games(id) on delete cascade,
  stadium_id uuid references stadiums(id),
  is_night boolean default false,
  total_runs integer,
  confidence numeric default 1.0,
  created_at timestamptz default now()
);

alter table stadiums disable row level security;
alter table stadium_game_log disable row level security;

insert into stadium_game_log (game_id, stadium_id, is_night, total_runs, confidence)
select
  seed.game_id,
  stadiums.id,
  seed.is_night,
  seed.total_runs,
  0.6
from (
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%nick%' and pb.name ilike '%donovan%'
      limit 1
    ) as game_id,
    'DK Jungle'::text as stadium_name,
    false as is_night,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%nick%' and pb.name ilike '%donovan%'
      limit 1
    ) as total_runs
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%aidan%' and pb.name ilike '%justin%'
      limit 1
    ),
    'Luigi''s Mansion',
    true,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%aidan%' and pb.name ilike '%justin%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%nick%'
      limit 1
    ),
    'Wario City',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%nick%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%aidan%'
      limit 1
    ),
    'Daisy Cruiser',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%aidan%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%justin%'
      limit 1
    ),
    'Peach Ice Garden',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%justin%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%aidan%' and pb.name ilike '%donovan%'
      limit 1
    ),
    'DK Jungle',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%aidan%' and pb.name ilike '%donovan%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%donovan%'
      limit 1
    ),
    'DK Jungle',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%may%' and pb.name ilike '%donovan%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%nick%' and pb.name ilike '%jason%'
        and (coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)) > 10
      limit 1
    ),
    'Daisy Cruiser',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%nick%' and pb.name ilike '%jason%'
        and (coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)) > 10
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%may%'
      limit 1
    ),
    'DK Jungle',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%may%'
      limit 1
    )
  union all
  select
    (
      select g.id
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%nick%'
      limit 1
    ),
    'DK Jungle',
    false,
    (
      select coalesce(g.team_a_runs, 0) + coalesce(g.team_b_runs, 0)
      from games g
      join players pa on pa.id = g.team_a_player_id
      join players pb on pb.id = g.team_b_player_id
      where pa.name ilike '%jason%' and pb.name ilike '%nick%'
      limit 1
    )
) seed
join stadiums on stadiums.name = seed.stadium_name
where seed.game_id is not null
on conflict (game_id) do nothing;
