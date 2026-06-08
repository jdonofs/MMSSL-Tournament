-- Custom logo URL for season teams (overrides static team_logo_key)
alter table season_teams add column if not exists logo_url text;

-- Custom logo URLs for tournament teams (keyed by tournament + player)
create table if not exists tournament_team_logos (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  logo_url text not null,
  updated_at timestamptz default now(),
  unique(tournament_id, player_id)
);

-- Public storage bucket for uploaded team logos (5 MB limit)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-logos',
  'team-logos',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

-- Allow anyone to read team logos
create policy "team_logos_public_read"
  on storage.objects for select
  using (bucket_id = 'team-logos');

-- Allow authenticated users to upload/replace team logos
create policy "team_logos_auth_insert"
  on storage.objects for insert
  with check (bucket_id = 'team-logos');

create policy "team_logos_auth_update"
  on storage.objects for update
  using (bucket_id = 'team-logos');

create policy "team_logos_auth_delete"
  on storage.objects for delete
  using (bucket_id = 'team-logos');
