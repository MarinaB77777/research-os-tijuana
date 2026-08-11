-- Research OS unified question/questionnaire catalog management v1.
-- Apply after question_translation_exact_loading_v3.sql and research_study_contract_v1.sql.
-- Scientific records are never silently removed. Archive is a reversible catalog
-- visibility action; physical deletion is limited to unused draft objects.

begin;

create extension if not exists pgcrypto;

create table if not exists public.research_catalog_archives (
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    entity_type text not null check (entity_type in (
        'question_bank', 'question', 'questionnaire',
        'translation_package', 'translation_draft'
    )),
    entity_id uuid not null,
    entity_version integer not null default 0 check (entity_version >= 0),
    archived_at timestamptz not null default clock_timestamp(),
    primary key (researcher_account_id, entity_type, entity_id, entity_version)
);

create table if not exists public.research_catalog_action_log (
    action_id uuid primary key default gen_random_uuid(),
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    entity_type text not null,
    entity_id uuid not null,
    entity_version integer not null default 0,
    action text not null check (action in ('archive', 'restore', 'delete')),
    result text not null check (result in ('completed', 'blocked')),
    dependency_snapshot jsonb not null,
    created_at timestamptz not null default clock_timestamp()
);

alter table public.research_catalog_archives enable row level security;
alter table public.research_catalog_action_log enable row level security;
revoke all on public.research_catalog_archives from public, anon, authenticated;
revoke all on public.research_catalog_action_log from public, anon, authenticated;
grant select, insert, update, delete on public.research_catalog_archives to service_role;
grant select, insert on public.research_catalog_action_log to service_role;

create or replace function public.list_research_catalog(
    p_researcher_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with owned_banks as (
        select qb.*, p_researcher_account_id as researcher_account_id
          from public.question_banks qb
          join public.research_os_entity_ownership o
            on o.entity_type = 'question_bank'
           and o.entity_id = qb.bank_id
           and o.researcher_account_id = p_researcher_account_id
    ), owned_questionnaires as (
        select q.*, p_researcher_account_id as researcher_account_id
          from public.questionnaires q
          join public.research_os_entity_ownership o
            on o.entity_type = 'questionnaire'
           and o.entity_id = q.questionnaire_id
           and o.researcher_account_id = p_researcher_account_id
    ), owned_questions as (
        select distinct qd.*, p_researcher_account_id as researcher_account_id
          from public.question_definitions qd
          join public.question_bank_items qbi
            on qbi.question_id = qd.question_id
           and qbi.question_version = qd.version
          join owned_banks ob
            on ob.bank_id = qbi.bank_id and ob.version = qbi.bank_version
        union
        select distinct qd.*, p_researcher_account_id as researcher_account_id
          from public.question_definitions qd
          join public.questionnaire_items qi
            on qi.question_id = qd.question_id
           and qi.question_version = qd.version
          join owned_questionnaires oq
            on oq.questionnaire_id = qi.questionnaire_id
           and oq.version = qi.questionnaire_version
    ), bank_rows as (
        select ob.bank_id, ob.version, ob.code, ob.title, ob.status,
               ob.researcher_account_id,
               ob.primary_language, ob.created_at, ob.updated_at,
               exists (
                   select 1 from public.research_catalog_archives a
                    where a.researcher_account_id = p_researcher_account_id
                      and a.entity_type = 'question_bank'
                      and a.entity_id = ob.bank_id and a.entity_version = ob.version
               ) as archived,
               (select a.archived_at from public.research_catalog_archives a
                 where a.researcher_account_id = p_researcher_account_id
                   and a.entity_type = 'question_bank'
                   and a.entity_id = ob.bank_id and a.entity_version = ob.version) as archived_at,
               (select count(*)::integer from public.question_bank_items i
                 where i.bank_id = ob.bank_id and i.bank_version = ob.version) as question_count,
               (select count(*)::integer from public.questionnaire_items i
                 where i.source_bank_id = ob.bank_id and i.source_bank_version = ob.version) as questionnaire_use_count,
               (select count(*)::integer from public.research_response_records r
                 where r.bank_id = ob.bank_id and r.bank_version = ob.version) as response_count,
               (select count(*)::integer from public.parameter_definitions p
                 where p.definition::text like '%' || ob.bank_id::text || '%') as parameter_reference_count,
               (select count(*)::integer from public.question_translation_packages p
                 where p.researcher_account_id = p_researcher_account_id
                   and p.source_schema = 'research_os.question_bank'
                   and p.source_entity_id = ob.bank_id and p.source_version = ob.version) as translation_package_count,
               (select count(*)::integer from public.question_translation_drafts d
                 where d.researcher_account_id = p_researcher_account_id
                   and d.source_schema = 'research_os.question_bank'
                   and d.source_entity_id = ob.bank_id and d.source_version = ob.version) as translation_draft_count
          from owned_banks ob
    ), question_rows as (
        select oq.question_id, oq.version, oq.code, oq.prompt, oq.question_type,
               oq.researcher_account_id,
               oq.status, oq.created_at, oq.updated_at,
               exists (
                   select 1 from public.research_catalog_archives a
                    where a.researcher_account_id = p_researcher_account_id
                      and a.entity_type = 'question'
                      and a.entity_id = oq.question_id and a.entity_version = oq.version
               ) as archived,
               (select a.archived_at from public.research_catalog_archives a
                 where a.researcher_account_id = p_researcher_account_id
                   and a.entity_type = 'question'
                   and a.entity_id = oq.question_id and a.entity_version = oq.version) as archived_at,
               (select count(*)::integer from public.question_bank_items i
                 where i.question_id = oq.question_id and i.question_version = oq.version) as bank_use_count,
               (select count(*)::integer from public.questionnaire_items i
                 where i.question_id = oq.question_id and i.question_version = oq.version) as questionnaire_use_count,
               (select count(*)::integer from public.research_response_records r
                 where r.question_id = oq.question_id and r.question_version = oq.version) as response_count,
               (select count(*)::integer from public.question_translation_variants v
                 where v.researcher_account_id = p_researcher_account_id
                   and v.question_id = oq.question_id and v.question_version = oq.version) as translation_variant_count,
               (select count(*)::integer from public.parameter_definitions p
                 where p.definition::text like '%' || oq.question_id::text || '%') as parameter_reference_count,
               coalesce((select jsonb_agg(distinct b.primary_language)
                 from public.question_bank_items i
                 join public.question_banks b on b.bank_id = i.bank_id and b.version = i.bank_version
                where i.question_id = oq.question_id and i.question_version = oq.version), '[]'::jsonb) as source_languages,
               coalesce((select jsonb_agg(distinct v.target_language)
                 from public.question_translation_variants v
                where v.researcher_account_id = p_researcher_account_id
                  and v.question_id = oq.question_id and v.question_version = oq.version), '[]'::jsonb) as translation_languages,
               coalesce((select jsonb_agg(jsonb_build_object(
                   'bank_id', i.bank_id, 'bank_version', i.bank_version,
                   'position', i.position, 'title', b.title, 'code', b.code
               ) order by b.title, i.bank_version, i.position)
                 from public.question_bank_items i
                 join public.question_banks b on b.bank_id = i.bank_id and b.version = i.bank_version
                where i.question_id = oq.question_id and i.question_version = oq.version), '[]'::jsonb) as banks
          from owned_questions oq
    ), questionnaire_rows as (
        select oq.questionnaire_id, oq.version, oq.code, oq.title, oq.description,
               oq.researcher_account_id,
               oq.status, oq.primary_language, oq.created_at, oq.updated_at,
               exists (
                   select 1 from public.research_catalog_archives a
                    where a.researcher_account_id = p_researcher_account_id
                      and a.entity_type = 'questionnaire'
                      and a.entity_id = oq.questionnaire_id and a.entity_version = oq.version
               ) as archived,
               (select a.archived_at from public.research_catalog_archives a
                 where a.researcher_account_id = p_researcher_account_id
                   and a.entity_type = 'questionnaire'
                   and a.entity_id = oq.questionnaire_id and a.entity_version = oq.version) as archived_at,
               (select count(*)::integer from public.questionnaire_items i
                 where i.questionnaire_id = oq.questionnaire_id and i.questionnaire_version = oq.version) as question_count,
               (select count(*)::integer from public.research_study_questionnaire_assignments a
                 where a.questionnaire_id = oq.questionnaire_id and a.questionnaire_version = oq.version) as study_use_count,
               (select count(*)::integer from public.research_os_collection_sessions s
                 where s.questionnaire_id = oq.questionnaire_id and s.questionnaire_version = oq.version) as session_count,
               (select count(*)::integer from public.consent_acceptances c
                 where c.questionnaire_id = oq.questionnaire_id and c.questionnaire_version = oq.version) as consent_acceptance_count,
               (select count(*)::integer from public.question_translation_packages p
                 where p.researcher_account_id = p_researcher_account_id
                   and p.source_schema = 'research_os.questionnaire'
                   and p.source_entity_id = oq.questionnaire_id and p.source_version = oq.version) as translation_package_count,
               (select count(*)::integer from public.question_translation_drafts d
                 where d.researcher_account_id = p_researcher_account_id
                   and d.source_schema = 'research_os.questionnaire'
                   and d.source_entity_id = oq.questionnaire_id and d.source_version = oq.version) as translation_draft_count
          from owned_questionnaires oq
    ), package_rows as (
        select p.translation_package_id, p.source_schema, p.source_entity_id,
               p.source_version, p.source_primary_language, p.target_language,
               p.translation_version, p.human_disposition, p.verification_status,
               p.language_verification, p.source_sha256, p.researcher_account_id,
               p.accepted_at, p.created_at,
               coalesce(p.translated_document ->> 'title', p.translated_document ->> 'code') as translated_title,
               exists (
                   select 1 from public.research_catalog_archives a
                    where a.researcher_account_id = p_researcher_account_id
                      and a.entity_type = 'translation_package'
                      and a.entity_id = p.translation_package_id and a.entity_version = 0
               ) as archived,
               (select a.archived_at from public.research_catalog_archives a
                 where a.researcher_account_id = p_researcher_account_id
                   and a.entity_type = 'translation_package'
                   and a.entity_id = p.translation_package_id and a.entity_version = 0) as archived_at,
               (select count(*)::integer from public.question_translation_variants v
                 where v.translation_package_id = p.translation_package_id) as variant_count,
               case when p.source_schema = 'research_os.question_bank'
                    then (select b.title from public.question_banks b
                           where b.bank_id = p.source_entity_id and b.version = p.source_version)
                    else (select q.title from public.questionnaires q
                           where q.questionnaire_id = p.source_entity_id and q.version = p.source_version)
               end as source_title
          from public.question_translation_packages p
         where p.researcher_account_id = p_researcher_account_id
    ), draft_rows as (
        select d.draft_id, d.researcher_account_id, d.source_schema,
               d.source_entity_id, d.source_version, d.source_sha256,
               d.source_primary_language, d.target_language, d.provider, d.model,
               d.prompt_version, d.completed_field_count, d.total_field_count,
               d.status, d.last_error, d.created_at, d.updated_at,
               exists (
                   select 1 from public.research_catalog_archives a
                    where a.researcher_account_id = p_researcher_account_id
                      and a.entity_type = 'translation_draft'
                      and a.entity_id = d.draft_id and a.entity_version = 0
               ) as archived,
               (select a.archived_at from public.research_catalog_archives a
                 where a.researcher_account_id = p_researcher_account_id
                   and a.entity_type = 'translation_draft'
                   and a.entity_id = d.draft_id and a.entity_version = 0) as archived_at,
               case when d.source_schema = 'research_os.question_bank'
                    then (select b.title from public.question_banks b
                           where b.bank_id = d.source_entity_id and b.version = d.source_version)
                    else (select q.title from public.questionnaires q
                           where q.questionnaire_id = d.source_entity_id and q.version = d.source_version)
               end as source_title
          from public.question_translation_drafts d
         where d.researcher_account_id = p_researcher_account_id
    )
    select jsonb_build_object(
        'banks', coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at, b.bank_id, b.version) from bank_rows b), '[]'::jsonb),
        'questions', coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at, q.question_id, q.version) from question_rows q), '[]'::jsonb),
        'questionnaires', coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at, q.questionnaire_id, q.version) from questionnaire_rows q), '[]'::jsonb),
        'translation_packages', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at, p.translation_package_id) from package_rows p), '[]'::jsonb),
        'translation_drafts', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.draft_id) from draft_rows d), '[]'::jsonb)
    );
$$;

create or replace function public.manage_research_catalog_item(
    p_researcher_account_id uuid,
    p_entity_type text,
    p_entity_id uuid,
    p_entity_version integer,
    p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_version integer := coalesce(p_entity_version, 0);
    v_owned boolean := false;
    v_status text;
    v_dependencies jsonb := '{}'::jsonb;
    v_blocker_count integer := 0;
    v_delete_questions jsonb := '[]'::jsonb;
    v_question jsonb;
begin
    if p_entity_type not in ('question_bank', 'question', 'questionnaire', 'translation_package', 'translation_draft')
       or p_action not in ('archive', 'restore', 'delete', 'inspect') then
        raise exception 'Unsupported catalog entity or action';
    end if;

    if p_entity_type = 'question_bank' then
        select exists(select 1 from public.research_os_entity_ownership o
            where o.entity_type = 'question_bank' and o.entity_id = p_entity_id
              and o.researcher_account_id = p_researcher_account_id), qb.status
          into v_owned, v_status from public.question_banks qb
         where qb.bank_id = p_entity_id and qb.version = v_version;
    elsif p_entity_type = 'questionnaire' then
        select exists(select 1 from public.research_os_entity_ownership o
            where o.entity_type = 'questionnaire' and o.entity_id = p_entity_id
              and o.researcher_account_id = p_researcher_account_id), q.status
          into v_owned, v_status from public.questionnaires q
         where q.questionnaire_id = p_entity_id and q.version = v_version;
    elsif p_entity_type = 'question' then
        select exists(
            select 1 from public.question_bank_items i
            join public.research_os_entity_ownership o
              on o.entity_type = 'question_bank' and o.entity_id = i.bank_id
             and o.researcher_account_id = p_researcher_account_id
            where i.question_id = p_entity_id and i.question_version = v_version
            union all
            select 1 from public.questionnaire_items i
            join public.research_os_entity_ownership o
              on o.entity_type = 'questionnaire' and o.entity_id = i.questionnaire_id
             and o.researcher_account_id = p_researcher_account_id
            where i.question_id = p_entity_id and i.question_version = v_version
        ), q.status into v_owned, v_status
          from public.question_definitions q
         where q.question_id = p_entity_id and q.version = v_version;
    elsif p_entity_type = 'translation_package' then
        select true, 'accepted' into v_owned, v_status
          from public.question_translation_packages p
         where p.translation_package_id = p_entity_id
           and p.researcher_account_id = p_researcher_account_id;
        v_version := 0;
    else
        select true, d.status into v_owned, v_status
          from public.question_translation_drafts d
         where d.draft_id = p_entity_id
           and d.researcher_account_id = p_researcher_account_id;
        v_version := 0;
    end if;

    if not coalesce(v_owned, false) then
        raise exception 'Catalog entity does not exist or is not owned by this researcher';
    end if;

    if p_action = 'archive' then
        insert into public.research_catalog_archives(
            researcher_account_id, entity_type, entity_id, entity_version
        ) values (p_researcher_account_id, p_entity_type, p_entity_id, v_version)
        on conflict (researcher_account_id, entity_type, entity_id, entity_version)
        do update set archived_at = clock_timestamp();
        v_dependencies := jsonb_build_object('reversible', true, 'scientific_rows_deleted', 0);
    elsif p_action = 'restore' then
        delete from public.research_catalog_archives
         where researcher_account_id = p_researcher_account_id
           and entity_type = p_entity_type and entity_id = p_entity_id
           and entity_version = v_version;
        v_dependencies := jsonb_build_object('reversible', true, 'scientific_rows_deleted', 0);
    else
        if p_entity_type = 'translation_draft' then
            if p_action = 'delete' then
                delete from public.question_translation_drafts
                 where draft_id = p_entity_id and researcher_account_id = p_researcher_account_id;
            end if;
            v_dependencies := jsonb_build_object(
                'blocking', jsonb_build_object(),
                'included_children', jsonb_build_object('translation_draft', 1),
                'status', v_status
            );
        elsif p_entity_type = 'translation_package' then
            select jsonb_build_object(
                'blocking', jsonb_build_object(
                    'questionnaire_snapshots', (select count(*) from public.questionnaire_items i
                        where i.definition_snapshot #>> '{translation_reference,translation_package_id}' = p.translation_package_id::text),
                    'bank_package_snapshots', (select count(*) from public.question_banks b
                        where b.package_data::text like '%' || p.translation_package_id::text || '%'),
                    'questionnaire_package_snapshots', (select count(*) from public.questionnaires q
                        where q.package_data::text like '%' || p.translation_package_id::text || '%'),
                    'response_provenance', (select count(*) from public.research_response_records r
                        where r.source_identity::text like '%' || p.translation_package_id::text || '%')
                ),
                'included_children', jsonb_build_object(
                    'translation_variants', (select count(*) from public.question_translation_variants v where v.translation_package_id = p.translation_package_id)
                ),
                'status', p.verification_status
            ) into v_dependencies
              from public.question_translation_packages p where p.translation_package_id = p_entity_id;
            v_blocker_count := coalesce((v_dependencies #>> '{blocking,questionnaire_snapshots}')::integer, 0)
                + coalesce((v_dependencies #>> '{blocking,bank_package_snapshots}')::integer, 0)
                + coalesce((v_dependencies #>> '{blocking,questionnaire_package_snapshots}')::integer, 0)
                + coalesce((v_dependencies #>> '{blocking,response_provenance}')::integer, 0);
            if p_action = 'delete' and v_blocker_count = 0 then
                delete from public.question_translation_variants where translation_package_id = p_entity_id;
                delete from public.question_translation_packages where translation_package_id = p_entity_id and researcher_account_id = p_researcher_account_id;
            end if;
        elsif p_entity_type = 'question_bank' then
            select coalesce(jsonb_agg(jsonb_build_object(
                       'question_id', qd.question_id, 'question_version', qd.version
                   )), '[]'::jsonb)
              into v_delete_questions
              from public.question_bank_items current_item
              join public.question_definitions qd
                on qd.question_id = current_item.question_id
               and qd.version = current_item.question_version
             where current_item.bank_id = p_entity_id
               and current_item.bank_version = v_version
               and qd.status = 'draft'
               and not exists (
                   select 1 from public.question_bank_items other_item
                    where other_item.question_id = qd.question_id
                      and other_item.question_version = qd.version
                      and (other_item.bank_id, other_item.bank_version)
                          is distinct from (p_entity_id, v_version)
               )
               and not exists (select 1 from public.questionnaire_items i where i.question_id = qd.question_id and i.question_version = qd.version)
               and not exists (select 1 from public.research_response_records r where r.question_id = qd.question_id and r.question_version = qd.version)
               and not exists (select 1 from public.question_translation_variants t where t.question_id = qd.question_id and t.question_version = qd.version)
               and not exists (select 1 from public.parameter_definitions p where p.definition::text like '%' || qd.question_id::text || '%');
            v_dependencies := jsonb_build_object(
                'blocking', jsonb_build_object(
                    'questionnaire_items', (select count(*) from public.questionnaire_items i where i.source_bank_id = p_entity_id and i.source_bank_version = v_version),
                    'responses', (select count(*) from public.research_response_records r where r.bank_id = p_entity_id and r.bank_version = v_version),
                    'parameter_references', (select count(*) from public.parameter_definitions p where p.definition::text like '%' || p_entity_id::text || '%'),
                    'translation_packages', (select count(*) from public.question_translation_packages p where p.source_schema = 'research_os.question_bank' and p.source_entity_id = p_entity_id and p.source_version = v_version),
                    'translation_drafts', (select count(*) from public.question_translation_drafts d where d.source_schema = 'research_os.question_bank' and d.source_entity_id = p_entity_id and d.source_version = v_version),
                    'orphan_question_risk', (select count(*)
                        from public.question_bank_items current_item
                        join public.question_definitions qd
                          on qd.question_id = current_item.question_id
                         and qd.version = current_item.question_version
                       where current_item.bank_id = p_entity_id
                         and current_item.bank_version = v_version
                         and not exists (
                             select 1 from public.question_bank_items other_item
                              where other_item.question_id = qd.question_id
                                and other_item.question_version = qd.version
                                and (other_item.bank_id, other_item.bank_version)
                                    is distinct from (p_entity_id, v_version)
                         )
                         and not exists (select 1 from public.questionnaire_items i where i.question_id = qd.question_id and i.question_version = qd.version)
                         and not exists (
                             select 1 from jsonb_array_elements(v_delete_questions) candidate
                              where candidate ->> 'question_id' = qd.question_id::text
                                and (candidate ->> 'question_version')::integer = qd.version
                         ))
                ),
                'included_children', jsonb_build_object(
                    'bank_items', (select count(*) from public.question_bank_items i where i.bank_id = p_entity_id and i.bank_version = v_version),
                    'exclusive_draft_question_definitions', jsonb_array_length(v_delete_questions)
                ),
                'status', v_status
            );
            v_blocker_count := coalesce((v_dependencies #>> '{blocking,questionnaire_items}')::integer,0)+coalesce((v_dependencies #>> '{blocking,responses}')::integer,0)+coalesce((v_dependencies #>> '{blocking,parameter_references}')::integer,0)+coalesce((v_dependencies #>> '{blocking,translation_packages}')::integer,0)+coalesce((v_dependencies #>> '{blocking,translation_drafts}')::integer,0)+coalesce((v_dependencies #>> '{blocking,orphan_question_risk}')::integer,0)+case when v_status = 'draft' then 0 else 1 end;
            if p_action = 'delete' and v_blocker_count = 0 then
                delete from public.question_banks where bank_id = p_entity_id and version = v_version;
                for v_question in select value from jsonb_array_elements(v_delete_questions)
                loop
                    delete from public.question_definitions
                     where question_id = (v_question ->> 'question_id')::uuid
                       and version = (v_question ->> 'question_version')::integer;
                end loop;
                delete from public.research_os_entity_ownership o where o.entity_type = 'question_bank' and o.entity_id = p_entity_id and not exists (select 1 from public.question_banks b where b.bank_id = p_entity_id);
            end if;
        elsif p_entity_type = 'questionnaire' then
            v_dependencies := jsonb_build_object(
                'blocking', jsonb_build_object(
                    'study_assignments', (select count(*) from public.research_study_questionnaire_assignments a where a.questionnaire_id = p_entity_id and a.questionnaire_version = v_version),
                    'sessions', (select count(*) from public.research_os_collection_sessions s where s.questionnaire_id = p_entity_id and s.questionnaire_version = v_version),
                    'consent_acceptances', (select count(*) from public.consent_acceptances c where c.questionnaire_id = p_entity_id and c.questionnaire_version = v_version),
                    'translation_packages', (select count(*) from public.question_translation_packages p where p.source_schema = 'research_os.questionnaire' and p.source_entity_id = p_entity_id and p.source_version = v_version),
                    'translation_drafts', (select count(*) from public.question_translation_drafts d where d.source_schema = 'research_os.questionnaire' and d.source_entity_id = p_entity_id and d.source_version = v_version)
                ),
                'included_children', jsonb_build_object(
                    'questionnaire_items', (select count(*) from public.questionnaire_items i where i.questionnaire_id = p_entity_id and i.questionnaire_version = v_version),
                    'questionnaire_routes', (select count(*) from public.questionnaire_routes r where r.questionnaire_id = p_entity_id and r.questionnaire_version = v_version),
                    'consent_bindings', (select count(*) from public.questionnaire_consent_bindings b where b.questionnaire_id = p_entity_id and b.questionnaire_version = v_version)
                ),
                'status', v_status
            );
            v_blocker_count := coalesce((v_dependencies #>> '{blocking,study_assignments}')::integer,0)+coalesce((v_dependencies #>> '{blocking,sessions}')::integer,0)+coalesce((v_dependencies #>> '{blocking,consent_acceptances}')::integer,0)+coalesce((v_dependencies #>> '{blocking,translation_packages}')::integer,0)+coalesce((v_dependencies #>> '{blocking,translation_drafts}')::integer,0)+case when v_status = 'draft' then 0 else 1 end;
            if p_action = 'delete' and v_blocker_count = 0 then
                delete from public.questionnaires where questionnaire_id = p_entity_id and version = v_version;
                delete from public.research_os_entity_ownership o where o.entity_type = 'questionnaire' and o.entity_id = p_entity_id and not exists (select 1 from public.questionnaires q where q.questionnaire_id = p_entity_id);
            end if;
        else
            v_dependencies := jsonb_build_object(
                'blocking', jsonb_build_object(
                    'bank_items', (select count(*) from public.question_bank_items i where i.question_id = p_entity_id and i.question_version = v_version),
                    'questionnaire_items', (select count(*) from public.questionnaire_items i where i.question_id = p_entity_id and i.question_version = v_version),
                    'responses', (select count(*) from public.research_response_records r where r.question_id = p_entity_id and r.question_version = v_version),
                    'translation_variants', (select count(*) from public.question_translation_variants t where t.question_id = p_entity_id and t.question_version = v_version),
                    'parameter_references', (select count(*) from public.parameter_definitions p where p.definition::text like '%' || p_entity_id::text || '%')
                ),
                'included_children', jsonb_build_object(),
                'status', v_status
            );
            v_blocker_count := coalesce((v_dependencies #>> '{blocking,bank_items}')::integer,0)+coalesce((v_dependencies #>> '{blocking,questionnaire_items}')::integer,0)+coalesce((v_dependencies #>> '{blocking,responses}')::integer,0)+coalesce((v_dependencies #>> '{blocking,translation_variants}')::integer,0)+coalesce((v_dependencies #>> '{blocking,parameter_references}')::integer,0)+case when v_status = 'draft' then 0 else 1 end;
            if p_action = 'delete' and v_blocker_count = 0 then
                delete from public.question_definitions where question_id = p_entity_id and version = v_version;
            end if;
        end if;
    end if;

    if p_action = 'delete' and v_blocker_count = 0 then
        delete from public.research_catalog_archives
         where researcher_account_id = p_researcher_account_id
           and entity_type = p_entity_type and entity_id = p_entity_id
           and entity_version = v_version;
    end if;

    if p_action <> 'inspect' then
        insert into public.research_catalog_action_log(
            researcher_account_id, entity_type, entity_id, entity_version,
            action, result, dependency_snapshot
        ) values (
            p_researcher_account_id, p_entity_type, p_entity_id, v_version,
            p_action, case when p_action = 'delete' and v_blocker_count > 0 then 'blocked' else 'completed' end,
            v_dependencies
        );
    end if;

    return jsonb_build_object(
        'completed', p_action = 'inspect' or not (p_action = 'delete' and v_blocker_count > 0),
        'action', p_action, 'entity_type', p_entity_type,
        'entity_id', p_entity_id, 'entity_version', v_version,
        'dependencies', v_dependencies,
        'blocker_count', v_blocker_count
    );
end;
$$;

revoke all on function public.list_research_catalog(uuid) from public, anon, authenticated;
revoke all on function public.manage_research_catalog_item(uuid, text, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.list_research_catalog(uuid) to service_role;
grant execute on function public.manage_research_catalog_item(uuid, text, uuid, integer, text) to service_role;

commit;
