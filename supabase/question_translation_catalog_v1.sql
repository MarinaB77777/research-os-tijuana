-- Research OS accepted translation discovery/catalog v1.
-- Apply after question_translation_variants_v1.sql.
-- This migration is read-only with respect to saved scientific objects: it
-- exposes researcher-scoped packages and only complete language variants.

begin;

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
               tp.accepted_at, tp.created_at,
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
         group by qb.bank_id, qb.version, qt.target_language
        having count(distinct (qt.question_id, qt.question_version)) =
               count(distinct (qbi.question_id, qbi.question_version))
    ), questionnaire_language_rows as (
        select q.questionnaire_id as source_entity_id, q.version as source_version,
               q.primary_language as language, true as is_source,
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
                'coverage_complete', pr.expected_question_count > 0 and
                    pr.expected_question_count = pr.translated_question_count,
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
     order by tp.translation_version desc, tp.created_at desc
     limit 1;
$$;

revoke all on function public.list_question_translation_catalog(uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_translation_document(uuid, text, uuid, integer, text)
    from public, anon, authenticated;
grant execute on function public.list_question_translation_catalog(uuid)
    to service_role;
grant execute on function public.load_question_translation_document(uuid, text, uuid, integer, text)
    to service_role;

commit;
