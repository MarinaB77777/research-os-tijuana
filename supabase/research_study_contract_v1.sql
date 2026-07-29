-- Research OS study, cohort and longitudinal measurement contract v1.
-- Apply after public_respondent_registration_v1.sql.
--
-- A study is not a questionnaire. A timepoint is not a question-level `wave`.
-- Historical group membership is interval-bound, and every collection session
-- snapshots the exact study measurement that authorized it.

begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

alter table public.research_os_entity_ownership
    drop constraint if exists research_os_entity_ownership_entity_type_check;
alter table public.research_os_entity_ownership
    add constraint research_os_entity_ownership_entity_type_check
    check (entity_type in (
        'question_bank', 'parameter', 'questionnaire', 'consent_document', 'study'
    ));

create table if not exists public.research_studies (
    study_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    description text,
    status text not null check (status in ('draft', 'trial', 'active')),
    schema_version integer not null check (schema_version = 1),
    primary_language text not null,
    collection_mode text not null check (
        collection_mode in ('fixed_questionnaire_mode', 'adaptive_dialogue_mode')
    ),
    longitudinal_linkage text not null check (
        longitudinal_linkage in ('none', 'within_study_consent_bound')
    ),
    global_time_reference timestamptz not null,
    generated_at timestamptz not null,
    package_data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (study_id, version),
    unique (code, version)
);

create table if not exists public.research_study_groups (
    study_id uuid not null,
    study_version integer not null,
    group_id uuid not null,
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    description text,
    position integer not null check (position > 0),
    primary key (study_id, study_version, group_id),
    unique (study_id, study_version, code),
    unique (study_id, study_version, position),
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete cascade
);

create table if not exists public.research_study_timepoints (
    study_id uuid not null,
    study_version integer not null,
    timepoint_id uuid not null,
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    ordinal integer not null check (ordinal > 0),
    planned_offset interval,
    primary key (study_id, study_version, timepoint_id),
    unique (study_id, study_version, code),
    unique (study_id, study_version, ordinal),
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete cascade
);

-- Each group has one opaque public invitation identifier. The identifier is a
-- capability URL, not a respondent identity and not an enrollment record.
create table if not exists public.research_study_invitations (
    invitation_id uuid primary key,
    study_id uuid not null,
    study_version integer not null,
    group_id uuid not null,
    status text not null default 'open' check (status in ('open', 'closed')),
    created_at timestamptz not null default clock_timestamp(),
    closed_at timestamptz,
    unique (study_id, study_version, group_id),
    foreign key (study_id, study_version, group_id)
        references public.research_study_groups(study_id, study_version, group_id)
        on delete cascade,
    check (
        (status = 'open' and closed_at is null)
        or (status = 'closed' and closed_at is not null)
    )
);

create table if not exists public.research_study_questionnaire_assignments (
    assignment_id uuid primary key,
    study_id uuid not null,
    study_version integer not null,
    timepoint_id uuid not null,
    questionnaire_id uuid not null,
    questionnaire_version integer not null,
    position integer not null check (position > 0),
    required boolean not null default true,
    available_from timestamptz,
    available_until timestamptz,
    check (available_until is null or available_from is null or available_until > available_from),
    unique (assignment_id, study_id, study_version),
    unique (study_id, study_version, timepoint_id, position),
    unique (study_id, study_version, timepoint_id, questionnaire_id, questionnaire_version),
    foreign key (study_id, study_version, timepoint_id)
        references public.research_study_timepoints(study_id, study_version, timepoint_id)
        on delete cascade,
    foreign key (questionnaire_id, questionnaire_version)
        references public.questionnaires(questionnaire_id, version) on delete restrict
);

create table if not exists public.research_study_enrollments (
    enrollment_id uuid primary key,
    study_id uuid not null,
    study_version integer not null,
    respondent_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    participant_role text not null default 'participant'
        check (participant_role in ('participant', 'control', 'observer')),
    subject_link_id uuid,
    linkage_authorized boolean not null default false,
    linkage_authorized_at timestamptz,
    linkage_revoked_at timestamptz,
    status text not null default 'active'
        check (status in ('invited', 'active', 'completed', 'withdrawn', 'revoked')),
    enrolled_at timestamptz not null default clock_timestamp(),
    completed_at timestamptz,
    unique (study_id, study_version, respondent_account_id),
    unique (enrollment_id, study_id, study_version),
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete restrict,
    check (
        (linkage_authorized and subject_link_id is not null and linkage_authorized_at is not null
            and linkage_revoked_at is null)
        or
        (not linkage_authorized and subject_link_id is null)
    )
);

create table if not exists public.research_study_group_memberships (
    membership_id uuid primary key,
    enrollment_id uuid not null
        references public.research_study_enrollments(enrollment_id) on delete restrict,
    study_id uuid not null,
    study_version integer not null,
    group_id uuid not null,
    valid_from timestamptz not null,
    valid_until timestamptz,
    assigned_at timestamptz not null default clock_timestamp(),
    check (valid_until is null or valid_until > valid_from),
    foreign key (study_id, study_version, group_id)
        references public.research_study_groups(study_id, study_version, group_id)
        on delete restrict,
    foreign key (enrollment_id, study_id, study_version)
        references public.research_study_enrollments(
            enrollment_id, study_id, study_version
        ) on delete restrict
);

create unique index if not exists research_study_one_current_group
    on public.research_study_group_memberships(enrollment_id)
    where valid_until is null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conname = 'research_study_group_membership_no_overlap'
           and conrelid = 'public.research_study_group_memberships'::regclass
    ) then
        alter table public.research_study_group_memberships
            add constraint research_study_group_membership_no_overlap
            exclude using gist (
                enrollment_id with =,
                tstzrange(valid_from, valid_until, '[)') with &&
            );
    end if;
end;
$$;

create table if not exists public.research_participant_measurements (
    participant_measurement_id uuid primary key,
    enrollment_id uuid not null
        references public.research_study_enrollments(enrollment_id) on delete restrict,
    study_id uuid not null,
    study_version integer not null,
    assignment_id uuid not null
        references public.research_study_questionnaire_assignments(assignment_id)
        on delete restrict,
    status text not null default 'available'
        check (status in ('scheduled', 'available', 'in_progress', 'completed', 'missed', 'cancelled')),
    available_from timestamptz,
    available_until timestamptz,
    collection_session_id uuid,
    created_at timestamptz not null default clock_timestamp(),
    unique (enrollment_id, assignment_id),
    foreign key (enrollment_id, study_id, study_version)
        references public.research_study_enrollments(
            enrollment_id, study_id, study_version
        ) on delete restrict,
    foreign key (assignment_id, study_id, study_version)
        references public.research_study_questionnaire_assignments(
            assignment_id, study_id, study_version
        ) on delete restrict,
    check (available_until is null or available_from is null or available_until > available_from)
);

do $$
begin
    if exists (
        select 1
          from information_schema.columns
         where table_schema = 'public'
           and table_name = 'research_os_collection_sessions'
           and column_name = 'study_id'
           and data_type <> 'uuid'
    ) then
        alter table public.research_os_collection_sessions
            alter column study_id type uuid using study_id::uuid;
    end if;
end;
$$;

alter table public.research_os_collection_sessions
    add column if not exists study_version integer,
    add column if not exists enrollment_id uuid,
    add column if not exists participant_measurement_id uuid,
    add column if not exists study_questionnaire_assignment_id uuid,
    add column if not exists timepoint_id uuid,
    add column if not exists timepoint_code text,
    add column if not exists timepoint_ordinal integer,
    add column if not exists group_membership_id uuid,
    add column if not exists group_id uuid,
    add column if not exists group_code text,
    add column if not exists subject_link_id uuid;

alter table public.research_response_records
    add column if not exists presented_at timestamptz,
    add column if not exists answered_utc_offset_minutes integer
        check (answered_utc_offset_minutes between -840 and 840),
    add column if not exists client_time_zone text;

create index if not exists research_study_catalog
    on public.research_studies(status, code, version desc);
create index if not exists research_enrollment_participant
    on public.research_study_enrollments(respondent_account_id, status);
create index if not exists research_measurement_participant
    on public.research_participant_measurements(enrollment_id, status);
create index if not exists research_session_study_timepoint
    on public.research_os_collection_sessions(study_id, study_version, timepoint_id, group_id);
create index if not exists research_session_subject_time
    on public.research_os_collection_sessions(study_id, subject_link_id, started_at)
    where subject_link_id is not null;

alter table public.research_studies enable row level security;
alter table public.research_study_groups enable row level security;
alter table public.research_study_timepoints enable row level security;
alter table public.research_study_questionnaire_assignments enable row level security;
alter table public.research_study_invitations enable row level security;
alter table public.research_study_enrollments enable row level security;
alter table public.research_study_group_memberships enable row level security;
alter table public.research_participant_measurements enable row level security;
revoke all on public.research_studies from public, anon, authenticated;
revoke all on public.research_study_groups from public, anon, authenticated;
revoke all on public.research_study_timepoints from public, anon, authenticated;
revoke all on public.research_study_questionnaire_assignments from public, anon, authenticated;
revoke all on public.research_study_invitations from public, anon, authenticated;
revoke all on public.research_study_enrollments from public, anon, authenticated;
revoke all on public.research_study_group_memberships from public, anon, authenticated;
revoke all on public.research_participant_measurements from public, anon, authenticated;
grant select, insert, update on public.research_studies to service_role;
grant select, insert, update, delete on public.research_study_groups to service_role;
grant select, insert, update, delete on public.research_study_timepoints to service_role;
grant select, insert, update, delete on public.research_study_questionnaire_assignments to service_role;
grant select, insert, update, delete on public.research_study_invitations to service_role;
grant select, insert, update on public.research_study_enrollments to service_role;
grant select, insert, update on public.research_study_group_memberships to service_role;
grant select, insert, update on public.research_participant_measurements to service_role;

create or replace function public.save_owned_study_package(
    study_data jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_study_id uuid;
    v_version integer;
    v_existing public.research_studies%rowtype;
    v_group jsonb;
    v_timepoint jsonb;
    v_assignment jsonb;
begin
    if study_data ->> 'schema' is distinct from 'research_os.study'
       or (study_data ->> 'schema_version')::integer is distinct from 1
       or study_data ->> 'status' not in ('draft', 'trial', 'active')
       or study_data ->> 'collection_mode' not in (
           'fixed_questionnaire_mode', 'adaptive_dialogue_mode'
       )
       or study_data ->> 'longitudinal_linkage' not in (
           'none', 'within_study_consent_bound'
       )
       or jsonb_typeof(study_data -> 'groups') is distinct from 'array'
       or jsonb_typeof(study_data -> 'timepoints') is distinct from 'array'
       or jsonb_typeof(study_data -> 'questionnaire_assignments') is distinct from 'array'
       or jsonb_array_length(study_data -> 'groups') = 0
       or jsonb_array_length(study_data -> 'timepoints') = 0
       or (
           study_data ->> 'status' = 'active'
           and jsonb_array_length(study_data -> 'questionnaire_assignments') = 0
       ) then
        raise exception 'Complete research_os.study schema version 1 is required';
    end if;

    v_study_id := (study_data ->> 'study_id')::uuid;
    v_version := (study_data ->> 'version')::integer;
    if v_version < 1
       or nullif(btrim(study_data ->> 'code'), '') is null
       or nullif(btrim(study_data ->> 'title'), '') is null
       or study_data ->> 'global_time_reference' is null
       or study_data ->> 'generated_at' is null then
        raise exception 'Study identity, version, title and time references are required';
    end if;

    select * into v_existing
      from public.research_studies
     where study_id = v_study_id and version = v_version
     for update;
    if found and v_existing.package_data = study_data then
        return jsonb_build_object(
            'study_id', v_study_id, 'study_version', v_version, 'idempotent', true
        );
    end if;
    if found and v_existing.status = 'active' then
        raise exception 'An active study version is immutable; create a new version';
    end if;

    insert into public.research_studies (
        study_id, version, code, title, description, status, schema_version,
        primary_language, collection_mode, longitudinal_linkage,
        global_time_reference, generated_at, package_data
    ) values (
        v_study_id, v_version, study_data ->> 'code', study_data ->> 'title',
        study_data ->> 'description', study_data ->> 'status', 1,
        study_data ->> 'primary_language', study_data ->> 'collection_mode',
        study_data ->> 'longitudinal_linkage',
        (study_data ->> 'global_time_reference')::timestamptz,
        (study_data ->> 'generated_at')::timestamptz, study_data
    )
    on conflict (study_id, version) do update set
        code = excluded.code, title = excluded.title, description = excluded.description,
        status = excluded.status, primary_language = excluded.primary_language,
        collection_mode = excluded.collection_mode,
        longitudinal_linkage = excluded.longitudinal_linkage,
        global_time_reference = excluded.global_time_reference,
        generated_at = excluded.generated_at, package_data = excluded.package_data,
        updated_at = now();

    insert into public.research_os_entity_ownership (
        entity_type, entity_id, researcher_account_id
    ) values ('study', v_study_id, p_researcher_account_id)
    on conflict (entity_type, entity_id) do nothing;
    if not exists (
        select 1 from public.research_os_entity_ownership
         where entity_type = 'study' and entity_id = v_study_id
           and researcher_account_id = p_researcher_account_id
    ) then
        raise exception 'Study identity belongs to another researcher';
    end if;

    delete from public.research_study_questionnaire_assignments
     where study_id = v_study_id and study_version = v_version;
    delete from public.research_study_timepoints
     where study_id = v_study_id and study_version = v_version;
    delete from public.research_study_invitations
     where study_id = v_study_id and study_version = v_version;
    delete from public.research_study_groups
     where study_id = v_study_id and study_version = v_version;

    for v_group in select value from jsonb_array_elements(study_data -> 'groups')
    loop
        insert into public.research_study_groups (
            study_id, study_version, group_id, code, title, description, position
        ) values (
            v_study_id, v_version, (v_group ->> 'group_id')::uuid,
            v_group ->> 'code', v_group ->> 'title', v_group ->> 'description',
            (v_group ->> 'position')::integer
        );
        insert into public.research_study_invitations (
            invitation_id, study_id, study_version, group_id, status
        ) values (
            (v_group ->> 'invitation_id')::uuid, v_study_id, v_version,
            (v_group ->> 'group_id')::uuid, 'open'
        );
    end loop;
    for v_timepoint in select value from jsonb_array_elements(study_data -> 'timepoints')
    loop
        insert into public.research_study_timepoints (
            study_id, study_version, timepoint_id, code, title, ordinal,
            planned_offset
        ) values (
            v_study_id, v_version, (v_timepoint ->> 'timepoint_id')::uuid,
            v_timepoint ->> 'code', v_timepoint ->> 'title',
            (v_timepoint ->> 'ordinal')::integer,
            nullif(v_timepoint ->> 'planned_offset_iso8601', '')::interval
        );
    end loop;
    for v_assignment in
        select value from jsonb_array_elements(study_data -> 'questionnaire_assignments')
    loop
        if not exists (
            select 1 from public.research_os_entity_ownership
             where entity_type = 'questionnaire'
               and entity_id = (v_assignment ->> 'questionnaire_id')::uuid
               and researcher_account_id = p_researcher_account_id
        ) then
            raise exception 'Every assigned questionnaire must belong to the study researcher';
        end if;
        if study_data ->> 'status' = 'active'
           and not exists (
               select 1 from public.questionnaires q
                where q.questionnaire_id =
                      (v_assignment ->> 'questionnaire_id')::uuid
                  and q.version =
                      (v_assignment ->> 'questionnaire_version')::integer
                  and q.status = 'active'
           ) then
            raise exception 'An active study may assign only active questionnaire versions';
        end if;
        if study_data ->> 'longitudinal_linkage' = 'within_study_consent_bound'
           and not exists (
               select 1
                 from public.questionnaire_consent_bindings b
                 join public.consent_documents c
                   on c.consent_id = b.consent_id and c.version = b.consent_version
                where b.questionnaire_id =
                      (v_assignment ->> 'questionnaire_id')::uuid
                  and b.questionnaire_version =
                      (v_assignment ->> 'questionnaire_version')::integer
                  and b.consent_mode = 'special'
                  and (
                      study_data ->> 'status' <> 'active'
                      or c.status = 'active'
                  )
           ) then
            raise exception 'Consent-bound longitudinal studies require special consent for every assigned questionnaire';
        end if;
        insert into public.research_study_questionnaire_assignments (
            assignment_id, study_id, study_version, timepoint_id,
            questionnaire_id, questionnaire_version, position, required,
            available_from, available_until
        ) values (
            (v_assignment ->> 'assignment_id')::uuid, v_study_id, v_version,
            (v_assignment ->> 'timepoint_id')::uuid,
            (v_assignment ->> 'questionnaire_id')::uuid,
            (v_assignment ->> 'questionnaire_version')::integer,
            (v_assignment ->> 'position')::integer,
            coalesce((v_assignment ->> 'required')::boolean, true),
            nullif(v_assignment ->> 'available_from', '')::timestamptz,
            nullif(v_assignment ->> 'available_until', '')::timestamptz
        );
    end loop;
    return jsonb_build_object(
        'study_id', v_study_id, 'study_version', v_version, 'idempotent', false
    );
end;
$$;

create or replace function public.list_studies_for_account(
    p_researcher_account_id uuid,
    requested_status text default 'all'
)
returns table (
    study_id uuid, version integer, code text, title text, status text,
    collection_mode text, longitudinal_linkage text,
    group_count bigint, timepoint_count bigint, assignment_count bigint,
    global_time_reference timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.study_id, s.version, s.code, s.title, s.status, s.collection_mode,
           s.longitudinal_linkage,
           (select count(*) from public.research_study_groups g
             where g.study_id = s.study_id and g.study_version = s.version),
           (select count(*) from public.research_study_timepoints t
             where t.study_id = s.study_id and t.study_version = s.version),
           (select count(*) from public.research_study_questionnaire_assignments a
             where a.study_id = s.study_id and a.study_version = s.version),
           s.global_time_reference, s.updated_at
      from public.research_studies s
      join public.research_os_entity_ownership o
        on o.entity_type = 'study' and o.entity_id = s.study_id
       and o.researcher_account_id = p_researcher_account_id
     where requested_status = 'all' or s.status = requested_status
     order by s.updated_at desc;
$$;

create or replace function public.load_study_package_for_account(
    p_study_id uuid,
    p_study_version integer,
    p_researcher_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.package_data
      from public.research_studies s
      join public.research_os_entity_ownership o
        on o.entity_type = 'study' and o.entity_id = s.study_id
       and o.researcher_account_id = p_researcher_account_id
     where s.study_id = p_study_id and s.version = p_study_version;
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
    v_session public.research_os_collection_sessions%rowtype;
    v_saved integer := 0;
begin
    if jsonb_typeof(source_identity) is distinct from 'object'
       or jsonb_typeof(response_records) is distinct from 'array'
       or jsonb_array_length(response_records) = 0 then
        raise exception 'Source identity and non-empty response-record array are required';
    end if;
    select * into v_session
      from public.research_os_collection_sessions
     where session_id = (source_identity ->> 'session_id')::uuid
       and status = 'active'
     for update;
    if not found then
        raise exception 'Active collection session was not found';
    end if;
    if (source_identity ->> 'global_time_reference')::timestamptz
            is distinct from v_session.global_time_reference
       or (source_identity ->> 'questionnaire_id')::uuid
            is distinct from v_session.questionnaire_id
       or (source_identity ->> 'questionnaire_version')::integer
            is distinct from v_session.questionnaire_version
       or (source_identity ->> 'study_id')::uuid is distinct from v_session.study_id
       or (source_identity ->> 'study_version')::integer
            is distinct from v_session.study_version
       or (source_identity ->> 'enrollment_id')::uuid
            is distinct from v_session.enrollment_id
       or (source_identity ->> 'participant_measurement_id')::uuid
            is distinct from v_session.participant_measurement_id
       or (source_identity ->> 'timepoint_id')::uuid
            is distinct from v_session.timepoint_id
       or (source_identity ->> 'study_questionnaire_assignment_id')::uuid
            is distinct from v_session.study_questionnaire_assignment_id
       or (source_identity ->> 'group_membership_id')::uuid
            is distinct from v_session.group_membership_id
       or (source_identity ->> 'group_id')::uuid is distinct from v_session.group_id
       or source_identity ->> 'group_code' is distinct from v_session.group_code
       or source_identity ->> 'timepoint_code' is distinct from v_session.timepoint_code
       or (source_identity ->> 'timepoint_ordinal')::integer
            is distinct from v_session.timepoint_ordinal
       or (source_identity ->> 'subject_link_id')::uuid
            is distinct from v_session.subject_link_id
       or source_identity ->> 'collection_started_at' is null
       or source_identity ->> 'collection_finished_at' is null then
        raise exception 'Source identity does not match the study collection session';
    end if;

    for v_record in select value from jsonb_array_elements(response_records)
    loop
        if (v_record ->> 'session_id')::uuid is distinct from v_session.session_id
           or v_record ->> 'participant_id' is distinct from v_session.respondent_identifier
           or v_record ->> 'questionnaire_item_id' is null
           or v_record ->> 'presented_at' is null
           or v_record ->> 'answered_at' is null
           or (v_record ->> 'global_time_reference')::timestamptz
                is distinct from v_session.global_time_reference
           or (v_record ->> 'presented_at')::timestamptz >
              (v_record ->> 'answered_at')::timestamptz then
            raise exception 'Response session, item or observed answer time is invalid';
        end if;
        if not exists (
            select 1 from public.questionnaire_items qi
             where qi.questionnaire_id = v_session.questionnaire_id
               and qi.questionnaire_version = v_session.questionnaire_version
               and qi.item_id = (v_record ->> 'questionnaire_item_id')::uuid
               and qi.source_bank_id = (v_record ->> 'bank_id')::uuid
               and qi.source_bank_version = (v_record ->> 'bank_version')::integer
               and qi.question_id = (v_record ->> 'question_id')::uuid
               and qi.question_version = (v_record ->> 'question_version')::integer
        ) then
            raise exception 'Response does not match the session questionnaire version';
        end if;
        insert into public.research_response_records (
            response_id, session_id, participant_id,
            bank_id, bank_version, question_id, question_version,
            questionnaire_item_id, code, value, scale_snapshot,
            presented_at, answered_at, answered_utc_offset_minutes,
            client_time_zone, global_time_reference, source_identity
        ) values (
            (v_record ->> 'response_id')::uuid, v_session.session_id::text,
            v_record ->> 'participant_id',
            (v_record ->> 'bank_id')::uuid,
            (v_record ->> 'bank_version')::integer,
            (v_record ->> 'question_id')::uuid,
            (v_record ->> 'question_version')::integer,
            (v_record ->> 'questionnaire_item_id')::uuid,
            v_record ->> 'code', v_record -> 'value', v_record -> 'scale',
            (v_record ->> 'presented_at')::timestamptz,
            (v_record ->> 'answered_at')::timestamptz,
            (v_record ->> 'answered_utc_offset_minutes')::integer,
            source_identity ->> 'client_time_zone',
            (v_record ->> 'global_time_reference')::timestamptz,
            source_identity
        )
        on conflict (response_id) do nothing;
        v_saved := v_saved + 1;
    end loop;
    update public.research_os_collection_sessions
       set status = 'completed',
           completed_at = (source_identity ->> 'collection_finished_at')::timestamptz
     where session_id = v_session.session_id;
    update public.research_participant_measurements
       set status = 'completed'
     where participant_measurement_id = v_session.participant_measurement_id
       and collection_session_id = v_session.session_id;
    return jsonb_build_object(
        'session_id', v_session.session_id, 'saved_count', v_saved,
        'session_status', 'completed', 'measurement_status', 'completed'
    );
end;
$$;

create or replace function public.list_respondent_measurements(
    p_respondent_account_id uuid
)
returns table (
    participant_measurement_id uuid,
    study_id uuid, study_version integer, study_code text, study_title text,
    enrollment_id uuid, participant_role text,
    group_id uuid, group_code text, group_title text,
    timepoint_id uuid, timepoint_code text, timepoint_title text,
    timepoint_ordinal integer,
    questionnaire_id uuid, questionnaire_version integer,
    questionnaire_code text, questionnaire_title text, questionnaire_description text,
    primary_language text, consent_id uuid, consent_version integer,
    consent_title text, consent_mode text, measurement_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select pm.participant_measurement_id,
           s.study_id, s.version, s.code, s.title,
           e.enrollment_id, e.participant_role,
           g.group_id, g.code, g.title,
           t.timepoint_id, t.code, t.title, t.ordinal,
           q.questionnaire_id, q.version, q.code, q.title, q.description,
           q.primary_language, c.consent_id, c.version, c.title, b.consent_mode,
           pm.status
      from public.research_participant_measurements pm
      join public.research_study_enrollments e on e.enrollment_id = pm.enrollment_id
      join public.research_studies s
        on s.study_id = e.study_id and s.version = e.study_version
      join public.research_study_questionnaire_assignments a
        on a.assignment_id = pm.assignment_id
      join public.research_study_timepoints t
        on t.study_id = a.study_id and t.study_version = a.study_version
       and t.timepoint_id = a.timepoint_id
      join public.research_study_group_memberships gm
        on gm.enrollment_id = e.enrollment_id and gm.valid_until is null
      join public.research_study_groups g
        on g.study_id = gm.study_id and g.study_version = gm.study_version
       and g.group_id = gm.group_id
      join public.questionnaires q
        on q.questionnaire_id = a.questionnaire_id
       and q.version = a.questionnaire_version
      join public.questionnaire_consent_bindings b
        on b.questionnaire_id = q.questionnaire_id
       and b.questionnaire_version = q.version
      join public.consent_documents c
        on c.consent_id = b.consent_id and c.version = b.consent_version
     where e.respondent_account_id = p_respondent_account_id
       and e.status = 'active' and s.status in ('trial', 'active')
       and q.status = 'active' and c.status = 'active'
       and pm.status in ('scheduled', 'available')
       and (pm.available_from is null or pm.available_from <= clock_timestamp())
       and (pm.available_until is null or pm.available_until > clock_timestamp())
     order by t.ordinal, a.position;
$$;

create or replace function public.get_respondent_measurement_consent(
    p_respondent_account_id uuid,
    p_participant_measurement_id uuid,
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
    select pm.participant_measurement_id, s.study_id, s.version as study_version,
           s.title as study_title, e.enrollment_id,
           g.group_id, g.code as group_code,
           t.timepoint_id, t.code as timepoint_code, t.ordinal as timepoint_ordinal,
           a.assignment_id, q.questionnaire_id, q.version as questionnaire_version,
           q.title as questionnaire_title, c.consent_id, c.version as consent_version,
           c.title as consent_title, c.primary_language, c.texts
      into v_row
      from public.research_participant_measurements pm
      join public.research_study_enrollments e on e.enrollment_id = pm.enrollment_id
      join public.research_studies s
        on s.study_id = e.study_id and s.version = e.study_version
      join public.research_study_questionnaire_assignments a
        on a.assignment_id = pm.assignment_id
      join public.research_study_timepoints t
        on t.study_id = a.study_id and t.study_version = a.study_version
       and t.timepoint_id = a.timepoint_id
      join public.research_study_group_memberships gm
        on gm.enrollment_id = e.enrollment_id and gm.valid_until is null
      join public.research_study_groups g
        on g.study_id = gm.study_id and g.study_version = gm.study_version
       and g.group_id = gm.group_id
      join public.questionnaires q
        on q.questionnaire_id = a.questionnaire_id
       and q.version = a.questionnaire_version
      join public.questionnaire_consent_bindings b
        on b.questionnaire_id = q.questionnaire_id
       and b.questionnaire_version = q.version
      join public.consent_documents c
        on c.consent_id = b.consent_id and c.version = b.consent_version
     where pm.participant_measurement_id = p_participant_measurement_id
       and e.respondent_account_id = p_respondent_account_id
       and e.status = 'active' and s.status in ('trial', 'active')
       and q.status = 'active' and c.status = 'active'
       and pm.status in ('scheduled', 'available')
       and (pm.available_from is null or pm.available_from <= clock_timestamp())
       and (pm.available_until is null or pm.available_until > clock_timestamp());
    if not found then return null; end if;
    v_language := case
        when nullif(btrim(v_row.texts ->> p_requested_language), '') is not null
            then p_requested_language
        else v_row.primary_language
    end;
    v_text := v_row.texts ->> v_language;
    if nullif(btrim(v_text), '') is null then return null; end if;
    return to_jsonb(v_row) - 'texts' - 'primary_language' || jsonb_build_object(
        'language', v_language, 'text', v_text,
        'text_sha256', encode(digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex')
    );
end;
$$;

create or replace function public.accept_consent_and_start_measurement(
    p_respondent_account_id uuid,
    p_participant_measurement_id uuid,
    p_requested_language text,
    p_explicit_acceptance boolean
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_consent jsonb;
    v_pm public.research_participant_measurements%rowtype;
    v_enrollment public.research_study_enrollments%rowtype;
    v_assignment public.research_study_questionnaire_assignments%rowtype;
    v_timepoint public.research_study_timepoints%rowtype;
    v_membership public.research_study_group_memberships%rowtype;
    v_group public.research_study_groups%rowtype;
    v_study public.research_studies%rowtype;
    v_consent_mode text;
    v_researcher_id uuid;
    v_respondent public.research_os_accounts%rowtype;
    v_session_id uuid := gen_random_uuid();
    v_acceptance_id uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_consent_record jsonb;
begin
    if p_explicit_acceptance is distinct from true then
        raise exception 'Explicit consent acceptance is required';
    end if;
    select * into v_pm from public.research_participant_measurements
     where participant_measurement_id = p_participant_measurement_id for update;
    if not found or v_pm.status not in ('scheduled', 'available')
       or (v_pm.available_from is not null and v_pm.available_from > v_now)
       or (v_pm.available_until is not null and v_pm.available_until <= v_now) then
        raise exception 'Participant measurement is not available';
    end if;
    select * into v_enrollment from public.research_study_enrollments
     where enrollment_id = v_pm.enrollment_id
       and respondent_account_id = p_respondent_account_id and status = 'active'
     for share;
    if not found then raise exception 'Active study enrollment is required'; end if;
    select * into v_study from public.research_studies
     where study_id = v_enrollment.study_id and version = v_enrollment.study_version
       and status in ('trial', 'active');
    if not found then raise exception 'Trial or active study version is required'; end if;
    select * into v_assignment from public.research_study_questionnaire_assignments
     where assignment_id = v_pm.assignment_id;
    select * into v_timepoint from public.research_study_timepoints
     where study_id = v_assignment.study_id
       and study_version = v_assignment.study_version
       and timepoint_id = v_assignment.timepoint_id;
    select * into v_membership from public.research_study_group_memberships
     where enrollment_id = v_enrollment.enrollment_id and valid_until is null
     for share;
    if not found then raise exception 'Current study group membership is required'; end if;
    select * into v_group from public.research_study_groups
     where study_id = v_membership.study_id
       and study_version = v_membership.study_version
       and group_id = v_membership.group_id;
    select * into v_respondent from public.research_os_accounts
     where account_id = p_respondent_account_id and role = 'respondent'
       and status = 'active';
    select researcher_account_id into v_researcher_id
      from public.research_os_entity_ownership
     where entity_type = 'study' and entity_id = v_enrollment.study_id;

    v_consent := public.get_respondent_measurement_consent(
        p_respondent_account_id, p_participant_measurement_id, p_requested_language
    );
    if v_consent is null then
        raise exception 'Active measurement with valid non-empty consent is required';
    end if;
    select consent_mode into v_consent_mode
      from public.questionnaire_consent_bindings
     where questionnaire_id = v_assignment.questionnaire_id
       and questionnaire_version = v_assignment.questionnaire_version;
    if v_study.longitudinal_linkage = 'within_study_consent_bound' then
        if v_consent_mode is distinct from 'special' then
            raise exception 'A special consent is required for longitudinal linkage';
        end if;
        update public.research_study_enrollments
           set subject_link_id = coalesce(subject_link_id, gen_random_uuid()),
               linkage_authorized = true,
               linkage_authorized_at = coalesce(linkage_authorized_at, v_now),
               linkage_revoked_at = null
         where enrollment_id = v_enrollment.enrollment_id
        returning * into v_enrollment;
    end if;
    v_consent_record := jsonb_build_object(
        'consent_status', 'accepted',
        'consent_id', v_consent ->> 'consent_id',
        'consent_version', (v_consent ->> 'consent_version')::integer,
        'language', v_consent ->> 'language',
        'text_sha256', v_consent ->> 'text_sha256',
        'accepted_at', v_now, 'acceptance_basis', 'authenticated_checkbox',
        'study_id', v_enrollment.study_id, 'study_version', v_enrollment.study_version,
        'participant_measurement_id', p_participant_measurement_id,
        'questionnaire_id', v_assignment.questionnaire_id,
        'questionnaire_version', v_assignment.questionnaire_version
    );
    insert into public.research_os_collection_sessions (
        session_id, respondent_account_id, researcher_account_id,
        respondent_identifier, study_id, study_version, enrollment_id,
        participant_measurement_id, study_questionnaire_assignment_id,
        timepoint_id, timepoint_code, timepoint_ordinal,
        group_membership_id, group_id, group_code, subject_link_id,
        questionnaire_id, questionnaire_version, status, consent_record,
        global_time_reference, started_at
    ) values (
        v_session_id, p_respondent_account_id, v_researcher_id,
        v_respondent.user_identifier, v_enrollment.study_id, v_enrollment.study_version,
        v_enrollment.enrollment_id, p_participant_measurement_id,
        v_assignment.assignment_id, v_timepoint.timepoint_id, v_timepoint.code,
        v_timepoint.ordinal, v_membership.membership_id, v_group.group_id,
        v_group.code, v_enrollment.subject_link_id,
        v_assignment.questionnaire_id, v_assignment.questionnaire_version,
        'active', v_consent_record, v_now, v_now
    );
    insert into public.consent_acceptances (
        acceptance_id, session_id, respondent_account_id, researcher_account_id,
        questionnaire_id, questionnaire_version, consent_id, consent_version,
        consent_language, consent_title_snapshot, consent_text_snapshot,
        consent_text_sha256, acceptance_basis, accepted_at
    ) values (
        v_acceptance_id, v_session_id, p_respondent_account_id, v_researcher_id,
        v_assignment.questionnaire_id, v_assignment.questionnaire_version,
        (v_consent ->> 'consent_id')::uuid,
        (v_consent ->> 'consent_version')::integer,
        v_consent ->> 'language', v_consent ->> 'consent_title',
        v_consent ->> 'text', v_consent ->> 'text_sha256',
        'authenticated_checkbox', v_now
    );
    update public.research_os_collection_sessions
       set consent_acceptance_id = v_acceptance_id where session_id = v_session_id;
    update public.research_participant_measurements
       set status = 'in_progress', collection_session_id = v_session_id
     where participant_measurement_id = p_participant_measurement_id;
    return jsonb_build_object(
        'session_id', v_session_id, 'global_time_reference', v_now,
        'study_id', v_enrollment.study_id, 'study_version', v_enrollment.study_version,
        'participant_measurement_id', p_participant_measurement_id,
        'questionnaire_id', v_assignment.questionnaire_id,
        'questionnaire_version', v_assignment.questionnaire_version
    );
end;
$$;

create or replace function public.get_public_study_invitation(
    p_invitation_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'invitation_id', i.invitation_id,
        'study_id', s.study_id,
        'study_version', s.version,
        'study_title', s.title,
        'study_description', s.description,
        'group_id', g.group_id,
        'group_code', g.code,
        'group_title', g.title
    )
      from public.research_study_invitations i
      join public.research_studies s
        on s.study_id = i.study_id and s.version = i.study_version
      join public.research_study_groups g
        on g.study_id = i.study_id and g.study_version = i.study_version
       and g.group_id = i.group_id
     where i.invitation_id = p_invitation_id
       and i.status = 'open'
       and s.status in ('trial', 'active');
$$;

create or replace function public.join_study_by_invitation(
    p_respondent_account_id uuid,
    p_invitation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_invitation public.research_study_invitations%rowtype;
    v_enrollment public.research_study_enrollments%rowtype;
    v_membership public.research_study_group_memberships%rowtype;
    v_now timestamptz := clock_timestamp();
    v_created_measurements integer := 0;
    v_idempotent boolean := false;
begin
    if not exists (
        select 1 from public.research_os_accounts
         where account_id = p_respondent_account_id
           and role = 'respondent' and status = 'active'
    ) then
        raise exception 'Active respondent account is required';
    end if;
    perform pg_advisory_xact_lock(
        hashtextextended(
            p_invitation_id::text || ':' || p_respondent_account_id::text,
            0
        )
    );

    select i.* into v_invitation
      from public.research_study_invitations i
      join public.research_studies s
        on s.study_id = i.study_id and s.version = i.study_version
     where i.invitation_id = p_invitation_id
       and i.status = 'open' and s.status in ('trial', 'active')
     for share of i;
    if not found then raise exception 'Open study invitation was not found'; end if;

    select * into v_enrollment
      from public.research_study_enrollments
     where study_id = v_invitation.study_id
       and study_version = v_invitation.study_version
       and respondent_account_id = p_respondent_account_id
     for update;
    if found then
        if v_enrollment.status <> 'active' then
            raise exception 'Existing study participation is not active';
        end if;
        select * into v_membership
          from public.research_study_group_memberships
         where enrollment_id = v_enrollment.enrollment_id and valid_until is null
         for share;
        if not found or v_membership.group_id <> v_invitation.group_id then
            raise exception 'Respondent already participates in this study through another group';
        end if;
        v_idempotent := true;
    else
        insert into public.research_study_enrollments (
            enrollment_id, study_id, study_version, respondent_account_id,
            participant_role, status, enrolled_at
        ) values (
            gen_random_uuid(), v_invitation.study_id, v_invitation.study_version,
            p_respondent_account_id, 'participant', 'active', v_now
        )
        returning * into v_enrollment;
        insert into public.research_study_group_memberships (
            membership_id, enrollment_id, study_id, study_version, group_id,
            valid_from
        ) values (
            gen_random_uuid(), v_enrollment.enrollment_id, v_invitation.study_id,
            v_invitation.study_version, v_invitation.group_id, v_now
        )
        returning * into v_membership;
    end if;

    insert into public.research_participant_measurements (
        participant_measurement_id, enrollment_id, study_id, study_version,
        assignment_id, status, available_from, available_until
    )
    select gen_random_uuid(), v_enrollment.enrollment_id, a.study_id, a.study_version,
           a.assignment_id,
           case
               when (a.available_from is null or a.available_from <= v_now)
                and (a.available_until is null or a.available_until > v_now)
                   then 'available'
               else 'scheduled'
           end,
           a.available_from, a.available_until
      from public.research_study_questionnaire_assignments a
     where a.study_id = v_invitation.study_id
       and a.study_version = v_invitation.study_version
    on conflict (enrollment_id, assignment_id) do nothing;
    get diagnostics v_created_measurements = row_count;

    return jsonb_build_object(
        'study_id', v_enrollment.study_id,
        'study_version', v_enrollment.study_version,
        'enrollment_id', v_enrollment.enrollment_id,
        'group_id', v_invitation.group_id,
        'created_measurements', v_created_measurements,
        'idempotent', v_idempotent
    );
end;
$$;

create or replace function public.list_respondent_study_sessions(
    p_respondent_account_id uuid
)
returns table (
    session_id uuid, status text,
    study_id uuid, study_version integer, study_title text,
    group_code text, timepoint_code text, timepoint_ordinal integer,
    questionnaire_id uuid, questionnaire_version integer, questionnaire_title text,
    started_at timestamptz, completed_at timestamptz,
    consent_acceptance_id uuid, consent_id uuid, consent_version integer,
    consent_language text, consent_title text, consent_text text,
    consent_text_sha256 text, accepted_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select cs.session_id, cs.status, cs.study_id, cs.study_version, s.title,
           cs.group_code, cs.timepoint_code, cs.timepoint_ordinal,
           cs.questionnaire_id, cs.questionnaire_version, q.title,
           cs.started_at, cs.completed_at, ca.acceptance_id, ca.consent_id,
           ca.consent_version, ca.consent_language, ca.consent_title_snapshot,
           ca.consent_text_snapshot, ca.consent_text_sha256, ca.accepted_at
      from public.research_os_collection_sessions cs
      join public.research_studies s
        on s.study_id = cs.study_id and s.version = cs.study_version
      join public.questionnaires q
        on q.questionnaire_id = cs.questionnaire_id
       and q.version = cs.questionnaire_version
      join public.consent_acceptances ca
        on ca.acceptance_id = cs.consent_acceptance_id
     where cs.respondent_account_id = p_respondent_account_id
       and cs.participant_measurement_id is not null
     order by cs.started_at desc;
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
        'session_id', cs.session_id, 'status', cs.status,
        'global_time_reference', cs.global_time_reference,
        'started_at', cs.started_at, 'completed_at', cs.completed_at,
        'study_id', cs.study_id, 'study_version', cs.study_version,
        'enrollment_id', cs.enrollment_id,
        'participant_measurement_id', cs.participant_measurement_id,
        'study_questionnaire_assignment_id', cs.study_questionnaire_assignment_id,
        'timepoint_id', cs.timepoint_id, 'timepoint_code', cs.timepoint_code,
        'timepoint_ordinal', cs.timepoint_ordinal,
        'group_membership_id', cs.group_membership_id,
        'group_id', cs.group_id, 'group_code', cs.group_code,
        'subject_link_id', cs.subject_link_id,
        'questionnaire', q.package_data,
        'consent_acceptance_id', ca.acceptance_id, 'accepted_at', ca.accepted_at
    )
      from public.research_os_collection_sessions cs
      join public.questionnaires q
        on q.questionnaire_id = cs.questionnaire_id
       and q.version = cs.questionnaire_version
      join public.consent_acceptances ca
        on ca.acceptance_id = cs.consent_acceptance_id
     where cs.respondent_account_id = p_respondent_account_id
       and cs.session_id = p_session_id;
$$;

revoke all on function public.save_owned_study_package(jsonb, uuid)
    from public, anon, authenticated;
revoke all on function public.list_studies_for_account(uuid, text)
    from public, anon, authenticated;
revoke all on function public.load_study_package_for_account(uuid, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.save_response_records(jsonb, jsonb)
    from public, anon, authenticated;
revoke all on function public.list_respondent_measurements(uuid)
    from public, anon, authenticated;
revoke all on function public.get_respondent_measurement_consent(uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.accept_consent_and_start_measurement(
    uuid, uuid, text, boolean
) from public, anon, authenticated;
revoke all on function public.get_public_study_invitation(uuid)
    from public, anon, authenticated;
revoke all on function public.join_study_by_invitation(uuid, uuid)
    from public, anon, authenticated;
revoke execute on function public.list_respondent_questionnaires(uuid)
    from service_role;
revoke execute on function public.get_respondent_questionnaire_consent(
    uuid, uuid, integer, text
) from service_role;
revoke execute on function public.accept_consent_and_start_questionnaire(
    uuid, uuid, integer, text, boolean
) from service_role;
revoke all on function public.list_respondent_study_sessions(uuid)
    from public, anon, authenticated;
revoke all on function public.load_respondent_collection_session(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.save_owned_study_package(jsonb, uuid) to service_role;
grant execute on function public.list_studies_for_account(uuid, text) to service_role;
grant execute on function public.load_study_package_for_account(uuid, integer, uuid)
    to service_role;
grant execute on function public.save_response_records(jsonb, jsonb) to service_role;
grant execute on function public.list_respondent_measurements(uuid) to service_role;
grant execute on function public.get_respondent_measurement_consent(uuid, uuid, text)
    to service_role;
grant execute on function public.accept_consent_and_start_measurement(
    uuid, uuid, text, boolean
) to service_role;
grant execute on function public.get_public_study_invitation(uuid)
    to service_role;
grant execute on function public.join_study_by_invitation(uuid, uuid)
    to service_role;
grant execute on function public.list_respondent_study_sessions(uuid) to service_role;
grant execute on function public.load_respondent_collection_session(uuid, uuid)
    to service_role;

commit;
