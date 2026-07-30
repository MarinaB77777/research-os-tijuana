-- Research OS multi-account authentication and ownership migration v2.
-- Apply after question_bank_contract_v2.sql, research_configuration_contract_v1.sql
-- and access_control_v1.sql.

begin;

create extension if not exists pgcrypto;

create table if not exists public.research_os_accounts (
    account_id uuid primary key default gen_random_uuid(),
    username text not null check (
        length(username) between 3 and 128
        and username ~ '^[A-Za-z0-9_.@+-]+$'
    ),
    password_hash text not null,
    role text not null check (role in ('researcher', 'respondent')),
    user_identifier text not null check (length(btrim(user_identifier)) > 0),
    status text not null default 'active'
        check (status in ('active', 'suspended', 'revoked')),
    created_by_account_id uuid references public.research_os_accounts(account_id)
        on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    password_changed_at timestamptz not null default now(),
    last_login_at timestamptz,
    failed_login_count integer not null default 0 check (failed_login_count >= 0),
    locked_until timestamptz
);

create unique index if not exists research_os_accounts_username_unique
    on public.research_os_accounts (lower(username));
create unique index if not exists research_os_accounts_identifier_unique
    on public.research_os_accounts (user_identifier);
create index if not exists research_os_accounts_creator_lookup
    on public.research_os_accounts (created_by_account_id, role, status);

create table if not exists public.research_os_auth_sessions (
    session_id uuid primary key,
    account_id uuid not null references public.research_os_accounts(account_id)
        on delete cascade,
    token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    check (expires_at > created_at)
);

create index if not exists research_os_auth_sessions_active_lookup
    on public.research_os_auth_sessions (token_hash, expires_at)
    where revoked_at is null;

create table if not exists public.research_os_entity_ownership (
    entity_type text not null
        check (entity_type in ('question_bank', 'parameter', 'questionnaire')),
    entity_id uuid not null,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    created_at timestamptz not null default now(),
    primary key (entity_type, entity_id)
);

create table if not exists public.research_os_ai_preferences (
    researcher_account_id uuid primary key
        references public.research_os_accounts(account_id) on delete cascade,
    preferences jsonb not null check (jsonb_typeof(preferences) = 'object'),
    updated_at timestamptz not null default now()
);

alter table public.research_os_collection_sessions
    add column if not exists respondent_account_id uuid
        references public.research_os_accounts(account_id) on delete restrict,
    add column if not exists researcher_account_id uuid
        references public.research_os_accounts(account_id) on delete restrict;

create index if not exists research_os_collection_sessions_respondent_account
    on public.research_os_collection_sessions (respondent_account_id, status);
create index if not exists research_os_collection_sessions_researcher_account
    on public.research_os_collection_sessions (researcher_account_id, status);

alter table public.research_os_accounts enable row level security;
alter table public.research_os_auth_sessions enable row level security;
alter table public.research_os_entity_ownership enable row level security;
alter table public.research_os_ai_preferences enable row level security;
revoke all on public.research_os_accounts from public, anon, authenticated;
revoke all on public.research_os_auth_sessions from public, anon, authenticated;
revoke all on public.research_os_entity_ownership from public, anon, authenticated;
revoke all on public.research_os_ai_preferences from public, anon, authenticated;
grant select, insert, update on public.research_os_accounts to service_role;
grant select, insert, update, delete on public.research_os_auth_sessions to service_role;
grant select, insert on public.research_os_entity_ownership to service_role;
grant select, insert, update on public.research_os_ai_preferences to service_role;

create or replace function public.load_researcher_ai_preferences(
    p_researcher_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select p.preferences
      from public.research_os_ai_preferences p
      join public.research_os_accounts a
        on a.account_id = p.researcher_account_id
       and a.role = 'researcher'
       and a.status = 'active'
     where p.researcher_account_id = p_researcher_account_id;
$$;

create or replace function public.save_researcher_ai_preferences(
    p_researcher_account_id uuid,
    p_preferences jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if jsonb_typeof(p_preferences) is distinct from 'object'
       or not exists (
           select 1
             from public.research_os_accounts a
            where a.account_id = p_researcher_account_id
              and a.role = 'researcher'
              and a.status = 'active'
       ) then
        raise exception 'An active researcher and an AI preference object are required';
    end if;
    insert into public.research_os_ai_preferences (
        researcher_account_id, preferences, updated_at
    ) values (
        p_researcher_account_id, p_preferences, now()
    )
    on conflict (researcher_account_id) do update set
        preferences = excluded.preferences,
        updated_at = now();
    return p_preferences;
end;
$$;

create or replace function public.create_research_os_account(
    p_username text,
    p_password text,
    p_role text,
    p_user_identifier text,
    p_created_by_account_id uuid default null
)
returns table (
    account_id uuid,
    username text,
    role text,
    user_identifier text,
    created_by_account_id uuid,
    status text
)
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_creator_role text;
    v_account public.research_os_accounts%rowtype;
begin
    if p_role is null
       or p_role not in ('researcher', 'respondent')
       or p_username is null
       or length(btrim(p_username)) not between 3 and 128
       or btrim(p_username) !~ '^[A-Za-z0-9_.@+-]+$'
       or p_password is null
       or length(p_password) < 10
       or nullif(btrim(p_user_identifier), '') is null then
        raise exception 'Valid username, password, role and user identifier are required';
    end if;

    if p_created_by_account_id is null then
        perform pg_advisory_xact_lock(hashtext('research_os_first_researcher'));
        if p_role <> 'researcher'
           or exists (select 1 from public.research_os_accounts a where a.role = 'researcher') then
            raise exception 'Only the first researcher may be created without a researcher account';
        end if;
    else
        select a.role into v_creator_role
          from public.research_os_accounts a
         where a.account_id = p_created_by_account_id
           and a.status = 'active'
         for share;
        if v_creator_role is distinct from 'researcher' then
            raise exception 'An active researcher account is required to create accounts';
        end if;
    end if;

    insert into public.research_os_accounts (
        username, password_hash, role, user_identifier, created_by_account_id
    ) values (
        lower(btrim(p_username)),
        crypt(p_password, gen_salt('bf', 12)),
        p_role,
        btrim(p_user_identifier),
        p_created_by_account_id
    )
    returning * into v_account;

    return query select
        v_account.account_id,
        v_account.username,
        v_account.role,
        v_account.user_identifier,
        v_account.created_by_account_id,
        v_account.status;
end;
$$;

create or replace function public.authenticate_research_os_account(
    p_username text,
    p_password text
)
returns table (
    account_id uuid,
    role text,
    user_identifier text
)
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_account public.research_os_accounts%rowtype;
begin
    select a.* into v_account
      from public.research_os_accounts a
     where lower(a.username) = lower(btrim(p_username))
       and a.status = 'active'
     limit 1;

    if not found then
        -- Keep unknown-user attempts computationally expensive as well.
        perform crypt(p_password, gen_salt('bf', 12));
        return;
    end if;

    if v_account.locked_until is not null and v_account.locked_until > now() then
        return;
    end if;

    if v_account.password_hash is distinct from crypt(p_password, v_account.password_hash) then
        update public.research_os_accounts a
           set failed_login_count = a.failed_login_count + 1,
               locked_until = case
                   when a.failed_login_count + 1 >= 10 then now() + interval '15 minutes'
                   else null
               end,
               updated_at = now()
         where a.account_id = v_account.account_id;
        return;
    end if;

    update public.research_os_accounts a
       set last_login_at = now(),
           failed_login_count = 0,
           locked_until = null,
           updated_at = now()
     where a.account_id = v_account.account_id;

    return query select v_account.account_id, v_account.role, v_account.user_identifier;
end;
$$;

create or replace function public.claim_research_os_entity(
    p_entity_type text,
    p_entity_id uuid,
    p_researcher_account_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_owner uuid;
begin
    if not exists (
        select 1 from public.research_os_accounts a
         where a.account_id = p_researcher_account_id
           and a.role = 'researcher'
           and a.status = 'active'
    ) then
        raise exception 'An active researcher account is required';
    end if;

    insert into public.research_os_entity_ownership (
        entity_type, entity_id, researcher_account_id
    ) values (p_entity_type, p_entity_id, p_researcher_account_id)
    on conflict (entity_type, entity_id) do nothing;

    select o.researcher_account_id into v_owner
      from public.research_os_entity_ownership o
     where o.entity_type = p_entity_type and o.entity_id = p_entity_id
     for update;
    if v_owner is distinct from p_researcher_account_id then
        raise exception 'The entity belongs to another researcher';
    end if;
end;
$$;

create or replace function public.save_owned_question_bank_package(
    package_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
    v_owner_identifier text;
begin
    select a.user_identifier
      into v_owner_identifier
      from public.research_os_accounts a
     where a.account_id = p_researcher_account_id
       and a.role = 'researcher'
       and a.status = 'active';
    if v_owner_identifier is null then
        raise exception 'An active researcher account is required';
    end if;
    package_data := jsonb_set(
        package_data,
        '{authorship}',
        jsonb_build_object(
            'owner_account_id', p_researcher_account_id,
            'owner_identifier', v_owner_identifier,
            'asserted_by', 'authenticated_server'
        ),
        true
    );
    package_data := jsonb_set(
        package_data,
        '{reuse_policy}',
        jsonb_build_object(
            'permission',
            case
                when package_data #>> '{reuse_policy,permission}' = 'permission_required'
                    then 'permission_required'
                else 'attribution_permitted'
            end,
            'attribution_required', true,
            'ownership_retained_by_author', true
        ),
        true
    );
    perform public.claim_research_os_entity(
        'question_bank', (package_data ->> 'bank_id')::uuid, p_researcher_account_id
    );
    return public.save_question_bank_package(package_data);
end;
$$;

create or replace function public.save_owned_parameter_definition(
    parameter_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
    perform public.claim_research_os_entity(
        'parameter', (parameter_data ->> 'parameter_id')::uuid, p_researcher_account_id
    );
    return public.save_parameter_definition(parameter_data);
end;
$$;

create or replace function public.save_owned_questionnaire_package(
    questionnaire_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
    perform public.claim_research_os_entity(
        'questionnaire', (questionnaire_data ->> 'questionnaire_id')::uuid, p_researcher_account_id
    );
    return public.save_questionnaire_package(questionnaire_data);
end;
$$;

create or replace function public.load_question_bank_package_for_account(
    bank_reference text,
    requested_version integer,
    p_researcher_account_id uuid
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select qb.package_data
      from public.question_banks qb
     where (
         qb.code = upper(bank_reference)
         or (
             bank_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             and qb.bank_id = bank_reference::uuid
         )
     )
       and (requested_version is null or qb.version = requested_version)
       and (
           (
               qb.status = 'active'
               and coalesce(
                   qb.package_data #>> '{reuse_policy,permission}',
                   'attribution_permitted'
               ) = 'attribution_permitted'
           )
           or exists (
               select 1
                 from public.research_os_entity_ownership o
                where o.entity_type = 'question_bank'
                  and o.entity_id = qb.bank_id
                  and o.researcher_account_id = p_researcher_account_id
           )
       )
     order by qb.version desc
     limit 1;
$$;

revoke all on function public.create_research_os_account(text, text, text, text, uuid)
    from public, anon, authenticated;
revoke all on function public.authenticate_research_os_account(text, text)
    from public, anon, authenticated;
revoke all on function public.claim_research_os_entity(text, uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.save_owned_question_bank_package(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.save_owned_parameter_definition(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.save_owned_questionnaire_package(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_bank_package_for_account(text, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.load_researcher_ai_preferences(uuid)
    from public, anon, authenticated;
revoke all on function public.save_researcher_ai_preferences(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.create_research_os_account(text, text, text, text, uuid)
    to service_role;
grant execute on function public.authenticate_research_os_account(text, text)
    to service_role;
grant execute on function public.claim_research_os_entity(text, uuid, uuid)
    to service_role;
grant execute on function public.save_owned_question_bank_package(jsonb, uuid)
    to service_role;
grant execute on function public.save_owned_parameter_definition(jsonb, uuid)
    to service_role;
grant execute on function public.save_owned_questionnaire_package(jsonb, uuid)
    to service_role;
grant execute on function public.load_question_bank_package_for_account(text, integer, uuid)
    to service_role;
grant execute on function public.load_researcher_ai_preferences(uuid)
    to service_role;
grant execute on function public.save_researcher_ai_preferences(uuid, jsonb)
    to service_role;

commit;
