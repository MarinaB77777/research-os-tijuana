-- Research OS consent-to-questionnaire flow v1.
-- Apply after:
--   question_bank_contract_v2.sql
--   research_configuration_contract_v1.sql
--   access_control_v1.sql
--   access_control_v2.sql
--
-- This migration makes consent a versioned entity, pins one consent version to
-- each questionnaire version, records the exact accepted text, and creates the
-- collection session in the same database transaction as consent acceptance.

begin;

create extension if not exists pgcrypto;

create table if not exists public.consent_documents (
    consent_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    consent_kind text not null check (consent_kind in ('standard', 'special')),
    status text not null check (status in ('draft', 'trial', 'active')),
    schema_version integer not null check (schema_version = 1),
    primary_language text not null check (length(btrim(primary_language)) > 0),
    texts jsonb not null default '{}'::jsonb check (jsonb_typeof(texts) = 'object'),
    is_system boolean not null default false,
    package_data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (consent_id, version),
    unique (code, version),
    check ((consent_kind = 'standard') = is_system)
);

-- The standard consent exists immediately as a real versioned entity. It is
-- intentionally empty and draft until an approved text is supplied. Empty
-- consent can be selected while designing a draft questionnaire, but cannot
-- authorize an active respondent session.
insert into public.consent_documents (
    consent_id, version, code, title, consent_kind, status, schema_version,
    primary_language, texts, is_system, package_data
) values (
    '00000000-0000-4000-8000-000000000001'::uuid,
    1,
    'STANDARD_CONSENT',
    'Standard informed consent',
    'standard',
    'draft',
    1,
    'es',
    jsonb_build_object('es', '', 'en', '', 'ru', ''),
    true,
    jsonb_build_object(
        'schema', 'research_os.consent_document',
        'schema_version', 1,
        'consent_id', '00000000-0000-4000-8000-000000000001',
        'version', 1,
        'code', 'STANDARD_CONSENT',
        'title', 'Standard informed consent',
        'consent_kind', 'standard',
        'status', 'draft',
        'primary_language', 'es',
        'texts', jsonb_build_object('es', '', 'en', '', 'ru', ''),
        'is_system', true
    )
)
on conflict (consent_id, version) do nothing;

create table if not exists public.questionnaire_consent_bindings (
    questionnaire_id uuid not null,
    questionnaire_version integer not null,
    consent_id uuid not null,
    consent_version integer not null,
    consent_mode text not null check (consent_mode in ('standard', 'special')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (questionnaire_id, questionnaire_version),
    foreign key (questionnaire_id, questionnaire_version)
        references public.questionnaires(questionnaire_id, version) on delete cascade,
    foreign key (consent_id, consent_version)
        references public.consent_documents(consent_id, version) on delete restrict
);

create table if not exists public.consent_acceptances (
    acceptance_id uuid primary key,
    session_id uuid not null unique,
    respondent_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    questionnaire_id uuid not null,
    questionnaire_version integer not null,
    consent_id uuid not null,
    consent_version integer not null,
    consent_language text not null,
    consent_title_snapshot text not null,
    consent_text_snapshot text not null,
    consent_text_sha256 text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
    acceptance_basis text not null check (acceptance_basis = 'authenticated_checkbox'),
    accepted_at timestamptz not null,
    status text not null default 'accepted'
        check (status in ('accepted', 'revoked')),
    revoked_at timestamptz,
    foreign key (questionnaire_id, questionnaire_version)
        references public.questionnaires(questionnaire_id, version) on delete restrict,
    foreign key (consent_id, consent_version)
        references public.consent_documents(consent_id, version) on delete restrict
);

alter table public.research_os_collection_sessions
    add column if not exists questionnaire_id uuid,
    add column if not exists questionnaire_version integer,
    add column if not exists consent_acceptance_id uuid;

do $$
begin
    if not exists (
        select 1
          from pg_constraint
         where conname = 'research_os_collection_sessions_questionnaire_fk'
           and conrelid = 'public.research_os_collection_sessions'::regclass
    ) then
        alter table public.research_os_collection_sessions
            add constraint research_os_collection_sessions_questionnaire_fk
            foreign key (questionnaire_id, questionnaire_version)
            references public.questionnaires(questionnaire_id, version) on delete restrict;
    end if;
    if not exists (
        select 1
          from pg_constraint
         where conname = 'research_os_collection_sessions_consent_acceptance_fk'
           and conrelid = 'public.research_os_collection_sessions'::regclass
    ) then
        alter table public.research_os_collection_sessions
            add constraint research_os_collection_sessions_consent_acceptance_fk
            foreign key (consent_acceptance_id)
            references public.consent_acceptances(acceptance_id) on delete restrict;
    end if;
    if not exists (
        select 1
          from pg_constraint
         where conname = 'consent_acceptances_session_fk'
           and conrelid = 'public.consent_acceptances'::regclass
    ) then
        alter table public.consent_acceptances
            add constraint consent_acceptances_session_fk
            foreign key (session_id)
            references public.research_os_collection_sessions(session_id) on delete restrict;
    end if;
end;
$$;

create index if not exists consent_documents_catalog_lookup
    on public.consent_documents(status, consent_kind, code, version desc);
create index if not exists questionnaire_consent_binding_lookup
    on public.questionnaire_consent_bindings(consent_id, consent_version);
create index if not exists consent_acceptances_respondent_lookup
    on public.consent_acceptances(respondent_account_id, accepted_at desc);
create index if not exists collection_sessions_questionnaire_lookup
    on public.research_os_collection_sessions(
        respondent_account_id, questionnaire_id, questionnaire_version, started_at desc
    );

-- A repeated use of one question version in a questionnaire is represented by
-- a distinct questionnaire item. Responses therefore key by item, not only by
-- question identity.
alter table public.research_response_records
    add column if not exists questionnaire_item_id uuid;

alter table public.research_response_records
    drop constraint if exists research_response_records_session_id_question_id_question_version_key;

create unique index if not exists research_response_records_session_item_unique
    on public.research_response_records(session_id, questionnaire_item_id)
    where questionnaire_item_id is not null;

alter table public.research_os_entity_ownership
    drop constraint if exists research_os_entity_ownership_entity_type_check;
alter table public.research_os_entity_ownership
    add constraint research_os_entity_ownership_entity_type_check
    check (entity_type in ('question_bank', 'parameter', 'questionnaire', 'consent_document'));

alter table public.consent_documents enable row level security;
alter table public.questionnaire_consent_bindings enable row level security;
alter table public.consent_acceptances enable row level security;
revoke all on public.consent_documents from public, anon, authenticated;
revoke all on public.questionnaire_consent_bindings from public, anon, authenticated;
revoke all on public.consent_acceptances from public, anon, authenticated;
grant select, insert, update on public.consent_documents to service_role;
grant select, insert, update on public.questionnaire_consent_bindings to service_role;
grant select, insert, update on public.consent_acceptances to service_role;

create or replace function public.save_owned_consent_document(
    consent_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_version integer;
    v_primary_language text;
    v_latest_version integer;
    v_existing public.consent_documents%rowtype;
begin
    if consent_data ->> 'schema' is distinct from 'research_os.consent_document'
       or (consent_data ->> 'schema_version')::integer is distinct from 1 then
        raise exception 'research_os.consent_document schema version 1 is required';
    end if;
    if consent_data ->> 'consent_kind' not in ('standard', 'special')
       or ((consent_data ->> 'consent_kind') = 'standard')
          is distinct from coalesce((consent_data ->> 'is_system')::boolean, false) then
        raise exception 'Consent kind and system identity are inconsistent';
    end if;
    if consent_data ->> 'status' not in ('draft', 'trial', 'active')
       or nullif(btrim(consent_data ->> 'title'), '') is null
       or nullif(btrim(consent_data ->> 'code'), '') is null
       or jsonb_typeof(consent_data -> 'texts') is distinct from 'object' then
        raise exception 'Consent identity, status, title, code and text map are required';
    end if;

    v_id := (consent_data ->> 'consent_id')::uuid;
    v_version := (consent_data ->> 'version')::integer;
    v_primary_language := consent_data ->> 'primary_language';
    if v_version < 1 or nullif(btrim(v_primary_language), '') is null then
        raise exception 'Positive version and primary language are required';
    end if;
    if consent_data ->> 'status' = 'active'
       and nullif(btrim(consent_data -> 'texts' ->> v_primary_language), '') is null then
        raise exception 'Active consent requires non-empty text in its primary language';
    end if;

    if consent_data ->> 'consent_kind' = 'standard' then
        if v_id is distinct from '00000000-0000-4000-8000-000000000001'::uuid
           or consent_data ->> 'code' is distinct from 'STANDARD_CONSENT' then
            raise exception 'The standard consent has one permanent identity and code';
        end if;
    else
        perform public.claim_research_os_entity(
            'consent_document', v_id, p_researcher_account_id
        );
    end if;

    select * into v_existing
      from public.consent_documents
     where consent_id = v_id and version = v_version
     for update;
    if found and v_existing.status = 'active' then
        if v_existing.package_data = consent_data then
            return jsonb_build_object(
                'consent_id', v_id, 'consent_version', v_version, 'idempotent', true
            );
        end if;
        raise exception 'Active consent version is immutable; create a new version';
    end if;

    if not found and consent_data ->> 'consent_kind' = 'standard' then
        select coalesce(max(c.version), 0) into v_latest_version
          from public.consent_documents c
         where c.consent_id = v_id;
        if v_version is distinct from v_latest_version + 1 then
            raise exception 'A new standard consent must use the next consecutive version';
        end if;
    end if;

    insert into public.consent_documents (
        consent_id, version, code, title, consent_kind, status, schema_version,
        primary_language, texts, is_system, package_data, updated_at
    ) values (
        v_id,
        v_version,
        consent_data ->> 'code',
        consent_data ->> 'title',
        consent_data ->> 'consent_kind',
        consent_data ->> 'status',
        1,
        v_primary_language,
        consent_data -> 'texts',
        (consent_data ->> 'consent_kind') = 'standard',
        consent_data,
        now()
    )
    on conflict (consent_id, version) do update set
        code = excluded.code,
        title = excluded.title,
        status = excluded.status,
        primary_language = excluded.primary_language,
        texts = excluded.texts,
        package_data = excluded.package_data,
        updated_at = now();

    return jsonb_build_object(
        'consent_id', v_id, 'consent_version', v_version, 'idempotent', false
    );
end;
$$;

create or replace function public.list_consent_documents_for_account(
    p_researcher_account_id uuid,
    requested_status text default 'all'
)
returns table (
    consent_id uuid,
    version integer,
    code text,
    title text,
    consent_kind text,
    status text,
    primary_language text,
    languages text[],
    is_system boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select c.consent_id,
           c.version,
           c.code,
           c.title,
           c.consent_kind,
           c.status,
           c.primary_language,
           array(select jsonb_object_keys(c.texts)),
           c.is_system
      from public.consent_documents c
     where (requested_status = 'all' or c.status = requested_status)
       and (
           c.is_system
           or exists (
               select 1
                 from public.research_os_entity_ownership o
                where o.entity_type = 'consent_document'
                  and o.entity_id = c.consent_id
                  and o.researcher_account_id = p_researcher_account_id
           )
       )
     order by c.is_system desc, c.title, c.version desc;
$$;

create or replace function public.load_consent_document_for_account(
    p_consent_id uuid,
    p_consent_version integer,
    p_researcher_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select c.package_data
      from public.consent_documents c
     where c.consent_id = p_consent_id
       and c.version = p_consent_version
       and (
           c.is_system
           or exists (
               select 1
                 from public.research_os_entity_ownership o
                where o.entity_type = 'consent_document'
                  and o.entity_id = c.consent_id
                  and o.researcher_account_id = p_researcher_account_id
           )
       );
$$;

create or replace function public.save_owned_questionnaire_with_consent(
    questionnaire_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_consent_id uuid;
    v_consent_version integer;
    v_consent_mode text;
    v_consent public.consent_documents%rowtype;
    v_result jsonb;
begin
    if jsonb_typeof(questionnaire_data -> 'consent') is distinct from 'object' then
        raise exception 'Questionnaire consent binding is required';
    end if;
    v_consent_id := (questionnaire_data #>> '{consent,consent_id}')::uuid;
    v_consent_version := (questionnaire_data #>> '{consent,consent_version}')::integer;
    v_consent_mode := questionnaire_data #>> '{consent,mode}';
    if v_consent_mode not in ('standard', 'special') then
        raise exception 'Consent mode must be standard or special';
    end if;

    select * into v_consent
      from public.consent_documents c
     where c.consent_id = v_consent_id and c.version = v_consent_version
     for share;
    if not found then
        raise exception 'Selected consent version does not exist';
    end if;
    if (v_consent_mode = 'standard') is distinct from v_consent.is_system then
        raise exception 'Consent mode does not match the selected document';
    end if;
    if not v_consent.is_system and not exists (
        select 1
          from public.research_os_entity_ownership o
         where o.entity_type = 'consent_document'
           and o.entity_id = v_consent_id
           and o.researcher_account_id = p_researcher_account_id
    ) then
        raise exception 'Selected special consent belongs to another researcher';
    end if;
    if questionnaire_data ->> 'status' = 'active' then
        if v_consent.status <> 'active'
           or nullif(btrim(v_consent.texts ->> v_consent.primary_language), '') is null then
            raise exception 'Active questionnaire requires an active non-empty consent version';
        end if;
    end if;

    perform public.claim_research_os_entity(
        'questionnaire',
        (questionnaire_data ->> 'questionnaire_id')::uuid,
        p_researcher_account_id
    );
    v_result := public.save_questionnaire_package(questionnaire_data);

    insert into public.questionnaire_consent_bindings (
        questionnaire_id, questionnaire_version, consent_id, consent_version,
        consent_mode, updated_at
    ) values (
        (questionnaire_data ->> 'questionnaire_id')::uuid,
        (questionnaire_data ->> 'version')::integer,
        v_consent_id,
        v_consent_version,
        v_consent_mode,
        now()
    )
    on conflict (questionnaire_id, questionnaire_version) do update set
        consent_id = excluded.consent_id,
        consent_version = excluded.consent_version,
        consent_mode = excluded.consent_mode,
        updated_at = now();

    return v_result || jsonb_build_object(
        'consent_id', v_consent_id,
        'consent_version', v_consent_version,
        'consent_mode', v_consent_mode
    );
end;
$$;

create or replace function public.list_respondent_questionnaires(
    p_respondent_account_id uuid
)
returns table (
    questionnaire_id uuid,
    version integer,
    code text,
    title text,
    description text,
    primary_language text,
    consent_id uuid,
    consent_version integer,
    consent_title text,
    consent_mode text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select available.questionnaire_id,
           available.version,
           available.code,
           available.title,
           available.description,
           available.primary_language,
           available.consent_id,
           available.consent_version,
           available.consent_title,
           available.consent_mode
      from (
          select distinct on (q.questionnaire_id)
                 q.questionnaire_id,
                 q.version,
                 q.code,
                 q.title,
                 q.description,
                 q.primary_language,
                 b.consent_id,
                 b.consent_version,
                 c.title as consent_title,
                 b.consent_mode
            from public.research_os_accounts respondent
            join public.research_os_entity_ownership owner
              on owner.researcher_account_id = respondent.created_by_account_id
             and owner.entity_type = 'questionnaire'
            join public.questionnaires q
              on q.questionnaire_id = owner.entity_id
             and q.status = 'active'
            join public.questionnaire_consent_bindings b
              on b.questionnaire_id = q.questionnaire_id
             and b.questionnaire_version = q.version
            join public.consent_documents c
              on c.consent_id = b.consent_id
             and c.version = b.consent_version
             and c.status = 'active'
           where respondent.account_id = p_respondent_account_id
             and respondent.role = 'respondent'
             and respondent.status = 'active'
           order by q.questionnaire_id, q.version desc
      ) available
     order by available.title;
$$;

create or replace function public.get_respondent_questionnaire_consent(
    p_respondent_account_id uuid,
    p_questionnaire_id uuid,
    p_questionnaire_version integer,
    p_requested_language text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_row record;
    v_language text;
    v_text text;
begin
    select q.title as questionnaire_title,
           q.description,
           c.consent_id,
           c.version as consent_version,
           c.title as consent_title,
           c.primary_language,
           c.texts
      into v_row
      from public.research_os_accounts respondent
      join public.research_os_entity_ownership owner
        on owner.researcher_account_id = respondent.created_by_account_id
       and owner.entity_type = 'questionnaire'
      join public.questionnaires q
        on q.questionnaire_id = owner.entity_id
       and q.questionnaire_id = p_questionnaire_id
       and q.version = p_questionnaire_version
       and q.status = 'active'
      join public.questionnaire_consent_bindings b
        on b.questionnaire_id = q.questionnaire_id
       and b.questionnaire_version = q.version
      join public.consent_documents c
        on c.consent_id = b.consent_id
       and c.version = b.consent_version
       and c.status = 'active'
     where respondent.account_id = p_respondent_account_id
       and respondent.role = 'respondent'
       and respondent.status = 'active';
    if not found then
        return null;
    end if;

    v_language := case
        when nullif(btrim(v_row.texts ->> p_requested_language), '') is not null
            then p_requested_language
        else v_row.primary_language
    end;
    v_text := v_row.texts ->> v_language;
    if nullif(btrim(v_text), '') is null then
        return null;
    end if;

    return jsonb_build_object(
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version,
        'questionnaire_title', v_row.questionnaire_title,
        'questionnaire_description', v_row.description,
        'consent_id', v_row.consent_id,
        'consent_version', v_row.consent_version,
        'consent_title', v_row.consent_title,
        'language', v_language,
        'text', v_text,
        'text_sha256', encode(digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex')
    );
end;
$$;

create or replace function public.accept_consent_and_start_questionnaire(
    p_respondent_account_id uuid,
    p_questionnaire_id uuid,
    p_questionnaire_version integer,
    p_requested_language text,
    p_explicit_acceptance boolean
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_respondent public.research_os_accounts%rowtype;
    v_consent jsonb;
    v_session_id uuid := gen_random_uuid();
    v_acceptance_id uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_consent_record jsonb;
begin
    if p_explicit_acceptance is distinct from true then
        raise exception 'Explicit consent acceptance is required';
    end if;
    select * into v_respondent
      from public.research_os_accounts
     where account_id = p_respondent_account_id
       and role = 'respondent'
       and status = 'active'
     for share;
    if not found or v_respondent.created_by_account_id is null then
        raise exception 'Active respondent with a researcher relationship is required';
    end if;

    v_consent := public.get_respondent_questionnaire_consent(
        p_respondent_account_id,
        p_questionnaire_id,
        p_questionnaire_version,
        p_requested_language
    );
    if v_consent is null then
        raise exception 'Active questionnaire with a valid non-empty consent is required';
    end if;

    v_consent_record := jsonb_build_object(
        'consent_status', 'accepted',
        'consent_id', v_consent ->> 'consent_id',
        'consent_version', (v_consent ->> 'consent_version')::integer,
        'language', v_consent ->> 'language',
        'text_sha256', v_consent ->> 'text_sha256',
        'accepted_at', v_now,
        'acceptance_basis', 'authenticated_checkbox',
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version
    );

    insert into public.research_os_collection_sessions (
        session_id,
        respondent_account_id,
        researcher_account_id,
        respondent_identifier,
        study_id,
        questionnaire_id,
        questionnaire_version,
        status,
        consent_record,
        global_time_reference,
        started_at
    ) values (
        v_session_id,
        v_respondent.account_id,
        v_respondent.created_by_account_id,
        v_respondent.user_identifier,
        p_questionnaire_id::text,
        p_questionnaire_id,
        p_questionnaire_version,
        'active',
        v_consent_record,
        v_now,
        v_now
    );

    insert into public.consent_acceptances (
        acceptance_id,
        session_id,
        respondent_account_id,
        researcher_account_id,
        questionnaire_id,
        questionnaire_version,
        consent_id,
        consent_version,
        consent_language,
        consent_title_snapshot,
        consent_text_snapshot,
        consent_text_sha256,
        acceptance_basis,
        accepted_at
    ) values (
        v_acceptance_id,
        v_session_id,
        v_respondent.account_id,
        v_respondent.created_by_account_id,
        p_questionnaire_id,
        p_questionnaire_version,
        (v_consent ->> 'consent_id')::uuid,
        (v_consent ->> 'consent_version')::integer,
        v_consent ->> 'language',
        v_consent ->> 'consent_title',
        v_consent ->> 'text',
        v_consent ->> 'text_sha256',
        'authenticated_checkbox',
        v_now
    );

    update public.research_os_collection_sessions
       set consent_acceptance_id = v_acceptance_id
     where session_id = v_session_id;

    return jsonb_build_object(
        'session_id', v_session_id,
        'global_time_reference', v_now,
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version,
        'consent_acceptance_id', v_acceptance_id,
        'consent_id', v_consent ->> 'consent_id',
        'consent_version', (v_consent ->> 'consent_version')::integer,
        'consent_language', v_consent ->> 'language',
        'accepted_at', v_now
    );
end;
$$;

create or replace function public.list_respondent_collection_sessions(
    p_respondent_account_id uuid
)
returns table (
    session_id uuid,
    status text,
    questionnaire_id uuid,
    questionnaire_version integer,
    questionnaire_title text,
    started_at timestamptz,
    completed_at timestamptz,
    consent_acceptance_id uuid,
    consent_id uuid,
    consent_version integer,
    consent_language text,
    consent_title text,
    consent_text text,
    consent_text_sha256 text,
    accepted_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.session_id,
           s.status,
           s.questionnaire_id,
           s.questionnaire_version,
           q.title,
           s.started_at,
           s.completed_at,
           a.acceptance_id,
           a.consent_id,
           a.consent_version,
           a.consent_language,
           a.consent_title_snapshot,
           a.consent_text_snapshot,
           a.consent_text_sha256,
           a.accepted_at
      from public.research_os_collection_sessions s
      join public.questionnaires q
        on q.questionnaire_id = s.questionnaire_id
       and q.version = s.questionnaire_version
      join public.consent_acceptances a
        on a.acceptance_id = s.consent_acceptance_id
     where s.respondent_account_id = p_respondent_account_id
     order by s.started_at desc;
$$;

create or replace function public.load_respondent_collection_session(
    p_respondent_account_id uuid,
    p_session_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'session_id', s.session_id,
        'status', s.status,
        'global_time_reference', s.global_time_reference,
        'started_at', s.started_at,
        'completed_at', s.completed_at,
        'questionnaire', q.package_data,
        'consent_acceptance_id', a.acceptance_id,
        'accepted_at', a.accepted_at
    )
      from public.research_os_collection_sessions s
      join public.questionnaires q
        on q.questionnaire_id = s.questionnaire_id
       and q.version = s.questionnaire_version
      join public.consent_acceptances a
        on a.acceptance_id = s.consent_acceptance_id
     where s.respondent_account_id = p_respondent_account_id
       and s.session_id = p_session_id;
$$;

create or replace function public.save_response_records(
    source_identity jsonb,
    response_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_record jsonb;
    v_session_id text;
    v_saved integer := 0;
begin
    if jsonb_typeof(source_identity) is distinct from 'object'
       or jsonb_typeof(response_records) is distinct from 'array'
       or jsonb_array_length(response_records) = 0 then
        raise exception 'Source identity and non-empty response-record array are required';
    end if;
    v_session_id := source_identity ->> 'session_id';
    if v_session_id is null
       or source_identity ->> 'global_time_reference' is null
       or source_identity ->> 'collection_started_at' is null
       or source_identity ->> 'collection_finished_at' is null then
        raise exception 'Source identity lacks session or global-time fields';
    end if;

    for v_record in select value from jsonb_array_elements(response_records)
    loop
        if v_record ->> 'session_id' is distinct from v_session_id
           or v_record ->> 'questionnaire_item_id' is null then
            raise exception 'Response session/item does not match source identity';
        end if;
        if not exists (
            select 1
              from public.questionnaire_items qi
             where qi.questionnaire_id = (source_identity ->> 'questionnaire_id')::uuid
               and qi.questionnaire_version =
                   (source_identity ->> 'questionnaire_version')::integer
               and qi.item_id = (v_record ->> 'questionnaire_item_id')::uuid
               and qi.source_bank_id = (v_record ->> 'bank_id')::uuid
               and qi.source_bank_version = (v_record ->> 'bank_version')::integer
               and qi.question_id = (v_record ->> 'question_id')::uuid
               and qi.question_version = (v_record ->> 'question_version')::integer
        ) then
            raise exception 'Response does not match an item in the session questionnaire version';
        end if;

        insert into public.research_response_records (
            response_id, session_id, participant_id,
            bank_id, bank_version, question_id, question_version,
            questionnaire_item_id, code, value, scale_snapshot, answered_at,
            global_time_reference, source_identity
        ) values (
            (v_record ->> 'response_id')::uuid,
            v_session_id,
            v_record ->> 'participant_id',
            (v_record ->> 'bank_id')::uuid,
            (v_record ->> 'bank_version')::integer,
            (v_record ->> 'question_id')::uuid,
            (v_record ->> 'question_version')::integer,
            (v_record ->> 'questionnaire_item_id')::uuid,
            v_record ->> 'code',
            v_record -> 'value',
            v_record -> 'scale',
            (v_record ->> 'answered_at')::timestamptz,
            (v_record ->> 'global_time_reference')::timestamptz,
            source_identity
        )
        on conflict (response_id) do nothing;
        v_saved := v_saved + 1;
    end loop;

    return jsonb_build_object('session_id', v_session_id, 'saved_count', v_saved);
end;
$$;

revoke all on function public.save_owned_consent_document(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.list_consent_documents_for_account(uuid, text)
    from public, anon, authenticated;
revoke all on function public.load_consent_document_for_account(uuid, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.save_owned_questionnaire_with_consent(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.list_respondent_questionnaires(uuid)
    from public, anon, authenticated;
revoke all on function public.get_respondent_questionnaire_consent(uuid, uuid, integer, text)
    from public, anon, authenticated;
revoke all on function public.accept_consent_and_start_questionnaire(uuid, uuid, integer, text, boolean)
    from public, anon, authenticated;
revoke all on function public.list_respondent_collection_sessions(uuid)
    from public, anon, authenticated;
revoke all on function public.load_respondent_collection_session(uuid, uuid)
    from public, anon, authenticated;

grant execute on function public.save_owned_consent_document(jsonb, uuid)
    to service_role;
grant execute on function public.list_consent_documents_for_account(uuid, text)
    to service_role;
grant execute on function public.load_consent_document_for_account(uuid, integer, uuid)
    to service_role;
grant execute on function public.save_owned_questionnaire_with_consent(jsonb, uuid)
    to service_role;
grant execute on function public.list_respondent_questionnaires(uuid)
    to service_role;
grant execute on function public.get_respondent_questionnaire_consent(uuid, uuid, integer, text)
    to service_role;
grant execute on function public.accept_consent_and_start_questionnaire(uuid, uuid, integer, text, boolean)
    to service_role;
grant execute on function public.list_respondent_collection_sessions(uuid)
    to service_role;
grant execute on function public.load_respondent_collection_session(uuid, uuid)
    to service_role;

commit;
