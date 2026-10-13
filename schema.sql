-- Emberforge database setup. Run once in Supabase > SQL Editor.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  daily_limit int not null default 30,   -- change this number per user for more/less messages
  created_at timestamptz not null default now()
);

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null default 'New chat',
  mode text not null default 'website',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table public.usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  used int not null default 0,
  primary key (user_id, day)
);

create index chats_user_updated_idx on public.chats (user_id, updated_at desc);
create index messages_chat_created_idx on public.messages (chat_id, created_at);
create index messages_user_idx on public.messages (user_id);

alter table public.profiles enable row level security;
alter table public.chats    enable row level security;
alter table public.messages enable row level security;
alter table public.usage    enable row level security;

create policy "read own profile" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "read own usage" on public.usage for select to authenticated
  using (user_id = (select auth.uid()));
create policy "manage own chats" on public.chats for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "read own messages" on public.messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy "add own messages" on public.messages for insert to authenticated
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.chats c where c.id = chat_id and c.user_id = (select auth.uid())));
create policy "delete own messages" on public.messages for delete to authenticated
  using (user_id = (select auth.uid()));

grant select on public.profiles, public.usage to authenticated;
grant select, insert, update, delete on public.chats to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant all on all tables in schema public to service_role;

-- Create a profile automatically when someone signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Daily limit counter (day changes at midnight India time). Only the server can call these.
create or replace function public.consume_message(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lim int;
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_used int;
begin
  select daily_limit into v_lim from public.profiles where id = p_user;
  if v_lim is null then v_lim := 30; end if;
  insert into public.usage (user_id, day, used) values (p_user, v_day, 0) on conflict do nothing;
  update public.usage set used = used + 1
    where user_id = p_user and day = v_day and used < v_lim
    returning used into v_used;
  if v_used is null then
    select used into v_used from public.usage where user_id = p_user and day = v_day;
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', v_lim);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used, 'limit', v_lim);
end $$;

create or replace function public.refund_message(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  update public.usage set used = greatest(used - 1, 0)
  where user_id = p_user and day = (now() at time zone 'Asia/Kolkata')::date;
$$;

create or replace function public.get_usage(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lim int; v_used int;
begin
  select daily_limit into v_lim from public.profiles where id = p_user;
  select used into v_used from public.usage
    where user_id = p_user and day = (now() at time zone 'Asia/Kolkata')::date;
  return jsonb_build_object('used', coalesce(v_used, 0), 'limit', coalesce(v_lim, 30));
end $$;

revoke execute on function public.consume_message(uuid), public.refund_message(uuid), public.get_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.consume_message(uuid), public.refund_message(uuid), public.get_usage(uuid)
  to service_role;
