-- Research OS study catalog visibility v1.
-- Apply after research_study_contract_v1.sql.
--
-- Visibility is administrative metadata on the study identity, not part of the
-- scientific version. Existing identities default to existence_only so this
-- migration never makes previously private protocols discoverable.

begin;

alter table public.research_os_entity_ownership
    add column if not exists catalog_visibility text not null
        default 'existence_only';

alter table public.research_os_entity_ownership
    drop constraint if exists research_os_entity_ownership_catalog_visibility_check;
alter table public.research_os_entity_ownership
    add constraint research_os_entity_ownership_catalog_visibility_check
    check (catalog_visibility in ('listed', 'existence_only'));

grant select, insert, update on public.research_os_entity_ownership to service_role;

create or replace function public.save_owned_study_package_with_visibility(
    study_data jsonb,
    p_researcher_account_id uuid,
    p_catalog_visibility text default 'existence_only'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_result jsonb;
    v_study_id uuid;
begin
    if p_catalog_visibility not in ('listed', 'existence_only') then
        raise exception 'Study catalog visibility must be listed or existence_only';
    end if;

    v_study_id := (study_data ->> 'study_id')::uuid;
    v_result := public.save_owned_study_package(
        study_data,
        p_researcher_account_id
    );

    update public.research_os_entity_ownership
       set catalog_visibility = p_catalog_visibility
     where entity_type = 'study'
       and entity_id = v_study_id
       and researcher_account_id = p_researcher_account_id;
    if not found then
        raise exception 'Study identity belongs to another researcher';
    end if;

    return v_result || jsonb_build_object(
        'catalog_visibility', p_catalog_visibility
    );
end;
$$;

create or replace function public.set_owned_study_catalog_visibility(
    p_study_id uuid,
    p_researcher_account_id uuid,
    p_catalog_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_catalog_visibility not in ('listed', 'existence_only') then
        raise exception 'Study catalog visibility must be listed or existence_only';
    end if;

    update public.research_os_entity_ownership
       set catalog_visibility = p_catalog_visibility
     where entity_type = 'study'
       and entity_id = p_study_id
       and researcher_account_id = p_researcher_account_id;
    if not found then
        raise exception 'Study identity is not owned by this researcher';
    end if;

    return jsonb_build_object(
        'study_id', p_study_id,
        'catalog_visibility', p_catalog_visibility
    );
end;
$$;

drop function if exists public.list_studies_for_account(uuid, text);
create function public.list_studies_for_account(
    p_researcher_account_id uuid,
    requested_status text default 'all'
)
returns table (
    study_id uuid, version integer, code text, title text, status text,
    collection_mode text, longitudinal_linkage text,
    group_count bigint, timepoint_count bigint, assignment_count bigint,
    global_time_reference timestamptz, updated_at timestamptz,
    owned_by_current_account boolean, catalog_visibility text,
    content_visible boolean, public_summary jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with owned_rows as (
        select s.study_id, s.version, s.code, s.title, s.status,
               s.collection_mode, s.longitudinal_linkage,
               (select count(*) from public.research_study_groups g
                 where g.study_id = s.study_id and g.study_version = s.version) as group_count,
               (select count(*) from public.research_study_timepoints t
                 where t.study_id = s.study_id and t.study_version = s.version) as timepoint_count,
               (select count(*) from public.research_study_questionnaire_assignments a
                 where a.study_id = s.study_id and a.study_version = s.version) as assignment_count,
               s.global_time_reference, s.updated_at,
               true as owned_by_current_account,
               o.catalog_visibility,
               true as content_visible,
               null::jsonb as public_summary
          from public.research_studies s
          join public.research_os_entity_ownership o
            on o.entity_type = 'study' and o.entity_id = s.study_id
           and o.researcher_account_id = p_researcher_account_id
         where requested_status = 'all' or s.status = requested_status
    ), shared_latest as (
        select distinct on (s.study_id)
               s.*, o.catalog_visibility
          from public.research_studies s
          join public.research_os_entity_ownership o
            on o.entity_type = 'study' and o.entity_id = s.study_id
           and o.researcher_account_id <> p_researcher_account_id
         where s.status = 'active'
           and requested_status in ('all', 'active')
         order by s.study_id, s.version desc
    ), shared_rows as (
        select case when s.catalog_visibility = 'listed' then s.study_id else null::uuid end,
               case when s.catalog_visibility = 'listed' then s.version else null::integer end,
               case when s.catalog_visibility = 'listed' then s.code else null::text end,
               case when s.catalog_visibility = 'listed' then s.title else null::text end,
               'active'::text,
               case when s.catalog_visibility = 'listed' then s.collection_mode else null::text end,
               case when s.catalog_visibility = 'listed' then s.longitudinal_linkage else null::text end,
               null::bigint, null::bigint, null::bigint,
               null::timestamptz, null::timestamptz,
               false,
               s.catalog_visibility,
               s.catalog_visibility = 'listed',
               case when s.catalog_visibility = 'listed' then
                   jsonb_build_object(
                       'description', s.description,
                       'primary_language', s.primary_language,
                       'design_type', s.package_data #>> '{study_design,design_type}',
                       'objective', s.package_data #>> '{study_design,objective}',
                       'research_questions', coalesce(
                           s.package_data #> '{study_design,research_questions}',
                           '[]'::jsonb
                       ),
                       'hypotheses', coalesce(
                           s.package_data #> '{study_design,hypotheses}',
                           '[]'::jsonb
                       )
                   )
               else null::jsonb end
          from shared_latest s
    )
    select * from owned_rows
    union all
    select * from shared_rows
    order by owned_by_current_account desc, updated_at desc nulls last,
             title nulls last, version desc nulls last;
$$;

revoke all on function public.save_owned_study_package_with_visibility(jsonb, uuid, text)
    from public, anon, authenticated;
revoke all on function public.set_owned_study_catalog_visibility(uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.list_studies_for_account(uuid, text)
    from public, anon, authenticated;
grant execute on function public.save_owned_study_package_with_visibility(jsonb, uuid, text)
    to service_role;
grant execute on function public.set_owned_study_catalog_visibility(uuid, uuid, text)
    to service_role;
grant execute on function public.list_studies_for_account(uuid, text)
    to service_role;

commit;
