-- Apply in the user's Supabase project. No privileged credential belongs in the browser.
create table if not exists public.finance_entities (
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('accounts','institutions','transactions','postings','categories','tags','transactionTags','instruments','investmentLots','prices','fxRates','budgets','recurringRules','goals','liabilityTerms','balanceSnapshots','settings')),
  id text not null,
  payload jsonb not null,
  version bigint not null check (version > 0),
  deleted_at timestamptz,
  device_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, entity_type, id),
  check (payload->>'id' = id),
  check (payload->>'ownerId' = owner_id::text),
  check ((payload->>'version')::bigint = version)
);
create index if not exists finance_owner_updates on public.finance_entities(owner_id, updated_at, entity_type, id);
alter table public.finance_entities enable row level security;
drop policy if exists finance_owner_read on public.finance_entities;
create policy finance_owner_read on public.finance_entities for select to authenticated using (owner_id = auth.uid());
-- Writes use the compare-and-swap RPC; direct REST mutation is deliberately revoked.
revoke all on public.finance_entities from anon, authenticated;
grant select on public.finance_entities to authenticated;

create or replace function public.finance_server_time() returns timestamptz language sql stable security invoker set search_path = public as $$ select now(); $$;
revoke all on function public.finance_server_time() from public;
grant execute on function public.finance_server_time() to authenticated;

create or replace function public.apply_finance_mutation(p_entity_type text, p_id text, p_expected_version bigint, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare current_row public.finance_entities; written public.finance_entities; owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Authentication required'; end if;
  if p_expected_version < 0 or p_payload->>'id' is distinct from p_id or p_payload->>'ownerId' is distinct from owner::text
     or (p_payload->>'version')::bigint is distinct from p_expected_version + 1
     or p_payload->>'deviceId' is null or p_payload->>'createdAt' is null or p_payload->>'updatedAt' is null then
    raise exception 'Invalid mutation ownership or metadata';
  end if;
  -- Serialize the first insert too, so two offline devices cannot both claim version one.
  perform pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_entity_type || ':' || p_id, 0));
  select * into current_row from public.finance_entities where owner_id = owner and entity_type = p_entity_type and id = p_id for update;
  if found and current_row.version <> p_expected_version then
    -- A lost HTTP response may replay the exact mutation after it already committed.
    if current_row.version = p_expected_version + 1 and current_row.payload = p_payload then return jsonb_build_object('kind','applied','record',to_jsonb(current_row)); end if;
    return jsonb_build_object('kind','conflict','record',to_jsonb(current_row));
  end if;
  if not found and p_expected_version <> 0 then raise exception 'Missing version history'; end if;
  insert into public.finance_entities(owner_id,entity_type,id,payload,version,deleted_at,device_id,created_at,updated_at)
    values(owner,p_entity_type,p_id,p_payload,p_expected_version+1,(p_payload->>'deletedAt')::timestamptz,p_payload->>'deviceId',(p_payload->>'createdAt')::timestamptz,clock_timestamp())
    on conflict(owner_id,entity_type,id) do update set payload=excluded.payload,version=excluded.version,deleted_at=excluded.deleted_at,device_id=excluded.device_id,updated_at=clock_timestamp()
    returning * into written;
  return jsonb_build_object('kind','applied','record',to_jsonb(written));
end $$;
revoke all on function public.apply_finance_mutation(text,text,bigint,jsonb) from public;
grant execute on function public.apply_finance_mutation(text,text,bigint,jsonb) to authenticated;

-- Supabase private Broadcast: only the authenticated owner may subscribe.
drop policy if exists finance_private_read on realtime.messages;
create policy finance_private_read on realtime.messages for select to authenticated using (realtime.topic() = 'finance:' || auth.uid()::text);
create or replace function public.finance_broadcast_changes() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform realtime.broadcast_changes('finance:' || coalesce(new.owner_id,old.owner_id)::text, TG_OP,TG_OP,TG_TABLE_NAME,TG_TABLE_SCHEMA,NEW,OLD);
  return coalesce(new,old);
end $$;
drop trigger if exists finance_private_broadcast on public.finance_entities;
create trigger finance_private_broadcast after insert or update or delete on public.finance_entities for each row execute function public.finance_broadcast_changes();
