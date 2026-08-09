-- Research OS accepted question-translation variants v1.
-- Apply after question_bank_contract_v2.sql and access_control_v2.sql.
-- Source question definitions remain immutable. Accepted translations are
-- stored beside them and are scoped to the researcher who approved them.

begin;

create extension if not exists pgcrypto;

create table if not exists public.question_translation_packages (
    translation_package_id uuid primary key default gen_random_uuid(),
    source_schema text not null check (
        source_schema in ('research_os.question_bank', 'research_os.questionnaire')
    ),
    source_entity_id uuid not null,
    source_version integer not null check (source_version > 0),
    source_primary_language text not null check (length(btrim(source_primary_language)) > 0),
    target_language text not null check (length(btrim(target_language)) > 0),
    translation_version integer not null check (translation_version > 0),
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
    translated_document jsonb not null check (jsonb_typeof(translated_document) = 'object'),
    translation_provenance jsonb not null check (jsonb_typeof(translation_provenance) = 'object'),
    human_disposition text not null check (human_disposition = 'accepted'),
    accepted_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (
        researcher_account_id, source_schema, source_entity_id, source_version,
        target_language, translation_version
    )
);

create table if not exists public.question_translation_variants (
    translation_package_id uuid not null
        references public.question_translation_packages(translation_package_id) on delete restrict,
    question_id uuid not null,
    question_version integer not null check (question_version > 0),
    target_language text not null check (length(btrim(target_language)) > 0),
    translation_version integer not null check (translation_version > 0),
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    translated_definition jsonb not null check (jsonb_typeof(translated_definition) = 'object'),
    created_at timestamptz not null default now(),
    primary key (
        researcher_account_id, question_id, question_version,
        target_language, translation_version
    ),
    foreign key (question_id, question_version)
        references public.question_definitions(question_id, version) on delete restrict
);

create index if not exists question_translation_latest_lookup
    on public.question_translation_variants(
        researcher_account_id, question_id, question_version,
        target_language, translation_version desc
    );

alter table public.question_translation_packages enable row level security;
alter table public.question_translation_variants enable row level security;
revoke all on public.question_translation_packages from public, anon, authenticated;
revoke all on public.question_translation_variants from public, anon, authenticated;
grant select, insert on public.question_translation_packages to service_role;
grant select, insert on public.question_translation_variants to service_role;

create or replace function public.save_accepted_question_translation_package(
    translation_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_provenance jsonb;
    v_source_identity jsonb;
    v_source_schema text;
    v_source_entity_id uuid;
    v_source_version integer;
    v_source_language text;
    v_target_language text;
    v_source_sha256 text;
    v_accepted_at timestamptz;
    v_translation_version integer;
    v_package_id uuid := gen_random_uuid();
    v_entry jsonb;
    v_question_id uuid;
    v_question_version integer;
    v_question_translation_version integer;
    v_definition jsonb;
    v_saved integer := 0;
    v_seen jsonb := '{}'::jsonb;
    v_key text;
begin
    if jsonb_typeof(translation_data) is distinct from 'object' then
        raise exception 'A translated canonical document is required';
    end if;
    v_provenance := translation_data -> 'translation_provenance';
    if v_provenance ->> 'schema' is distinct from 'research_os.ai_translation_provenance'
       or (v_provenance ->> 'schema_version')::integer is distinct from 1
       or v_provenance #>> '{human_disposition,status}' is distinct from 'accepted'
       or nullif(btrim(v_provenance ->> 'source_sha256'), '') is null then
        raise exception 'Accepted translation provenance is required';
    end if;

    v_source_identity := v_provenance -> 'source_identity';
    v_source_schema := v_source_identity ->> 'schema';
    if v_source_schema not in ('research_os.question_bank', 'research_os.questionnaire')
       or translation_data ->> 'schema' is distinct from v_source_schema then
        raise exception 'Translation source schema is invalid';
    end if;
    v_source_entity_id := case
        when v_source_schema = 'research_os.question_bank'
            then (v_source_identity ->> 'bank_id')::uuid
        else (v_source_identity ->> 'questionnaire_id')::uuid
    end;
    v_source_version := (v_source_identity ->> 'version')::integer;
    v_source_language := v_provenance ->> 'source_primary_language';
    v_target_language := v_provenance ->> 'target_language';
    v_source_sha256 := lower(v_provenance ->> 'source_sha256');
    v_accepted_at := (v_provenance #>> '{human_disposition,decided_at}')::timestamptz;
    if v_source_version < 1
       or nullif(btrim(v_source_language), '') is null
       or nullif(btrim(v_target_language), '') is null
       or lower(v_source_language) = lower(v_target_language)
       or v_accepted_at is null then
        raise exception 'Source version, distinct languages, and acceptance time are required';
    end if;

    if v_source_schema = 'research_os.question_bank' then
        if translation_data ->> 'bank_id' is distinct from v_source_entity_id::text
           or (translation_data ->> 'version')::integer is distinct from v_source_version
           or jsonb_typeof(translation_data -> 'questions') is distinct from 'object' then
            raise exception 'Translated bank identity does not match its source identity';
        end if;
    else
        if translation_data ->> 'questionnaire_id' is distinct from v_source_entity_id::text
           or (translation_data ->> 'version')::integer is distinct from v_source_version
           or jsonb_typeof(translation_data -> 'items') is distinct from 'array' then
            raise exception 'Translated questionnaire identity does not match its source identity';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        p_researcher_account_id::text || ':' || v_source_schema || ':' ||
        v_source_entity_id::text || ':' || v_source_version::text || ':' || lower(v_target_language),
        0
    ));
    select coalesce(max(tp.translation_version), 0) + 1
      into v_translation_version
      from public.question_translation_packages tp
     where tp.researcher_account_id = p_researcher_account_id
       and tp.source_schema = v_source_schema
       and tp.source_entity_id = v_source_entity_id
       and tp.source_version = v_source_version
       and lower(tp.target_language) = lower(v_target_language);

    insert into public.question_translation_packages (
        translation_package_id, source_schema, source_entity_id, source_version,
        source_primary_language, target_language, translation_version,
        researcher_account_id, source_sha256, translated_document,
        translation_provenance, human_disposition, accepted_at
    ) values (
        v_package_id, v_source_schema, v_source_entity_id, v_source_version,
        v_source_language, v_target_language, v_translation_version,
        p_researcher_account_id, v_source_sha256, translation_data,
        v_provenance, 'accepted', v_accepted_at
    );

    for v_entry in
        select value
          from (
              select value
                from jsonb_each(translation_data -> 'questions')
               where v_source_schema = 'research_os.question_bank'
              union all
              select value
                from jsonb_array_elements(translation_data -> 'items')
               where v_source_schema = 'research_os.questionnaire'
          ) entries
    loop
        if v_source_schema = 'research_os.question_bank' then
            v_question_id := (v_entry ->> 'question_id')::uuid;
            v_question_version := (v_entry ->> 'version')::integer;
            v_definition := v_entry;
        else
            v_question_id := (v_entry ->> 'question_id')::uuid;
            v_question_version := (v_entry ->> 'question_version')::integer;
            v_definition := v_entry -> 'definition_snapshot';
        end if;
        if jsonb_typeof(v_definition) is distinct from 'object'
           or nullif(btrim(v_definition ->> 'prompt'), '') is null
           or not exists (
               select 1 from public.question_definitions qd
                where qd.question_id = v_question_id
                  and qd.version = v_question_version
           ) then
            raise exception 'Translated question identity or definition is invalid';
        end if;
        v_key := v_question_id::text || ':' || v_question_version::text;
        if v_seen ? v_key then
            if v_seen -> v_key is distinct from v_definition then
                raise exception 'Repeated questionnaire item has conflicting translations for question %', v_key;
            end if;
            continue;
        end if;
        v_seen := v_seen || jsonb_build_object(v_key, v_definition);
        perform pg_advisory_xact_lock(hashtextextended(
            p_researcher_account_id::text || ':' || v_key || ':' || lower(v_target_language),
            0
        ));
        select coalesce(max(qt.translation_version), 0) + 1
          into v_question_translation_version
          from public.question_translation_variants qt
         where qt.researcher_account_id = p_researcher_account_id
           and qt.question_id = v_question_id
           and qt.question_version = v_question_version
           and lower(qt.target_language) = lower(v_target_language);
        insert into public.question_translation_variants (
            translation_package_id, question_id, question_version,
            target_language, translation_version, researcher_account_id,
            translated_definition
        ) values (
            v_package_id, v_question_id, v_question_version,
            v_target_language, v_question_translation_version, p_researcher_account_id,
            v_definition
        );
        v_saved := v_saved + 1;
    end loop;
    if v_saved = 0 then
        raise exception 'Translation package contains no questions';
    end if;

    return jsonb_build_object(
        'translation_package_id', v_package_id,
        'translation_version', v_translation_version,
        'target_language', v_target_language,
        'saved_question_count', v_saved
    );
end;
$$;

create or replace function public.load_question_translation_variants(
    p_researcher_account_id uuid,
    p_target_language text,
    p_question_references jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with requested as (
        select (value ->> 'question_id')::uuid as question_id,
               (value ->> 'question_version')::integer as question_version
          from jsonb_array_elements(p_question_references)
    ), latest as (
        select distinct on (qt.question_id, qt.question_version)
               qt.question_id, qt.question_version, qt.translation_version,
               qt.translated_definition, qt.translation_package_id,
               tp.source_primary_language, tp.target_language,
               tp.source_sha256, tp.accepted_at, tp.translation_provenance
          from public.question_translation_variants qt
          join requested r
            on r.question_id = qt.question_id
           and r.question_version = qt.question_version
          join public.question_translation_packages tp
            on tp.translation_package_id = qt.translation_package_id
         where qt.researcher_account_id = p_researcher_account_id
           and lower(qt.target_language) = lower(p_target_language)
         order by qt.question_id, qt.question_version, qt.translation_version desc
    )
    select coalesce(jsonb_object_agg(
        latest.question_id::text || ':' || latest.question_version::text,
        jsonb_build_object(
            'translated_definition', latest.translated_definition,
            'translation_reference', jsonb_build_object(
                'translation_package_id', latest.translation_package_id,
                'translation_version', latest.translation_version,
                'source_primary_language', latest.source_primary_language,
                'target_language', latest.target_language,
                'source_sha256', latest.source_sha256,
                'accepted_at', latest.accepted_at,
                'human_disposition', 'accepted'
            )
        )
    ), '{}'::jsonb)
      from latest;
$$;

create or replace function public.load_question_definitions_for_translation(
    p_question_references jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with requested as (
        select (value ->> 'question_id')::uuid as question_id,
               (value ->> 'question_version')::integer as question_version
          from jsonb_array_elements(p_question_references)
    )
    select coalesce(jsonb_object_agg(
        qd.question_id::text || ':' || qd.version::text,
        qd.definition
    ), '{}'::jsonb)
      from public.question_definitions qd
      join requested r
        on r.question_id = qd.question_id
       and r.question_version = qd.version;
$$;

revoke all on function public.save_accepted_question_translation_package(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_translation_variants(uuid, text, jsonb)
    from public, anon, authenticated;
revoke all on function public.load_question_definitions_for_translation(jsonb)
    from public, anon, authenticated;
grant execute on function public.save_accepted_question_translation_package(jsonb, uuid)
    to service_role;
grant execute on function public.load_question_translation_variants(uuid, text, jsonb)
    to service_role;
grant execute on function public.load_question_definitions_for_translation(jsonb)
    to service_role;

commit;
