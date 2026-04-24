alter table players
  add column if not exists scorebook_access boolean default false;
