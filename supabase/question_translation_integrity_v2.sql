-- Research OS translation integrity and resumable drafts v2.
-- Apply after question_translation_catalog_v1.sql.
-- Existing accepted packages are retained but become Unverified until a new
-- server-verified translation version is saved. Only Verified packages may be
-- loaded into Question Banks or Questionnaires.

begin;

alter table public.question_translation_packages
    add column if not exists verification_status text not null default 'unverified'
        check (verification_status in ('unverified', 'verified', 'rejected')),
    add column if not exists language_verification jsonb;

update public.question_translation_packages
   set verification_status = 'unverified',
       language_verification = null
 where language_verification is null;

create or replace function public.require_verified_question_translation_package()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_verification jsonb := new.translation_provenance -> 'language_verification';
begin
    if v_verification ->> 'status' is distinct from 'verified'
       or v_verification ->> 'method' is distinct from 'research_os_language_evidence_v1'
       or v_verification ->> 'target_language' is distinct from new.target_language
       or nullif(v_verification ->> 'checked_at', '') is null then
        raise exception 'Server-verified target-language evidence is required';
    end if;
    new.verification_status := 'verified';
    new.language_verification := v_verification;
    return new;
end;
$$;

drop trigger if exists require_verified_question_translation_package
    on public.question_translation_packages;
create trigger require_verified_question_translation_package
before insert on public.question_translation_packages
for each row execute function public.require_verified_question_translation_package();

create table if not exists public.question_translation_drafts (
    draft_id uuid primary key default gen_random_uuid(),
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    source_schema text not null check (
        source_schema in ('research_os.question_bank', 'research_os.questionnaire')
    ),
    source_entity_id uuid not null,
    source_version integer not null check (source_version > 0),
    source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
    source_primary_language text not null check (length(btrim(source_primary_language)) > 0),
    target_language text not null check (length(btrim(target_language)) > 0),
    provider text not null check (length(btrim(provider)) > 0),
    model text not null check (length(btrim(model)) > 0),
    prompt_version text not null check (length(btrim(prompt_version)) > 0),
    translated_items jsonb not null default '[]'::jsonb
        check (jsonb_typeof(translated_items) = 'array'),
    completed_field_count integer not null default 0 check (completed_field_count >= 0),
    total_field_count integer not null check (total_field_count > 0),
    status text not null check (status in ('in_progress', 'paused', 'completed')),
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (
        researcher_account_id, source_sha256, target_language,
        prompt_version, provider, model
    )
);

create index if not exists question_translation_draft_resume_lookup
    on public.question_translation_drafts(
        researcher_account_id, source_sha256, target_language, updated_at desc
    );

alter table public.question_translation_drafts enable row level security;
revoke all on public.question_translation_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.question_translation_drafts to service_role;

create or replace function public.save_question_translation_draft(
    p_researcher_account_id uuid,
    p_draft jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.question_translation_drafts%rowtype;
begin
    if jsonb_typeof(p_draft) is distinct from 'object'
       or jsonb_typeof(p_draft -> 'translated_items') is distinct from 'array'
       or jsonb_array_length(p_draft -> 'translated_items') is distinct from
          (p_draft ->> 'completed_field_count')::integer then
        raise exception 'Translation draft progress is inconsistent';
    end if;
    insert into public.question_translation_drafts (
        researcher_account_id, source_schema, source_entity_id, source_version,
        source_sha256, source_primary_language, target_language,
        provider, model, prompt_version, translated_items,
        completed_field_count, total_field_count, status, last_error, updated_at
    ) values (
        p_researcher_account_id,
        p_draft ->> 'source_schema',
        (p_draft ->> 'source_entity_id')::uuid,
        (p_draft ->> 'source_version')::integer,
        lower(p_draft ->> 'source_sha256'),
        p_draft ->> 'source_primary_language',
        p_draft ->> 'target_language',
        p_draft ->> 'provider',
        p_draft ->> 'model',
        p_draft ->> 'prompt_version',
        p_draft -> 'translated_items',
        (p_draft ->> 'completed_field_count')::integer,
        (p_draft ->> 'total_field_count')::integer,
        p_draft ->> 'status',
        nullif(p_draft ->> 'last_error', ''),
        now()
    )
    on conflict (
        researcher_account_id, source_sha256, target_language,
        prompt_version, provider, model
    ) do update set
        translated_items = excluded.translated_items,
        completed_field_count = excluded.completed_field_count,
        total_field_count = excluded.total_field_count,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = now()
    returning * into v_row;
    return to_jsonb(v_row);
end;
$$;

create or replace function public.load_question_translation_draft(
    p_researcher_account_id uuid,
    p_source_sha256 text,
    p_target_language text,
    p_prompt_version text,
    p_provider text,
    p_model text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select to_jsonb(qtd)
      from public.question_translation_drafts qtd
     where qtd.researcher_account_id = p_researcher_account_id
       and qtd.source_sha256 = lower(p_source_sha256)
       and lower(qtd.target_language) = lower(p_target_language)
       and qtd.prompt_version = p_prompt_version
       and qtd.provider = p_provider
       and qtd.model = p_model
     limit 1;
$$;

create or replace function public.delete_question_translation_draft(
    p_researcher_account_id uuid,
    p_draft_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.question_translation_drafts
     where draft_id = p_draft_id
       and researcher_account_id = p_researcher_account_id;
    return found;
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
               tp.source_sha256, tp.accepted_at, tp.translation_provenance,
               tp.language_verification
          from public.question_translation_variants qt
          join requested r
            on r.question_id = qt.question_id
           and r.question_version = qt.question_version
          join public.question_translation_packages tp
            on tp.translation_package_id = qt.translation_package_id
           and tp.verification_status = 'verified'
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
                'human_disposition', 'accepted',
                'verification_status', 'verified',
                'language_verification', latest.language_verification
            )
        )
    ), '{}'::jsonb)
      from latest;
$$;

create or replace function public.list_question_translation_catalog(
    p_researcher_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with package_rows as (
        select tp.translation_package_id, tp.source_schema,
               tp.source_entity_id, tp.source_version,
               tp.source_primary_language, tp.target_language,
               tp.translation_version, tp.source_sha256,
               tp.accepted_at, tp.created_at, tp.verification_status,
               tp.language_verification,
               tp.translated_document ->> 'code' as source_code,
               tp.translated_document ->> 'title' as translated_title,
               case
                   when tp.source_schema = 'research_os.question_bank' then (
                       select count(*)::integer
                         from public.question_bank_items qbi
                        where qbi.bank_id = tp.source_entity_id
                          and qbi.bank_version = tp.source_version
                   )
                   else (
                       select count(distinct (qi.question_id, qi.question_version))::integer
                         from public.questionnaire_items qi
                        where qi.questionnaire_id = tp.source_entity_id
                          and qi.questionnaire_version = tp.source_version
                   )
               end as expected_question_count,
               (
                   select count(distinct (qt.question_id, qt.question_version))::integer
                     from public.question_translation_variants qt
                    where qt.translation_package_id = tp.translation_package_id
               ) as translated_question_count
          from public.question_translation_packages tp
         where tp.researcher_account_id = p_researcher_account_id
    ), bank_language_rows as (
        select qb.bank_id as source_entity_id, qb.version as source_version,
               qb.primary_language as language, true as is_source,
               true as coverage_complete, 'source'::text as verification_status,
               count(qbi.question_id)::integer as expected_question_count,
               count(qbi.question_id)::integer as translated_question_count,
               null::integer as latest_translation_version,
               null::timestamptz as latest_accepted_at
          from public.question_banks qb
          join public.question_bank_items qbi
            on qbi.bank_id = qb.bank_id and qbi.bank_version = qb.version
         group by qb.bank_id, qb.version, qb.primary_language
        union all
        select qb.bank_id, qb.version, qt.target_language, false,
               true, 'verified',
               count(distinct (qbi.question_id, qbi.question_version))::integer,
               count(distinct (qt.question_id, qt.question_version))::integer,
               max(qt.translation_version)::integer,
               max(tp.accepted_at)
          from public.question_banks qb
          join public.question_bank_items qbi
            on qbi.bank_id = qb.bank_id and qbi.bank_version = qb.version
          join public.question_translation_variants qt
            on qt.researcher_account_id = p_researcher_account_id
           and qt.question_id = qbi.question_id
           and qt.question_version = qbi.question_version
           and lower(qt.target_language) <> lower(qb.primary_language)
          join public.question_translation_packages tp
            on tp.translation_package_id = qt.translation_package_id
           and tp.verification_status = 'verified'
         group by qb.bank_id, qb.version, qt.target_language
        having count(distinct (qt.question_id, qt.question_version)) =
               count(distinct (qbi.question_id, qbi.question_version))
    ), questionnaire_language_rows as (
        select q.questionnaire_id as source_entity_id, q.version as source_version,
               q.primary_language as language, true as is_source,
               true as coverage_complete, 'source'::text as verification_status,
               count(distinct (qi.question_id, qi.question_version))::integer as expected_question_count,
               count(distinct (qi.question_id, qi.question_version))::integer as translated_question_count,
               null::integer as latest_translation_version,
               null::timestamptz as latest_accepted_at
          from public.questionnaires q
          join public.questionnaire_items qi
            on qi.questionnaire_id = q.questionnaire_id
           and qi.questionnaire_version = q.version
         group by q.questionnaire_id, q.version, q.primary_language
        union all
        select q.questionnaire_id, q.version, qt.target_language, false,
               true, 'verified',
               count(distinct (qi.question_id, qi.question_version))::integer,
               count(distinct (qt.question_id, qt.question_version))::integer,
               max(qt.translation_version)::integer,
               max(tp.accepted_at)
          from public.questionnaires q
          join public.questionnaire_items qi
            on qi.questionnaire_id = q.questionnaire_id
           and qi.questionnaire_version = q.version
          join public.question_translation_variants qt
            on qt.researcher_account_id = p_researcher_account_id
           and qt.question_id = qi.question_id
           and qt.question_version = qi.question_version
           and lower(qt.target_language) <> lower(q.primary_language)
          join public.question_translation_packages tp
            on tp.translation_package_id = qt.translation_package_id
           and tp.verification_status = 'verified'
         group by q.questionnaire_id, q.version, qt.target_language
        having count(distinct (qt.question_id, qt.question_version)) =
               count(distinct (qi.question_id, qi.question_version))
    )
    select jsonb_build_object(
        'packages', coalesce((
            select jsonb_agg(jsonb_build_object(
                'translation_package_id', pr.translation_package_id,
                'source_schema', pr.source_schema,
                'source_entity_id', pr.source_entity_id,
                'source_version', pr.source_version,
                'source_code', pr.source_code,
                'translated_title', pr.translated_title,
                'source_language', pr.source_primary_language,
                'target_language', pr.target_language,
                'translation_version', pr.translation_version,
                'expected_question_count', pr.expected_question_count,
                'translated_question_count', pr.translated_question_count,
                'coverage_complete', pr.verification_status = 'verified' and
                    pr.expected_question_count > 0 and
                    pr.expected_question_count = pr.translated_question_count,
                'verification_status', pr.verification_status,
                'language_verification', pr.language_verification,
                'source_sha256', pr.source_sha256,
                'accepted_at', pr.accepted_at,
                'created_at', pr.created_at
            ) order by pr.accepted_at desc, pr.created_at desc)
              from package_rows pr
        ), '[]'::jsonb),
        'bank_languages', coalesce((
            select jsonb_agg(to_jsonb(bl) order by bl.source_entity_id, bl.source_version, bl.is_source desc, bl.language)
              from bank_language_rows bl
        ), '[]'::jsonb),
        'questionnaire_languages', coalesce((
            select jsonb_agg(to_jsonb(ql) order by ql.source_entity_id, ql.source_version, ql.is_source desc, ql.language)
              from questionnaire_language_rows ql
        ), '[]'::jsonb)
    );
$$;

create or replace function public.load_question_translation_document(
    p_researcher_account_id uuid,
    p_source_schema text,
    p_source_entity_id uuid,
    p_source_version integer,
    p_target_language text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select tp.translated_document
      from public.question_translation_packages tp
     where tp.researcher_account_id = p_researcher_account_id
       and tp.source_schema = p_source_schema
       and tp.source_entity_id = p_source_entity_id
       and tp.source_version = p_source_version
       and lower(tp.target_language) = lower(p_target_language)
       and tp.verification_status = 'verified'
     order by tp.translation_version desc, tp.created_at desc
     limit 1;
$$;

revoke all on function public.save_question_translation_draft(uuid, jsonb)
    from public, anon, authenticated;
revoke all on function public.load_question_translation_draft(uuid, text, text, text, text, text)
    from public, anon, authenticated;
revoke all on function public.delete_question_translation_draft(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_translation_variants(uuid, text, jsonb)
    from public, anon, authenticated;
revoke all on function public.list_question_translation_catalog(uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_translation_document(uuid, text, uuid, integer, text)
    from public, anon, authenticated;

grant execute on function public.save_question_translation_draft(uuid, jsonb)
    to service_role;
grant execute on function public.load_question_translation_draft(uuid, text, text, text, text, text)
    to service_role;
grant execute on function public.delete_question_translation_draft(uuid, uuid)
    to service_role;
grant execute on function public.load_question_translation_variants(uuid, text, jsonb)
    to service_role;
grant execute on function public.list_question_translation_catalog(uuid)
    to service_role;
grant execute on function public.load_question_translation_document(uuid, text, uuid, integer, text)
    to service_role;

commit;
