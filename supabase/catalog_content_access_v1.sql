-- Research OS catalog discovery and content-access contract v1.
-- Apply after study_catalog_visibility_v1.sql.
--
-- Every active bank and questionnaire remains discoverable to researchers by
-- metadata. Reading scientific content is a separate owner-controlled right;
-- question-bank reuse permission remains an independent third decision.

begin;

alter table public.research_os_entity_ownership
    add column if not exists content_visibility text not null default 'metadata_only',
    add column if not exists owner_identifier_snapshot text;

alter table public.research_os_entity_ownership
    drop constraint if exists research_os_entity_ownership_content_visibility_check;
alter table public.research_os_entity_ownership
    add constraint research_os_entity_ownership_content_visibility_check
    check (content_visibility in ('metadata_only', 'content_visible'));

update public.research_os_entity_ownership o
   set owner_identifier_snapshot = a.user_identifier
  from public.research_os_accounts a
 where a.account_id = o.researcher_account_id
   and o.owner_identifier_snapshot is null;

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
    v_owner_identifier text;
begin
    select a.user_identifier into v_owner_identifier
      from public.research_os_accounts a
     where a.account_id = p_researcher_account_id
       and a.role = 'researcher'
       and a.status = 'active';
    if v_owner_identifier is null then
        raise exception 'An active researcher account is required';
    end if;

    insert into public.research_os_entity_ownership (
        entity_type, entity_id, researcher_account_id, owner_identifier_snapshot
    ) values (
        p_entity_type, p_entity_id, p_researcher_account_id, v_owner_identifier
    )
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

create or replace function public.set_owned_entity_content_visibility(
    p_entity_type text,
    p_entity_id uuid,
    p_researcher_account_id uuid,
    p_content_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_entity_type not in ('question_bank', 'questionnaire') then
        raise exception 'Content visibility is supported for question banks and questionnaires';
    end if;
    if p_content_visibility not in ('metadata_only', 'content_visible') then
        raise exception 'Content visibility must be metadata_only or content_visible';
    end if;

    update public.research_os_entity_ownership
       set content_visibility = p_content_visibility
     where entity_type = p_entity_type
       and entity_id = p_entity_id
       and researcher_account_id = p_researcher_account_id;
    if not found then
        raise exception 'Entity is not owned by this researcher';
    end if;

    return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'content_visibility', p_content_visibility
    );
end;
$$;

create or replace function public.list_question_banks_for_account(
    p_researcher_account_id uuid
)
returns table (
    bank_id uuid, version integer, code text, title text, status text,
    primary_language text, question_count bigint, reuse_permission text,
    global_time_reference timestamptz, updated_at timestamptz,
    owned_by_current_account boolean, content_visibility text,
    content_visible boolean, owner_identifier text
)
language sql stable security definer set search_path = public, pg_temp
as $$
    with owned as (
        select qb.*, o.content_visibility, o.owner_identifier_snapshot
          from public.question_banks qb
          join public.research_os_entity_ownership o
            on o.entity_type = 'question_bank' and o.entity_id = qb.bank_id
           and o.researcher_account_id = p_researcher_account_id
         where p_researcher_account_id is not null
    ), shared as (
        select distinct on (qb.bank_id)
               qb.*, o.content_visibility, o.owner_identifier_snapshot
          from public.question_banks qb
          join public.research_os_entity_ownership o
            on o.entity_type = 'question_bank' and o.entity_id = qb.bank_id
           and (p_researcher_account_id is null
                or o.researcher_account_id <> p_researcher_account_id)
         where qb.status = 'active'
           and (p_researcher_account_id is not null
                or o.content_visibility = 'content_visible')
         order by qb.bank_id, qb.version desc
    )
    select b.bank_id, b.version, b.code, b.title, b.status,
           b.primary_language,
           (select count(*) from public.question_bank_items i
             where i.bank_id = b.bank_id and i.bank_version = b.version),
           coalesce(b.package_data #>> '{reuse_policy,permission}', 'attribution_permitted'),
           b.global_time_reference, b.updated_at, true,
           b.content_visibility, true, b.owner_identifier_snapshot
      from owned b
    union all
    select b.bank_id, b.version, b.code, b.title, b.status,
           b.primary_language,
           (select count(*) from public.question_bank_items i
             where i.bank_id = b.bank_id and i.bank_version = b.version),
           coalesce(b.package_data #>> '{reuse_policy,permission}', 'attribution_permitted'),
           b.global_time_reference, b.updated_at, false,
           b.content_visibility, b.content_visibility = 'content_visible',
           b.owner_identifier_snapshot
      from shared b
    order by owned_by_current_account desc, title, version desc;
$$;

create or replace function public.list_questionnaires_for_account(
    p_researcher_account_id uuid,
    requested_status text default 'all'
)
returns table (
    questionnaire_id uuid, version integer, code text, title text, status text,
    primary_language text, item_count bigint,
    global_time_reference timestamptz, updated_at timestamptz,
    owned_by_current_account boolean, content_visibility text,
    content_visible boolean, owner_identifier text
)
language sql stable security definer set search_path = public, pg_temp
as $$
    with owned as (
        select q.*, o.content_visibility, o.owner_identifier_snapshot
          from public.questionnaires q
          join public.research_os_entity_ownership o
            on o.entity_type = 'questionnaire' and o.entity_id = q.questionnaire_id
           and o.researcher_account_id = p_researcher_account_id
         where p_researcher_account_id is not null
           and (requested_status = 'all' or q.status = requested_status)
    ), shared as (
        select distinct on (q.questionnaire_id)
               q.*, o.content_visibility, o.owner_identifier_snapshot
          from public.questionnaires q
          join public.research_os_entity_ownership o
            on o.entity_type = 'questionnaire' and o.entity_id = q.questionnaire_id
           and (p_researcher_account_id is null
                or o.researcher_account_id <> p_researcher_account_id)
         where q.status = 'active' and requested_status in ('all', 'active')
           and (p_researcher_account_id is not null
                or o.content_visibility = 'content_visible')
         order by q.questionnaire_id, q.version desc
    )
    select q.questionnaire_id, q.version, q.code, q.title, q.status,
           q.primary_language,
           (select count(*) from public.questionnaire_items i
             where i.questionnaire_id = q.questionnaire_id
               and i.questionnaire_version = q.version),
           q.global_time_reference, q.updated_at, true,
           q.content_visibility, true, q.owner_identifier_snapshot
      from owned q
    union all
    select q.questionnaire_id, q.version, q.code, q.title, q.status,
           q.primary_language,
           (select count(*) from public.questionnaire_items i
             where i.questionnaire_id = q.questionnaire_id
               and i.questionnaire_version = q.version),
           q.global_time_reference, q.updated_at, false,
           q.content_visibility, q.content_visibility = 'content_visible',
           q.owner_identifier_snapshot
      from shared q
    order by owned_by_current_account desc, title, version desc;
$$;

create or replace function public.load_questionnaire_package_for_account(
    questionnaire_reference text,
    requested_version integer,
    p_researcher_account_id uuid
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select q.package_data
      from public.questionnaires q
      join public.research_os_entity_ownership o
        on o.entity_type = 'questionnaire' and o.entity_id = q.questionnaire_id
     where (q.code = upper(questionnaire_reference)
            or (questionnaire_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and q.questionnaire_id = questionnaire_reference::uuid))
       and q.version = requested_version
       and (o.researcher_account_id = p_researcher_account_id
            or (q.status = 'active' and o.content_visibility = 'content_visible'))
     limit 1;
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
      join public.research_os_entity_ownership o
        on o.entity_type = 'question_bank' and o.entity_id = qb.bank_id
     where (qb.code = upper(bank_reference)
            or (bank_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and qb.bank_id = bank_reference::uuid))
       and qb.version = requested_version
       and (o.researcher_account_id = p_researcher_account_id
            or (qb.status = 'active' and o.content_visibility = 'content_visible'))
     limit 1;
$$;

create or replace function public.load_shared_questionnaire_package(
    questionnaire_reference text,
    requested_version integer
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select q.package_data
      from public.questionnaires q
      join public.research_os_entity_ownership o
        on o.entity_type = 'questionnaire' and o.entity_id = q.questionnaire_id
     where (q.code = upper(questionnaire_reference)
            or (questionnaire_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and q.questionnaire_id = questionnaire_reference::uuid))
       and q.version = requested_version
       and q.status = 'active'
       and o.content_visibility = 'content_visible'
     limit 1;
$$;

create or replace function public.load_shared_question_bank_package(
    bank_reference text,
    requested_version integer
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select qb.package_data
      from public.question_banks qb
      join public.research_os_entity_ownership o
        on o.entity_type = 'question_bank' and o.entity_id = qb.bank_id
     where (qb.code = upper(bank_reference)
            or (bank_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and qb.bank_id = bank_reference::uuid))
       and qb.version = requested_version
       and qb.status = 'active'
       and o.content_visibility = 'content_visible'
     limit 1;
$$;

revoke all on function public.set_owned_entity_content_visibility(text, uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.list_question_banks_for_account(uuid)
    from public, anon, authenticated;
revoke all on function public.list_questionnaires_for_account(uuid, text)
    from public, anon, authenticated;
revoke all on function public.load_questionnaire_package_for_account(text, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.load_question_bank_package_for_account(text, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.load_shared_questionnaire_package(text, integer)
    from public, anon, authenticated;
revoke all on function public.load_shared_question_bank_package(text, integer)
    from public, anon, authenticated;
grant execute on function public.set_owned_entity_content_visibility(text, uuid, uuid, text)
    to service_role;
grant execute on function public.list_question_banks_for_account(uuid) to service_role;
grant execute on function public.list_questionnaires_for_account(uuid, text) to service_role;
grant execute on function public.load_questionnaire_package_for_account(text, integer, uuid)
    to service_role;
grant execute on function public.load_question_bank_package_for_account(text, integer, uuid)
    to service_role;
grant execute on function public.load_shared_questionnaire_package(text, integer) to service_role;
grant execute on function public.load_shared_question_bank_package(text, integer) to service_role;

commit;
