do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'seasons'
      and column_name = 'innings'
  ) then
    execute 'alter table public.seasons alter column innings set default 3';
    execute 'update public.seasons set innings = 3 where innings is null or innings <= 0 or innings = 9';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tournaments'
      and column_name = 'innings'
  ) then
    execute 'alter table public.tournaments alter column innings set default 3';
    execute 'update public.tournaments set innings = 3 where innings is null or innings <= 0';
  end if;
end $$;
