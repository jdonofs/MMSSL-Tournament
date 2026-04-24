alter table if exists draft_picks
  add column if not exists is_captain boolean default false;

alter table if exists draft_picks
  add column if not exists captain_character_name text;

alter table if exists draft_picks
  add column if not exists team_logo_key text;

with ranked_picks as (
  select
    dp.id,
    dp.player_id,
    dp.tournament_id,
    dp.pick_number,
    c.name as character_name,
    row_number() over (
      partition by dp.tournament_id, dp.player_id
      order by dp.pick_number asc, dp.id asc
    ) as player_pick_rank
  from draft_picks dp
  left join characters c on c.id = dp.character_id
  where dp.character_id is not null
),
captain_picks as (
  select
    id,
    case
      when character_name in ('Mario','Luigi','Peach','Daisy','Wario','Waluigi','Yoshi','Birdo','Donkey Kong','Diddy Kong','Bowser','Bowser Jr','Bowser Jr.') then true
      else false
    end as is_captain,
    case
      when character_name = 'Bowser Jr' then 'Bowser Jr.'
      else character_name
    end as normalized_captain_name,
    case
      when character_name = 'Mario' then 'mario-fireballs'
      when character_name = 'Luigi' then 'luigi-knights'
      when character_name = 'Peach' then 'peach-monarchs'
      when character_name = 'Daisy' then 'daisy-flowers'
      when character_name = 'Wario' then 'wario-muscles'
      when character_name = 'Waluigi' then 'waluigi-symbiants'
      when character_name = 'Yoshi' then 'yoshi-eggs'
      when character_name = 'Birdo' then 'birdo-bows'
      when character_name = 'Donkey Kong' then 'dk-wilds'
      when character_name = 'Diddy Kong' then 'diddy-monkeys'
      when character_name = 'Bowser' then 'bowser-monsters'
      when character_name in ('Bowser Jr','Bowser Jr.') then 'bowser-rookies'
      else null
    end as team_logo_key
  from ranked_picks
  where player_pick_rank = 1
)
update draft_picks dp
set
  is_captain = captain_picks.is_captain,
  captain_character_name = captain_picks.normalized_captain_name,
  team_logo_key = captain_picks.team_logo_key
from captain_picks
where dp.id = captain_picks.id;
