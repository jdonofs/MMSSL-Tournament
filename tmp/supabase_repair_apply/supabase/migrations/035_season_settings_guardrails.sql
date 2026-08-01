do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'seasons'
      and column_name = 'mercy_rule'
  ) then
    execute 'update public.seasons set mercy_rule = false where mercy_rule is null';
  else
    execute 'alter table public.seasons add column mercy_rule boolean default false';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'seasons'
      and column_name = 'mercy_rule_differential'
  ) then
    execute 'update public.seasons set mercy_rule_differential = 10 where mercy_rule_differential is null or mercy_rule_differential < 1';
  else
    execute 'alter table public.seasons add column mercy_rule_differential integer default 10';
  end if;

  execute 'alter table public.seasons alter column mercy_rule set default false';
  execute 'alter table public.seasons alter column mercy_rule set not null';
  execute 'alter table public.seasons alter column mercy_rule_differential set default 10';
  execute 'alter table public.seasons alter column mercy_rule_differential set not null';

  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'season_schedule'
  ) then
    execute 'alter table public.season_schedule add column if not exists innings integer';
    execute 'alter table public.season_schedule add column if not exists mercy_rule boolean';
    execute 'alter table public.season_schedule add column if not exists mercy_rule_differential integer';

    execute $sql$
      update public.season_schedule as schedule
      set
        innings = greatest(coalesce(schedule.innings, seasons.innings, 3), 1),
        mercy_rule = coalesce(schedule.mercy_rule, seasons.mercy_rule, false),
        mercy_rule_differential = greatest(coalesce(schedule.mercy_rule_differential, seasons.mercy_rule_differential, 10), 1)
      from public.seasons as seasons
      where seasons.id = schedule.season_id
        and (
          schedule.innings is null
          or schedule.innings < 1
          or schedule.mercy_rule is null
          or schedule.mercy_rule_differential is null
          or schedule.mercy_rule_differential < 1
        )
    $sql$;

    execute 'alter table public.season_schedule alter column innings set default 3';
    execute 'alter table public.season_schedule alter column mercy_rule set default false';
    execute 'alter table public.season_schedule alter column mercy_rule_differential set default 10';
  end if;
end $$;

create or replace function public.enforce_season_settings()
returns trigger
language plpgsql
as $$
declare
  normalized_name text;
begin
  normalized_name := nullif(regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g'), '');
  if normalized_name is null then
    raise exception 'Season name is required.';
  end if;

  new.name := normalized_name;

  if exists (
    select 1
    from public.seasons
    where lower(name) = lower(normalized_name)
      and (new.id is null or id <> new.id)
  ) then
    raise exception 'A season named "%" already exists.', normalized_name
      using errcode = '23505';
  end if;

  if coalesce(new.games_per_matchup, 0) < 1 then
    raise exception 'Games per matchup must be at least 1.';
  end if;

  if coalesce(new.innings, 0) < 1 then
    raise exception 'Regulation innings must be at least 1.';
  end if;

  if coalesce(new.mercy_rule_differential, 0) < 1 then
    raise exception 'Mercy rule differential must be at least 1.';
  end if;

  return new;
end;
$$;

drop trigger if exists seasons_enforce_settings on public.seasons;

create trigger seasons_enforce_settings
before insert or update on public.seasons
for each row
execute function public.enforce_season_settings();
