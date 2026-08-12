-- Research OS advanced collection and allocation contracts v1.
-- Apply after catalog_content_access_v1.sql and research_study_contract_v1.sql.
-- Adds concealed experimental allocation, two adaptive-dialogue engines, and
-- a versioned qualitative-analysis workspace without replacing questionnaire collection.

begin;

alter table public.research_os_entity_ownership
    drop constraint if exists research_os_entity_ownership_entity_type_check;
alter table public.research_os_entity_ownership
    add constraint research_os_entity_ownership_entity_type_check
    check (entity_type in (
        'question_bank', 'parameter', 'questionnaire', 'consent_document', 'study',
        'qualitative_project'
    ));

alter table public.research_study_invitations
    add column if not exists invitation_scope text not null default 'group'
        check (invitation_scope in ('group', 'study_randomized'));

create table if not exists public.research_experimental_allocations (
    allocation_id uuid primary key default gen_random_uuid(),
    study_id uuid not null,
    study_version integer not null,
    enrollment_id uuid not null unique
        references public.research_study_enrollments(enrollment_id) on delete restrict,
    protocol_id uuid not null,
    method text not null check (
        method in ('simple_random', 'block_random', 'stratified_block_random')
    ),
    assigned_group_id uuid not null,
    stratum_values jsonb not null default '{}'::jsonb,
    stratum_key text not null default '',
    block_index integer,
    block_position integer,
    random_token text,
    algorithm_version text not null check (algorithm_version = 'research_os_allocation_v1'),
    protocol_snapshot jsonb not null,
    assigned_at timestamptz not null default clock_timestamp(),
    foreign key (study_id, study_version, assigned_group_id)
        references public.research_study_groups(study_id, study_version, group_id)
        on delete restrict,
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete restrict
);

create index if not exists research_experimental_allocation_sequence
    on public.research_experimental_allocations(study_id, study_version, stratum_key, assigned_at);

create table if not exists public.research_study_dialogue_assignments (
    dialogue_assignment_id uuid primary key,
    study_id uuid not null,
    study_version integer not null,
    timepoint_id uuid not null,
    position integer not null check (position > 0),
    required boolean not null default true,
    available_from timestamptz,
    available_until timestamptz,
    protocol_id uuid not null,
    protocol_version integer not null check (protocol_version > 0),
    dialogue_type text not null check (dialogue_type in ('researcher_scripted', 'ai_assisted')),
    title text not null check (length(btrim(title)) > 0),
    primary_language text not null,
    consent_id uuid not null,
    consent_version integer not null,
    protocol_snapshot jsonb not null,
    included_in_package boolean not null default true,
    created_at timestamptz not null default clock_timestamp(),
    unique (study_id, study_version, timepoint_id, position),
    foreign key (study_id, study_version, timepoint_id)
        references public.research_study_timepoints(study_id, study_version, timepoint_id)
        on delete restrict,
    foreign key (consent_id, consent_version)
        references public.consent_documents(consent_id, version) on delete restrict,
    check (available_until is null or available_from is null or available_until > available_from)
);

create table if not exists public.research_dialogue_measurements (
    dialogue_measurement_id uuid primary key default gen_random_uuid(),
    enrollment_id uuid not null
        references public.research_study_enrollments(enrollment_id) on delete restrict,
    study_id uuid not null,
    study_version integer not null,
    dialogue_assignment_id uuid not null
        references public.research_study_dialogue_assignments(dialogue_assignment_id) on delete restrict,
    status text not null default 'available'
        check (status in ('scheduled', 'available', 'in_progress', 'completed', 'expired')),
    available_from timestamptz,
    available_until timestamptz,
    dialogue_session_id uuid,
    created_at timestamptz not null default clock_timestamp(),
    unique (enrollment_id, dialogue_assignment_id),
    foreign key (enrollment_id, study_id, study_version)
        references public.research_study_enrollments(enrollment_id, study_id, study_version)
        on delete restrict
);

create table if not exists public.research_dialogue_sessions (
    dialogue_session_id uuid primary key default gen_random_uuid(),
    dialogue_measurement_id uuid not null unique
        references public.research_dialogue_measurements(dialogue_measurement_id) on delete restrict,
    respondent_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    study_id uuid not null,
    study_version integer not null,
    dialogue_assignment_id uuid not null,
    protocol_id uuid not null,
    protocol_version integer not null,
    dialogue_type text not null check (dialogue_type in ('researcher_scripted', 'ai_assisted')),
    protocol_snapshot jsonb not null,
    current_node_id uuid,
    status text not null default 'active'
        check (status in ('active', 'completed', 'discarded')),
    global_time_reference timestamptz not null,
    started_at timestamptz not null,
    completed_at timestamptz,
    discarded_at timestamptz,
    completion_reason text,
    consent_acceptance_id uuid,
    ai_provider text,
    ai_model text,
    ai_prompt_version text,
    pending_response_turn_id uuid,
    pending_processing_token uuid,
    foreign key (dialogue_assignment_id)
        references public.research_study_dialogue_assignments(dialogue_assignment_id) on delete restrict,
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete restrict
);

create table if not exists public.research_dialogue_consent_acceptances (
    acceptance_id uuid primary key default gen_random_uuid(),
    dialogue_session_id uuid not null unique
        references public.research_dialogue_sessions(dialogue_session_id) on delete restrict,
    respondent_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    protocol_id uuid not null,
    protocol_version integer not null,
    consent_id uuid not null,
    consent_version integer not null,
    consent_language text not null,
    consent_title_snapshot text not null,
    consent_text_snapshot text not null,
    consent_text_sha256 text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
    acceptance_basis text not null check (acceptance_basis = 'authenticated_checkbox'),
    accepted_at timestamptz not null,
    status text not null default 'accepted' check (status = 'accepted'),
    foreign key (consent_id, consent_version)
        references public.consent_documents(consent_id, version) on delete restrict
);

alter table public.research_dialogue_sessions
    drop constraint if exists research_dialogue_sessions_consent_fk;
alter table public.research_dialogue_sessions
    add constraint research_dialogue_sessions_consent_fk
    foreign key (consent_acceptance_id)
    references public.research_dialogue_consent_acceptances(acceptance_id) on delete restrict;

alter table public.research_dialogue_measurements
    drop constraint if exists research_dialogue_measurements_session_fk;
alter table public.research_dialogue_measurements
    add constraint research_dialogue_measurements_session_fk
    foreign key (dialogue_session_id)
    references public.research_dialogue_sessions(dialogue_session_id) on delete restrict;

create table if not exists public.research_dialogue_turns (
    turn_id uuid primary key default gen_random_uuid(),
    dialogue_session_id uuid not null
        references public.research_dialogue_sessions(dialogue_session_id) on delete restrict,
    ordinal integer not null check (ordinal > 0),
    speaker text not null check (speaker in ('researcher_script', 'ai_facilitator', 'respondent')),
    node_id uuid,
    content text not null,
    response_value jsonb,
    presented_at timestamptz,
    recorded_at timestamptz not null default clock_timestamp(),
    provider text,
    model text,
    prompt_version text,
    prompt_sha256 text,
    decision_snapshot jsonb,
    unique (dialogue_session_id, ordinal)
);

-- Qualitative packages keep immutable scientific versions while their normalized
-- contents support coding, audit, and triangulation without parsing opaque prose.
create table if not exists public.qualitative_projects (
    qualitative_project_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    status text not null check (status in ('draft', 'trial', 'active')),
    primary_language text not null,
    study_id uuid,
    study_version integer,
    methodology text not null check (methodology in (
        'thematic_analysis', 'content_analysis', 'grounded_theory',
        'discourse_analysis', 'narrative_analysis', 'mixed_qualitative'
    )),
    package_data jsonb not null,
    generated_at timestamptz not null,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    primary key (qualitative_project_id, version),
    foreign key (study_id, study_version)
        references public.research_studies(study_id, version) on delete restrict
);

create table if not exists public.qualitative_sources (
    source_id uuid not null,
    qualitative_project_id uuid not null,
    project_version integer not null,
    source_type text not null check (source_type in (
        'interview_transcript', 'dialogue_transcript', 'field_note', 'document',
        'observation', 'open_response_corpus'
    )),
    title text not null,
    language text not null,
    content text not null,
    provenance jsonb not null default '{}'::jsonb,
    position integer not null check (position > 0),
    included_in_version boolean not null default true,
    primary key (qualitative_project_id, project_version, source_id),
    foreign key (qualitative_project_id, project_version)
        references public.qualitative_projects(qualitative_project_id, version) on delete restrict,
    unique (qualitative_project_id, project_version, position)
);

create table if not exists public.qualitative_segments (
    segment_id uuid not null,
    qualitative_project_id uuid not null,
    project_version integer not null,
    source_id uuid not null,
    start_offset integer not null check (start_offset >= 0),
    end_offset integer not null check (end_offset > start_offset),
    exact_text_snapshot text not null,
    speaker_label text,
    included_in_version boolean not null default true,
    created_at timestamptz not null default clock_timestamp(),
    primary key (qualitative_project_id, project_version, segment_id),
    foreign key (qualitative_project_id, project_version)
        references public.qualitative_projects(qualitative_project_id, version) on delete restrict,
    foreign key (qualitative_project_id, project_version, source_id)
        references public.qualitative_sources(qualitative_project_id, project_version, source_id)
        on delete restrict
);

create table if not exists public.qualitative_codes (
    qualitative_project_id uuid not null,
    project_version integer not null,
    code_id uuid not null,
    parent_code_id uuid,
    code text not null,
    label text not null,
    definition text not null,
    inclusion_rules text not null,
    exclusion_rules text not null,
    examples jsonb not null default '[]'::jsonb,
    color text,
    position integer not null check (position > 0),
    included_in_version boolean not null default true,
    primary key (qualitative_project_id, project_version, code_id),
    foreign key (qualitative_project_id, project_version)
        references public.qualitative_projects(qualitative_project_id, version) on delete restrict,
    foreign key (qualitative_project_id, project_version, parent_code_id)
        references public.qualitative_codes(qualitative_project_id, project_version, code_id)
        on delete restrict,
    unique (qualitative_project_id, project_version, code)
);

create table if not exists public.qualitative_codings (
    coding_id uuid not null,
    qualitative_project_id uuid not null,
    project_version integer not null,
    segment_id uuid not null,
    code_id uuid not null,
    coder_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    interpretation text,
    confidence text not null default 'not_stated'
        check (confidence in ('high', 'medium', 'low', 'not_stated')),
    included_in_version boolean not null default true,
    created_at timestamptz not null default clock_timestamp(),
    primary key (qualitative_project_id, project_version, coding_id),
    foreign key (qualitative_project_id, project_version, segment_id)
        references public.qualitative_segments(qualitative_project_id, project_version, segment_id)
        on delete restrict,
    foreign key (qualitative_project_id, project_version, code_id)
        references public.qualitative_codes(qualitative_project_id, project_version, code_id)
        on delete restrict,
    unique (qualitative_project_id, project_version, segment_id, code_id, coder_account_id)
);

create table if not exists public.qualitative_memos (
    memo_id uuid not null,
    qualitative_project_id uuid not null,
    project_version integer not null,
    memo_type text not null check (memo_type in (
        'reflexive', 'methodological', 'analytic', 'case', 'code', 'triangulation'
    )),
    title text not null,
    body text not null,
    linked_entity jsonb,
    author_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    included_in_version boolean not null default true,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (qualitative_project_id, project_version, memo_id),
    foreign key (qualitative_project_id, project_version)
        references public.qualitative_projects(qualitative_project_id, version) on delete restrict
);

create table if not exists public.qualitative_triangulation_links (
    link_id uuid not null,
    qualitative_project_id uuid not null,
    project_version integer not null,
    qualitative_evidence jsonb not null,
    quantitative_evidence jsonb not null,
    relationship text not null check (relationship in (
        'converges', 'complements', 'diverges', 'explains', 'not_established'
    )),
    rationale text not null,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    included_in_version boolean not null default true,
    created_at timestamptz not null,
    primary key (qualitative_project_id, project_version, link_id),
    foreign key (qualitative_project_id, project_version)
        references public.qualitative_projects(qualitative_project_id, version) on delete restrict
);

create table if not exists public.qualitative_project_collaborators (
    qualitative_project_id uuid not null,
    researcher_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    role text not null check (role in ('coder', 'reviewer')),
    status text not null default 'active' check (status in ('active', 'revoked')),
    granted_by_account_id uuid not null
        references public.research_os_accounts(account_id) on delete restrict,
    granted_at timestamptz not null default clock_timestamp(),
    revoked_at timestamptz,
    primary key (qualitative_project_id, researcher_account_id),
    check ((status='active' and revoked_at is null) or (status='revoked' and revoked_at is not null))
);

alter table public.research_experimental_allocations enable row level security;
alter table public.research_study_dialogue_assignments enable row level security;
alter table public.research_dialogue_measurements enable row level security;
alter table public.research_dialogue_sessions enable row level security;
alter table public.research_dialogue_consent_acceptances enable row level security;
alter table public.research_dialogue_turns enable row level security;
alter table public.qualitative_projects enable row level security;
alter table public.qualitative_sources enable row level security;
alter table public.qualitative_segments enable row level security;
alter table public.qualitative_codes enable row level security;
alter table public.qualitative_codings enable row level security;
alter table public.qualitative_memos enable row level security;
alter table public.qualitative_triangulation_links enable row level security;
alter table public.qualitative_project_collaborators enable row level security;

revoke all on public.research_experimental_allocations,
    public.research_study_dialogue_assignments, public.research_dialogue_measurements,
    public.research_dialogue_sessions, public.research_dialogue_consent_acceptances,
    public.research_dialogue_turns, public.qualitative_projects, public.qualitative_sources,
    public.qualitative_segments, public.qualitative_codes, public.qualitative_codings,
    public.qualitative_memos, public.qualitative_triangulation_links,
    public.qualitative_project_collaborators
from public, anon, authenticated;

grant select, insert, update on public.research_experimental_allocations,
    public.research_study_dialogue_assignments, public.research_dialogue_measurements,
    public.research_dialogue_sessions, public.research_dialogue_consent_acceptances,
    public.research_dialogue_turns, public.qualitative_projects, public.qualitative_sources,
    public.qualitative_segments, public.qualitative_codes, public.qualitative_codings,
    public.qualitative_memos, public.qualitative_triangulation_links,
    public.qualitative_project_collaborators
to service_role;

create or replace function public.validate_research_dialogue_protocol(p_protocol jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v_type text := p_protocol ->> 'dialogue_type';
    v_nodes jsonb := p_protocol #> '{researcher_scripted,nodes}';
    v_node jsonb;
    v_rule jsonb;
    v_node_ids uuid[] := array[]::uuid[];
    v_target text;
begin
    if jsonb_typeof(p_protocol) is distinct from 'object'
       or nullif(p_protocol ->> 'protocol_id', '') is null
       or (p_protocol ->> 'version')::integer < 1
       or v_type not in ('researcher_scripted', 'ai_assisted')
       or nullif(btrim(p_protocol ->> 'title'), '') is null
       or nullif(btrim(p_protocol ->> 'primary_language'), '') is null
       or (p_protocol ->> 'max_turns')::integer not between 1 and 100
       or (p_protocol #>> '{consent,consent_id}') is null
       or (p_protocol #>> '{consent,consent_version}')::integer < 1 then
        raise exception 'Complete adaptive dialogue protocol is required';
    end if;

    if v_type = 'researcher_scripted' then
        if jsonb_typeof(v_nodes) is distinct from 'array' or jsonb_array_length(v_nodes) = 0
           or nullif(p_protocol #>> '{researcher_scripted,opening_node_id}', '') is null then
            raise exception 'Scripted dialogue requires an opening node and nodes';
        end if;
        for v_node in select value from jsonb_array_elements(v_nodes) loop
            if nullif(v_node ->> 'node_id', '') is null
               or nullif(btrim(v_node ->> 'prompt'), '') is null
               or v_node ->> 'response_type' not in ('text', 'single_select', 'multiple_select', 'numeric')
               or jsonb_typeof(coalesce(v_node -> 'rules', '[]'::jsonb)) is distinct from 'array'
               or nullif(v_node ->> 'default_target', '') is null then
                raise exception 'Every scripted node requires identity, prompt, response type and routing';
            end if;
            v_node_ids := array_append(v_node_ids, (v_node ->> 'node_id')::uuid);
            if v_node ->> 'response_type' in ('single_select', 'multiple_select')
               and (jsonb_typeof(v_node -> 'options') is distinct from 'array'
                    or jsonb_array_length(v_node -> 'options') < 2) then
                raise exception 'Selection dialogue nodes require at least two options';
            end if;
        end loop;
        if cardinality(v_node_ids) <> cardinality(array(select distinct unnest(v_node_ids)))
           or not ((p_protocol #>> '{researcher_scripted,opening_node_id}')::uuid = any(v_node_ids)) then
            raise exception 'Dialogue node identities must be unique and include the opening node';
        end if;
        for v_node in select value from jsonb_array_elements(v_nodes) loop
            v_target := v_node ->> 'default_target';
            if v_target <> 'end' and not (v_target::uuid = any(v_node_ids)) then
                raise exception 'Scripted dialogue default target is invalid';
            end if;
            for v_rule in select value from jsonb_array_elements(coalesce(v_node -> 'rules', '[]'::jsonb)) loop
                v_target := v_rule ->> 'target';
                if v_rule ->> 'operator' not in ('equals', 'contains', 'greater_than', 'less_than', 'includes')
                   or v_rule -> 'value' is null
                   or nullif(v_target, '') is null
                   or (v_target <> 'end' and not (v_target::uuid = any(v_node_ids))) then
                    raise exception 'Scripted dialogue routing rule is invalid';
                end if;
            end loop;
        end loop;
    else
        if nullif(btrim(p_protocol #>> '{ai_assisted,opening_prompt}'), '') is null
           or jsonb_typeof(p_protocol #> '{ai_assisted,research_objectives}') is distinct from 'array'
           or jsonb_array_length(p_protocol #> '{ai_assisted,research_objectives}') = 0
           or jsonb_typeof(p_protocol #> '{ai_assisted,probe_boundaries}') is distinct from 'array'
           or jsonb_array_length(p_protocol #> '{ai_assisted,probe_boundaries}') = 0
           or jsonb_typeof(p_protocol #> '{ai_assisted,stopping_criteria}') is distinct from 'array'
           or jsonb_array_length(p_protocol #> '{ai_assisted,stopping_criteria}') = 0
           or p_protocol #>> '{ai_assisted,provider}' <> 'groq'
           or p_protocol #>> '{ai_assisted,model}' <> 'openai/gpt-oss-20b'
           or nullif(p_protocol #>> '{ai_assisted,prompt_version}', '') is null
           or p_protocol #>> '{consent,mode}' <> 'special'
           or coalesce((p_protocol #>> '{ai_assisted,external_processing_disclosure}')::boolean, false) is not true then
            raise exception 'AI-assisted dialogue requires objectives, boundaries, stopping criteria, pinned model and processing disclosure';
        end if;
    end if;
end;
$$;

create or replace function public.save_owned_advanced_study_package(
    study_data jsonb,
    p_researcher_account_id uuid,
    p_catalog_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_result jsonb;
    v_assignment jsonb;
    v_protocol jsonb;
    v_design text := study_data #>> '{study_design,design_type}';
    v_allocation jsonb := study_data #> '{study_design,allocation_protocol}';
    v_dialogues jsonb := coalesce(study_data -> 'dialogue_assignments', '[]'::jsonb);
    v_group_ids uuid[];
    v_ratio jsonb;
    v_ratio_ids uuid[] := array[]::uuid[];
    v_ratio_sum integer := 0;
    v_consent public.consent_documents%rowtype;
begin
    if jsonb_typeof(v_dialogues) is distinct from 'array' then
        raise exception 'dialogue_assignments must be an array';
    end if;
    select array_agg((value ->> 'group_id')::uuid order by (value ->> 'position')::integer)
      into v_group_ids from jsonb_array_elements(study_data -> 'groups');

    if v_design = 'experimental' then
        if jsonb_typeof(v_allocation) is distinct from 'object'
           or nullif(v_allocation ->> 'protocol_id', '') is null
           or v_allocation ->> 'method' not in ('simple_random', 'block_random', 'stratified_block_random')
           or nullif(v_allocation ->> 'allocation_seed', '') is null
           or v_allocation ->> 'concealment' not in ('concealed_until_assignment', 'concealed_from_respondent')
           or jsonb_typeof(v_allocation -> 'group_ratios') is distinct from 'array'
           or jsonb_array_length(v_allocation -> 'group_ratios') <> cardinality(v_group_ids) then
            raise exception 'Experimental design requires a complete concealed allocation protocol';
        end if;
        for v_ratio in select value from jsonb_array_elements(v_allocation -> 'group_ratios') loop
            if (v_ratio ->> 'weight')::integer < 1 then
                raise exception 'Allocation weights must be positive integers';
            end if;
            v_ratio_ids := array_append(v_ratio_ids, (v_ratio ->> 'group_id')::uuid);
            v_ratio_sum := v_ratio_sum + (v_ratio ->> 'weight')::integer;
        end loop;
        if cardinality(v_ratio_ids) <> cardinality(array(select distinct unnest(v_ratio_ids)))
           or not (v_ratio_ids @> v_group_ids and v_group_ids @> v_ratio_ids) then
            raise exception 'Allocation ratios must cover every study group exactly once';
        end if;
        if v_allocation ->> 'method' in ('block_random', 'stratified_block_random')
           and (v_allocation ->> 'block_size')::integer <> v_ratio_sum then
            raise exception 'Block size must equal the complete allocation-ratio cycle';
        end if;
        if v_allocation ->> 'method' = 'stratified_block_random'
           and (jsonb_typeof(v_allocation -> 'strata') is distinct from 'array'
                or jsonb_array_length(v_allocation -> 'strata') = 0) then
            raise exception 'Stratified allocation requires explicit strata';
        end if;
    elsif v_allocation is not null and v_allocation <> 'null'::jsonb then
        raise exception 'Allocation protocol is allowed only for an experimental design';
    end if;

    if study_data ->> 'collection_mode' = 'adaptive_dialogue_mode' and jsonb_array_length(v_dialogues) = 0 then
        raise exception 'Adaptive dialogue mode requires at least one dialogue assignment';
    end if;
    if study_data ->> 'collection_mode' = 'fixed_questionnaire_mode' and jsonb_array_length(v_dialogues) > 0 then
        raise exception 'Dialogue assignments require adaptive dialogue mode';
    end if;

    for v_assignment in select value from jsonb_array_elements(v_dialogues) loop
        v_protocol := v_assignment -> 'protocol';
        perform public.validate_research_dialogue_protocol(v_protocol);
        if not exists (
            select 1 from jsonb_array_elements(study_data -> 'timepoints') p
             where (p ->> 'timepoint_id')::uuid = (v_assignment ->> 'timepoint_id')::uuid
        ) then raise exception 'Dialogue assignment timepoint is invalid'; end if;
        select * into v_consent from public.consent_documents
         where consent_id = (v_protocol #>> '{consent,consent_id}')::uuid
           and version = (v_protocol #>> '{consent,consent_version}')::integer for share;
        if not found then raise exception 'Dialogue consent version does not exist'; end if;
        if v_protocol ->> 'dialogue_type' = 'ai_assisted' and v_consent.is_system then
            raise exception 'AI-assisted dialogue requires a special consent that discloses external processing';
        end if;
        if study_data ->> 'status' = 'active'
           and (v_consent.status <> 'active'
                or nullif(btrim(v_consent.texts ->> v_consent.primary_language), '') is null) then
            raise exception 'Active dialogue requires an active non-empty consent version';
        end if;
        if not v_consent.is_system and not exists (
            select 1 from public.research_os_entity_ownership o
             where o.entity_type = 'consent_document'
               and o.entity_id = v_consent.consent_id
               and o.researcher_account_id = p_researcher_account_id
        ) then raise exception 'Dialogue special consent belongs to another researcher'; end if;
    end loop;

    v_result := public.save_owned_study_package_with_visibility(
        study_data, p_researcher_account_id, p_catalog_visibility
    );

    update public.research_study_invitations
       set invitation_scope = case when v_design = 'experimental' then 'study_randomized' else 'group' end
     where study_id = (study_data ->> 'study_id')::uuid
       and study_version = (study_data ->> 'version')::integer;

    update public.research_study_dialogue_assignments set included_in_package = false
     where study_id = (study_data ->> 'study_id')::uuid
       and study_version = (study_data ->> 'version')::integer;
    for v_assignment in select value from jsonb_array_elements(v_dialogues) loop
        v_protocol := v_assignment -> 'protocol';
        insert into public.research_study_dialogue_assignments (
            dialogue_assignment_id, study_id, study_version, timepoint_id, position,
            required, available_from, available_until, protocol_id, protocol_version,
            dialogue_type, title, primary_language, consent_id, consent_version,
            protocol_snapshot, included_in_package
        ) values (
            (v_assignment ->> 'dialogue_assignment_id')::uuid,
            (study_data ->> 'study_id')::uuid, (study_data ->> 'version')::integer,
            (v_assignment ->> 'timepoint_id')::uuid, (v_assignment ->> 'position')::integer,
            coalesce((v_assignment ->> 'required')::boolean, true),
            nullif(v_assignment ->> 'available_from', '')::timestamptz,
            nullif(v_assignment ->> 'available_until', '')::timestamptz,
            (v_protocol ->> 'protocol_id')::uuid, (v_protocol ->> 'version')::integer,
            v_protocol ->> 'dialogue_type', v_protocol ->> 'title',
            v_protocol ->> 'primary_language',
            (v_protocol #>> '{consent,consent_id}')::uuid,
            (v_protocol #>> '{consent,consent_version}')::integer,
            v_protocol, true
        ) on conflict (dialogue_assignment_id) do update set
            timepoint_id = excluded.timepoint_id, position = excluded.position,
            required = excluded.required, available_from = excluded.available_from,
            available_until = excluded.available_until, protocol_id = excluded.protocol_id,
            protocol_version = excluded.protocol_version, dialogue_type = excluded.dialogue_type,
            title = excluded.title, primary_language = excluded.primary_language,
            consent_id = excluded.consent_id, consent_version = excluded.consent_version,
            protocol_snapshot = excluded.protocol_snapshot, included_in_package = true;
    end loop;
    return v_result || jsonb_build_object(
        'dialogue_assignment_count', jsonb_array_length(v_dialogues),
        'allocation_method', case when v_design = 'experimental' then v_allocation ->> 'method' else null end
    );
end;
$$;

create or replace function public.allocate_experimental_group(
    p_study_id uuid,
    p_study_version integer,
    p_enrollment_id uuid,
    p_strata jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_study public.research_studies%rowtype;
    v_protocol jsonb;
    v_method text;
    v_definition jsonb;
    v_value text;
    v_stratum_values jsonb := '{}'::jsonb;
    v_stratum_key text := '';
    v_ratio_sum integer;
    v_sequence_count integer;
    v_block_size integer;
    v_block_index integer;
    v_block_position integer;
    v_random_token text;
    v_pick integer;
    v_group_id uuid;
begin
    select * into v_study from public.research_studies
     where study_id = p_study_id and version = p_study_version for share;
    if not found or v_study.package_data #>> '{study_design,design_type}' <> 'experimental' then
        raise exception 'Experimental study is required for server allocation';
    end if;
    v_protocol := v_study.package_data #> '{study_design,allocation_protocol}';
    v_method := v_protocol ->> 'method';
    p_strata := coalesce(p_strata, '{}'::jsonb);
    if jsonb_typeof(p_strata) is distinct from 'object' then
        raise exception 'Stratum values must be an object';
    end if;
    if v_method = 'stratified_block_random' then
        for v_definition in select value from jsonb_array_elements(v_protocol -> 'strata') loop
            v_value := p_strata ->> (v_definition ->> 'code');
            if nullif(btrim(v_value), '') is null
               or not exists (
                   select 1 from jsonb_array_elements_text(v_definition -> 'allowed_values') allowed
                    where allowed = v_value
               ) then raise exception 'Complete allowed stratum values are required'; end if;
            v_stratum_values := v_stratum_values || jsonb_build_object(v_definition ->> 'code', v_value);
            v_stratum_key := v_stratum_key || case when v_stratum_key = '' then '' else '|' end
                || (v_definition ->> 'code') || '=' || v_value;
        end loop;
        if (select count(*) from jsonb_object_keys(p_strata)) <>
           jsonb_array_length(v_protocol -> 'strata') then
            raise exception 'Only protocol-defined stratum values are accepted';
        end if;
    elsif p_strata <> '{}'::jsonb then
        raise exception 'Stratum values are accepted only by stratified allocation';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        p_study_id::text || ':' || p_study_version::text || ':' || v_stratum_key, 0
    ));
    select coalesce(sum((ratio ->> 'weight')::integer), 0) into v_ratio_sum
      from jsonb_array_elements(v_protocol -> 'group_ratios') ratio;
    if v_ratio_sum < 2 then raise exception 'Allocation ratio cycle is invalid'; end if;

    select count(*) into v_sequence_count
      from public.research_experimental_allocations
     where study_id = p_study_id and study_version = p_study_version
       and stratum_key = v_stratum_key;

    if v_method = 'simple_random' then
        v_random_token := encode(gen_random_bytes(16), 'hex');
        v_pick := mod(abs(hashtextextended(v_random_token, 0)::numeric), v_ratio_sum)::integer + 1;
        select expanded.group_id into v_group_id
          from (
              select (ratio ->> 'group_id')::uuid as group_id,
                     row_number() over (
                         order by ratio_ordinal, repetition
                     ) as slot
                from jsonb_array_elements(v_protocol -> 'group_ratios')
                     with ordinality r(ratio, ratio_ordinal)
                cross join lateral generate_series(1, (ratio ->> 'weight')::integer) repetition
          ) expanded where expanded.slot = v_pick;
    else
        v_block_size := (v_protocol ->> 'block_size')::integer;
        v_block_index := v_sequence_count / v_block_size;
        v_block_position := mod(v_sequence_count, v_block_size) + 1;
        select expanded.group_id into v_group_id
          from (
              select (ratio ->> 'group_id')::uuid as group_id,
                     row_number() over (
                         order by md5(
                             (v_protocol ->> 'allocation_seed') || '|' || v_stratum_key || '|'
                             || v_block_index::text || '|' || (ratio ->> 'group_id') || '|'
                             || repetition::text
                         )
                     ) as slot
                from jsonb_array_elements(v_protocol -> 'group_ratios') ratio
                cross join lateral generate_series(1, (ratio ->> 'weight')::integer) repetition
          ) expanded where expanded.slot = v_block_position;
    end if;
    if v_group_id is null then raise exception 'Allocation sequence could not select a group'; end if;

    insert into public.research_experimental_allocations (
        study_id, study_version, enrollment_id, protocol_id, method,
        assigned_group_id, stratum_values, stratum_key, block_index, block_position,
        random_token, algorithm_version, protocol_snapshot
    ) values (
        p_study_id, p_study_version, p_enrollment_id,
        (v_protocol ->> 'protocol_id')::uuid, v_method, v_group_id,
        v_stratum_values, v_stratum_key, v_block_index, v_block_position,
        v_random_token, 'research_os_allocation_v1', v_protocol
    );
    return v_group_id;
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
    select jsonb_strip_nulls(jsonb_build_object(
        'invitation_id', i.invitation_id,
        'study_id', s.study_id,
        'study_version', s.version,
        'study_title', s.title,
        'study_description', s.description,
        'randomized', i.invitation_scope = 'study_randomized',
        'allocation_method', case when i.invitation_scope = 'study_randomized'
            then s.package_data #>> '{study_design,allocation_protocol,method}' end,
        'strata', case when i.invitation_scope = 'study_randomized'
            then coalesce(s.package_data #> '{study_design,allocation_protocol,strata}', '[]'::jsonb) end,
        'group_id', case when i.invitation_scope = 'group' then g.group_id end,
        'group_code', case when i.invitation_scope = 'group' then g.code end,
        'group_title', case when i.invitation_scope = 'group' then g.title end
    ))
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
    p_invitation_id uuid,
    p_strata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_invitation public.research_study_invitations%rowtype;
    v_study public.research_studies%rowtype;
    v_enrollment public.research_study_enrollments%rowtype;
    v_membership public.research_study_group_memberships%rowtype;
    v_group_id uuid;
    v_concealment text;
    v_now timestamptz := clock_timestamp();
    v_created_measurements integer := 0;
    v_created_dialogues integer := 0;
    v_idempotent boolean := false;
begin
    if not exists (select 1 from public.research_os_accounts
        where account_id = p_respondent_account_id and role = 'respondent' and status = 'active') then
        raise exception 'Active respondent account is required';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
        p_invitation_id::text || ':' || p_respondent_account_id::text, 0
    ));
    select i, s into v_invitation, v_study
      from public.research_study_invitations i
      join public.research_studies s on s.study_id = i.study_id and s.version = i.study_version
     where i.invitation_id = p_invitation_id and i.status = 'open'
       and s.status in ('trial', 'active') for share of i, s;
    if not found then raise exception 'Open study invitation was not found'; end if;

    select * into v_enrollment from public.research_study_enrollments
     where study_id = v_invitation.study_id and study_version = v_invitation.study_version
       and respondent_account_id = p_respondent_account_id for update;
    if found then
        if v_enrollment.status <> 'active' then raise exception 'Existing study participation is not active'; end if;
        select * into v_membership from public.research_study_group_memberships
         where enrollment_id = v_enrollment.enrollment_id and valid_until is null for share;
        if not found then raise exception 'Current study group membership is required'; end if;
        v_group_id := v_membership.group_id;
        v_idempotent := true;
    else
        insert into public.research_study_enrollments (
            enrollment_id, study_id, study_version, respondent_account_id,
            participant_role, status, enrolled_at
        ) values (
            gen_random_uuid(), v_invitation.study_id, v_invitation.study_version,
            p_respondent_account_id, 'participant', 'active', v_now
        ) returning * into v_enrollment;
        if v_invitation.invitation_scope = 'study_randomized' then
            v_group_id := public.allocate_experimental_group(
                v_invitation.study_id, v_invitation.study_version, v_enrollment.enrollment_id, p_strata
            );
        else
            if coalesce(p_strata, '{}'::jsonb) <> '{}'::jsonb then
                raise exception 'This invitation does not accept stratum values';
            end if;
            v_group_id := v_invitation.group_id;
        end if;
        insert into public.research_study_group_memberships (
            membership_id, enrollment_id, study_id, study_version, group_id, valid_from
        ) values (
            gen_random_uuid(), v_enrollment.enrollment_id, v_invitation.study_id,
            v_invitation.study_version, v_group_id, v_now
        ) returning * into v_membership;
    end if;

    insert into public.research_participant_measurements (
        participant_measurement_id, enrollment_id, study_id, study_version,
        assignment_id, status, available_from, available_until
    ) select gen_random_uuid(), v_enrollment.enrollment_id, a.study_id, a.study_version,
             a.assignment_id,
             case when (a.available_from is null or a.available_from <= v_now)
                        and (a.available_until is null or a.available_until > v_now)
                  then 'available' else 'scheduled' end,
             a.available_from, a.available_until
        from public.research_study_questionnaire_assignments a
       where a.study_id = v_invitation.study_id and a.study_version = v_invitation.study_version
    on conflict (enrollment_id, assignment_id) do nothing;
    get diagnostics v_created_measurements = row_count;

    insert into public.research_dialogue_measurements (
        enrollment_id, study_id, study_version, dialogue_assignment_id,
        status, available_from, available_until
    ) select v_enrollment.enrollment_id, a.study_id, a.study_version, a.dialogue_assignment_id,
             case when (a.available_from is null or a.available_from <= v_now)
                        and (a.available_until is null or a.available_until > v_now)
                  then 'available' else 'scheduled' end,
             a.available_from, a.available_until
        from public.research_study_dialogue_assignments a
       where a.study_id = v_invitation.study_id and a.study_version = v_invitation.study_version
         and a.included_in_package
    on conflict (enrollment_id, dialogue_assignment_id) do nothing;
    get diagnostics v_created_dialogues = row_count;

    v_concealment := v_study.package_data #>> '{study_design,allocation_protocol,concealment}';
    return jsonb_strip_nulls(jsonb_build_object(
        'study_id', v_enrollment.study_id, 'study_version', v_enrollment.study_version,
        'enrollment_id', v_enrollment.enrollment_id,
        'group_id', case when v_concealment = 'concealed_from_respondent' then null else v_group_id end,
        'allocation_concealed', v_concealment = 'concealed_from_respondent',
        'created_measurements', v_created_measurements,
        'created_dialogue_measurements', v_created_dialogues,
        'idempotent', v_idempotent
    ));
end;
$$;

create or replace function public.list_respondent_dialogue_measurements(
    p_respondent_account_id uuid
)
returns table (
    dialogue_measurement_id uuid, status text,
    study_id uuid, study_version integer, study_title text,
    group_code text, group_title text,
    timepoint_id uuid, timepoint_code text, timepoint_title text,
    dialogue_assignment_id uuid, dialogue_title text, dialogue_type text,
    protocol_id uuid, protocol_version integer, primary_language text,
    consent_id uuid, consent_version integer, consent_title text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select dm.dialogue_measurement_id, dm.status,
           s.study_id, s.version, s.title,
           case when s.package_data #>> '{study_design,allocation_protocol,concealment}' = 'concealed_from_respondent'
                then null else g.code end,
           case when s.package_data #>> '{study_design,allocation_protocol,concealment}' = 'concealed_from_respondent'
                then null else g.title end,
           tp.timepoint_id, tp.code, tp.title,
           da.dialogue_assignment_id, da.title, da.dialogue_type,
           da.protocol_id, da.protocol_version, da.primary_language,
           c.consent_id, c.version, c.title
      from public.research_dialogue_measurements dm
      join public.research_study_enrollments e on e.enrollment_id = dm.enrollment_id
      join public.research_studies s on s.study_id = dm.study_id and s.version = dm.study_version
      join public.research_study_group_memberships gm
        on gm.enrollment_id = e.enrollment_id and gm.valid_until is null
      join public.research_study_groups g
        on g.study_id = gm.study_id and g.study_version = gm.study_version and g.group_id = gm.group_id
      join public.research_study_dialogue_assignments da
        on da.dialogue_assignment_id = dm.dialogue_assignment_id and da.included_in_package
      join public.research_study_timepoints tp
        on tp.study_id = da.study_id and tp.study_version = da.study_version
       and tp.timepoint_id = da.timepoint_id
      join public.consent_documents c
        on c.consent_id = da.consent_id and c.version = da.consent_version
     where e.respondent_account_id = p_respondent_account_id
       and e.status = 'active' and dm.status in ('scheduled', 'available', 'in_progress')
     order by tp.ordinal, da.position;
$$;

create or replace function public.get_respondent_dialogue_consent(
    p_respondent_account_id uuid,
    p_dialogue_measurement_id uuid,
    p_language text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_row record;
    v_language text;
    v_text text;
begin
    select dm.status, da.*, c.title as consent_title, c.primary_language as consent_primary_language,
           c.texts, s.title as study_title
      into v_row
      from public.research_dialogue_measurements dm
      join public.research_study_enrollments e on e.enrollment_id = dm.enrollment_id
      join public.research_study_dialogue_assignments da
        on da.dialogue_assignment_id = dm.dialogue_assignment_id and da.included_in_package
      join public.consent_documents c
        on c.consent_id = da.consent_id and c.version = da.consent_version
      join public.research_studies s on s.study_id = dm.study_id and s.version = dm.study_version
     where dm.dialogue_measurement_id = p_dialogue_measurement_id
       and e.respondent_account_id = p_respondent_account_id
       and dm.status in ('available', 'in_progress');
    if not found then raise exception 'Available dialogue measurement was not found'; end if;
    v_language := case when nullif(btrim(v_row.texts ->> p_language), '') is not null
        then p_language else v_row.consent_primary_language end;
    v_text := v_row.texts ->> v_language;
    if nullif(btrim(v_text), '') is null then raise exception 'Consent text is unavailable'; end if;
    return jsonb_build_object(
        'dialogue_measurement_id', p_dialogue_measurement_id,
        'study_title', v_row.study_title, 'dialogue_title', v_row.title,
        'dialogue_type', v_row.dialogue_type,
        'protocol_id', v_row.protocol_id, 'protocol_version', v_row.protocol_version,
        'consent_id', v_row.consent_id, 'consent_version', v_row.consent_version,
        'consent_title', v_row.consent_title, 'language', v_language,
        'text', v_text, 'text_sha256', encode(digest(v_text, 'sha256'), 'hex')
    );
end;
$$;

create or replace function public.start_respondent_dialogue_session(
    p_respondent_account_id uuid,
    p_dialogue_measurement_id uuid,
    p_language text,
    p_explicit_acceptance boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row record;
    v_session public.research_dialogue_sessions%rowtype;
    v_acceptance public.research_dialogue_consent_acceptances%rowtype;
    v_language text;
    v_text text;
    v_opening text;
    v_opening_node uuid;
    v_now timestamptz := clock_timestamp();
begin
    if p_explicit_acceptance is not true then raise exception 'Explicit consent acceptance is required'; end if;
    select dm.*, da.protocol_snapshot, da.protocol_id, da.protocol_version, da.dialogue_type,
           da.consent_id, da.consent_version, c.title as consent_title,
           c.primary_language as consent_primary_language, c.texts,
           o.researcher_account_id
      into v_row
      from public.research_dialogue_measurements dm
      join public.research_study_enrollments e on e.enrollment_id = dm.enrollment_id
      join public.research_study_dialogue_assignments da
        on da.dialogue_assignment_id = dm.dialogue_assignment_id and da.included_in_package
      join public.consent_documents c
        on c.consent_id = da.consent_id and c.version = da.consent_version
      join public.research_os_entity_ownership o
        on o.entity_type = 'study' and o.entity_id = dm.study_id
     where dm.dialogue_measurement_id = p_dialogue_measurement_id
       and e.respondent_account_id = p_respondent_account_id for update of dm;
    if not found or v_row.status not in ('available', 'in_progress') then
        raise exception 'Available dialogue measurement was not found';
    end if;
    if v_row.dialogue_session_id is not null then
        select * into v_session from public.research_dialogue_sessions
         where dialogue_session_id = v_row.dialogue_session_id;
        return jsonb_build_object('dialogue_session_id', v_session.dialogue_session_id,
            'dialogue_type', v_session.dialogue_type, 'status', v_session.status, 'idempotent', true);
    end if;
    v_language := case when nullif(btrim(v_row.texts ->> p_language), '') is not null
        then p_language else v_row.consent_primary_language end;
    v_text := v_row.texts ->> v_language;
    if nullif(btrim(v_text), '') is null then raise exception 'Consent text is unavailable'; end if;
    if v_row.dialogue_type = 'researcher_scripted' then
        v_opening_node := (v_row.protocol_snapshot #>> '{researcher_scripted,opening_node_id}')::uuid;
        select node ->> 'prompt' into v_opening
          from jsonb_array_elements(v_row.protocol_snapshot #> '{researcher_scripted,nodes}') node
         where (node ->> 'node_id')::uuid = v_opening_node;
    else
        v_opening := v_row.protocol_snapshot #>> '{ai_assisted,opening_prompt}';
    end if;
    insert into public.research_dialogue_sessions (
        dialogue_measurement_id, respondent_account_id, researcher_account_id,
        study_id, study_version, dialogue_assignment_id, protocol_id, protocol_version,
        dialogue_type, protocol_snapshot, current_node_id, status,
        global_time_reference, started_at, ai_provider, ai_model, ai_prompt_version
    ) values (
        p_dialogue_measurement_id, p_respondent_account_id, v_row.researcher_account_id,
        v_row.study_id, v_row.study_version, v_row.dialogue_assignment_id,
        v_row.protocol_id, v_row.protocol_version, v_row.dialogue_type,
        v_row.protocol_snapshot, v_opening_node, 'active', v_now, v_now,
        v_row.protocol_snapshot #>> '{ai_assisted,provider}',
        v_row.protocol_snapshot #>> '{ai_assisted,model}',
        v_row.protocol_snapshot #>> '{ai_assisted,prompt_version}'
    ) returning * into v_session;
    insert into public.research_dialogue_consent_acceptances (
        dialogue_session_id, respondent_account_id, researcher_account_id,
        protocol_id, protocol_version, consent_id, consent_version,
        consent_language, consent_title_snapshot, consent_text_snapshot,
        consent_text_sha256, acceptance_basis, accepted_at
    ) values (
        v_session.dialogue_session_id, p_respondent_account_id, v_row.researcher_account_id,
        v_row.protocol_id, v_row.protocol_version, v_row.consent_id, v_row.consent_version,
        v_language, v_row.consent_title, v_text, encode(digest(v_text, 'sha256'), 'hex'),
        'authenticated_checkbox', v_now
    ) returning * into v_acceptance;
    update public.research_dialogue_sessions set consent_acceptance_id = v_acceptance.acceptance_id
     where dialogue_session_id = v_session.dialogue_session_id;
    insert into public.research_dialogue_turns (
        dialogue_session_id, ordinal, speaker, node_id, content, presented_at
    ) values (
        v_session.dialogue_session_id, 1,
        case when v_row.dialogue_type = 'researcher_scripted' then 'researcher_script' else 'ai_facilitator' end,
        v_opening_node, v_opening, v_now
    );
    update public.research_dialogue_measurements
       set status = 'in_progress', dialogue_session_id = v_session.dialogue_session_id
     where dialogue_measurement_id = p_dialogue_measurement_id;
    return jsonb_build_object(
        'dialogue_session_id', v_session.dialogue_session_id,
        'dialogue_type', v_session.dialogue_type, 'status', 'active',
        'prompt', v_opening, 'node_id', v_opening_node, 'idempotent', false
    );
end;
$$;

create or replace function public.append_scripted_dialogue_response(
    p_respondent_account_id uuid,
    p_dialogue_session_id uuid,
    p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session public.research_dialogue_sessions%rowtype;
    v_node jsonb;
    v_rule jsonb;
    v_target text;
    v_next jsonb;
    v_ordinal integer;
    v_matches boolean := false;
    v_now timestamptz := clock_timestamp();
begin
    select * into v_session from public.research_dialogue_sessions
     where dialogue_session_id = p_dialogue_session_id
       and respondent_account_id = p_respondent_account_id for update;
    if not found or v_session.status <> 'active' or v_session.dialogue_type <> 'researcher_scripted' then
        raise exception 'Active scripted dialogue session was not found';
    end if;
    select node into v_node
      from jsonb_array_elements(v_session.protocol_snapshot #> '{researcher_scripted,nodes}') node
     where (node ->> 'node_id')::uuid = v_session.current_node_id;
    if not found then raise exception 'Current scripted dialogue node is unavailable'; end if;
    if p_response is null or p_response = 'null'::jsonb
       or (v_node ->> 'response_type' = 'text' and nullif(btrim(p_response #>> '{}'), '') is null)
       or (v_node ->> 'response_type' = 'numeric' and jsonb_typeof(p_response) <> 'number')
       or (v_node ->> 'response_type' = 'single_select'
           and not exists (select 1 from jsonb_array_elements(v_node -> 'options') o where o -> 'value' = p_response))
       or (v_node ->> 'response_type' = 'multiple_select'
           and (jsonb_typeof(p_response) <> 'array' or jsonb_array_length(p_response) = 0
                or exists (select 1 from jsonb_array_elements(p_response) selected
                    where not exists (select 1 from jsonb_array_elements(v_node -> 'options') o
                        where o -> 'value' = selected)))) then
        raise exception 'Response does not match the scripted node contract';
    end if;
    select coalesce(max(ordinal), 0) + 1 into v_ordinal from public.research_dialogue_turns
     where dialogue_session_id = p_dialogue_session_id;
    if v_ordinal > (v_session.protocol_snapshot ->> 'max_turns')::integer * 2 then
        raise exception 'Dialogue turn limit was reached';
    end if;
    insert into public.research_dialogue_turns (
        dialogue_session_id, ordinal, speaker, node_id, content, response_value, recorded_at
    ) values (
        p_dialogue_session_id, v_ordinal, 'respondent', v_session.current_node_id,
        case when jsonb_typeof(p_response) = 'string' then p_response #>> '{}' else p_response::text end,
        p_response, v_now
    );
    v_target := v_node ->> 'default_target';
    for v_rule in select value from jsonb_array_elements(coalesce(v_node -> 'rules', '[]'::jsonb)) loop
        v_matches := case v_rule ->> 'operator'
            when 'equals' then p_response = v_rule -> 'value'
            when 'contains' then position(lower(v_rule ->> 'value') in lower(p_response #>> '{}')) > 0
            when 'greater_than' then (p_response #>> '{}')::numeric > (v_rule #>> '{value}')::numeric
            when 'less_than' then (p_response #>> '{}')::numeric < (v_rule #>> '{value}')::numeric
            when 'includes' then exists (select 1 from jsonb_array_elements(p_response) x where x = v_rule -> 'value')
            else false end;
        if v_matches then v_target := v_rule ->> 'target'; exit; end if;
    end loop;
    if v_target = 'end' then
        update public.research_dialogue_sessions set status = 'completed', completed_at = v_now,
            completion_reason = 'scripted_terminal_route', current_node_id = null
         where dialogue_session_id = p_dialogue_session_id;
        update public.research_dialogue_measurements set status = 'completed'
         where dialogue_session_id = p_dialogue_session_id;
        return jsonb_build_object('status', 'completed', 'completion_reason', 'scripted_terminal_route');
    end if;
    select node into v_next
      from jsonb_array_elements(v_session.protocol_snapshot #> '{researcher_scripted,nodes}') node
     where node ->> 'node_id' = v_target;
    if not found then raise exception 'Next scripted dialogue node is unavailable'; end if;
    insert into public.research_dialogue_turns (
        dialogue_session_id, ordinal, speaker, node_id, content, presented_at
    ) values (
        p_dialogue_session_id, v_ordinal + 1, 'researcher_script',
        (v_next ->> 'node_id')::uuid, v_next ->> 'prompt', v_now
    );
    update public.research_dialogue_sessions set current_node_id = (v_next ->> 'node_id')::uuid
     where dialogue_session_id = p_dialogue_session_id;
    return jsonb_build_object('status', 'active', 'prompt', v_next ->> 'prompt',
        'node_id', v_next ->> 'node_id', 'response_type', v_next ->> 'response_type',
        'options', coalesce(v_next -> 'options', '[]'::jsonb));
end;
$$;

create or replace function public.get_respondent_dialogue_session(
    p_respondent_account_id uuid,
    p_dialogue_session_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'dialogue_session_id', s.dialogue_session_id,
        'dialogue_type', s.dialogue_type,
        'status', s.status,
        'started_at', s.started_at,
        'completed_at', s.completed_at,
        'protocol_id', s.protocol_id,
        'protocol_version', s.protocol_version,
        'title', s.protocol_snapshot ->> 'title',
        'primary_language', s.protocol_snapshot ->> 'primary_language',
        'current_node_id', s.current_node_id,
        'turns', coalesce((
            select jsonb_agg(jsonb_build_object(
                'turn_id', t.turn_id, 'ordinal', t.ordinal, 'speaker', t.speaker,
                'node_id', t.node_id, 'content', t.content,
                'response_value', t.response_value, 'presented_at', t.presented_at,
                'recorded_at', t.recorded_at
            ) order by t.ordinal)
              from public.research_dialogue_turns t
             where t.dialogue_session_id = s.dialogue_session_id
        ), '[]'::jsonb),
        'current_node', case when s.dialogue_type = 'researcher_scripted' then (
            select node from jsonb_array_elements(s.protocol_snapshot #> '{researcher_scripted,nodes}') node
             where node ->> 'node_id' = s.current_node_id::text
        ) else jsonb_build_object('response_type', 'text', 'options', '[]'::jsonb) end
    )
      from public.research_dialogue_sessions s
     where s.dialogue_session_id = p_dialogue_session_id
       and s.respondent_account_id = p_respondent_account_id;
$$;

create or replace function public.prepare_ai_dialogue_turn(
    p_respondent_account_id uuid,
    p_dialogue_session_id uuid,
    p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session public.research_dialogue_sessions%rowtype;
    v_response_turn uuid;
    v_token uuid;
    v_ordinal integer;
    v_exchange_count integer;
    v_transcript jsonb;
begin
    if nullif(btrim(p_response), '') is null or length(p_response) > 20000 then
        raise exception 'A non-empty dialogue response of at most 20000 characters is required';
    end if;
    select * into v_session from public.research_dialogue_sessions
     where dialogue_session_id = p_dialogue_session_id
       and respondent_account_id = p_respondent_account_id for update;
    if not found or v_session.status <> 'active' or v_session.dialogue_type <> 'ai_assisted' then
        raise exception 'Active AI-assisted dialogue session was not found';
    end if;
    if v_session.pending_processing_token is not null then
        select content into p_response from public.research_dialogue_turns
         where turn_id = v_session.pending_response_turn_id;
        v_response_turn := v_session.pending_response_turn_id;
        v_token := v_session.pending_processing_token;
    else
        select count(*) into v_exchange_count from public.research_dialogue_turns
         where dialogue_session_id = p_dialogue_session_id and speaker = 'respondent';
        if v_exchange_count >= (v_session.protocol_snapshot ->> 'max_turns')::integer then
            raise exception 'Dialogue turn limit was reached';
        end if;
        select coalesce(max(ordinal), 0) + 1 into v_ordinal from public.research_dialogue_turns
         where dialogue_session_id = p_dialogue_session_id;
        insert into public.research_dialogue_turns (
            dialogue_session_id, ordinal, speaker, content, response_value
        ) values (
            p_dialogue_session_id, v_ordinal, 'respondent', p_response, to_jsonb(p_response)
        ) returning turn_id into v_response_turn;
        v_token := gen_random_uuid();
        update public.research_dialogue_sessions
           set pending_response_turn_id = v_response_turn, pending_processing_token = v_token
         where dialogue_session_id = p_dialogue_session_id;
    end if;
    select jsonb_agg(jsonb_build_object(
        'ordinal', ordinal, 'speaker', speaker, 'content', content
    ) order by ordinal) into v_transcript
      from public.research_dialogue_turns where dialogue_session_id = p_dialogue_session_id;
    return jsonb_build_object(
        'processing_token', v_token,
        'protocol', v_session.protocol_snapshot,
        'transcript', coalesce(v_transcript, '[]'::jsonb),
        'provider', v_session.ai_provider,
        'model', v_session.ai_model,
        'prompt_version', v_session.ai_prompt_version
    );
end;
$$;

create or replace function public.finish_ai_dialogue_turn(
    p_respondent_account_id uuid,
    p_dialogue_session_id uuid,
    p_processing_token uuid,
    p_result jsonb,
    p_prompt_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session public.research_dialogue_sessions%rowtype;
    v_ordinal integer;
    v_exchange_count integer;
    v_now timestamptz := clock_timestamp();
    v_decision text := p_result ->> 'decision';
    v_probe text := p_result ->> 'next_probe';
    v_completion_reason text := 'ai_protocol_stopping_criterion';
begin
    select * into v_session from public.research_dialogue_sessions
     where dialogue_session_id = p_dialogue_session_id
       and respondent_account_id = p_respondent_account_id for update;
    if not found or v_session.status <> 'active' or v_session.dialogue_type <> 'ai_assisted'
       or v_session.pending_processing_token is distinct from p_processing_token then
        raise exception 'AI dialogue processing token is invalid or stale';
    end if;
    if v_decision not in ('continue', 'complete')
       or (v_decision = 'continue' and nullif(btrim(v_probe), '') is null)
       or nullif(btrim(p_result ->> 'rationale'), '') is null
       or jsonb_typeof(p_result -> 'addressed_objectives') is distinct from 'array'
       or exists (
           select 1 from jsonb_array_elements_text(p_result -> 'addressed_objectives') addressed
            where not exists (
                select 1 from jsonb_array_elements_text(
                    v_session.protocol_snapshot #> '{ai_assisted,research_objectives}'
                ) objective where objective = addressed
            )
       )
       or p_prompt_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception 'Complete structured AI dialogue decision is required';
    end if;
    select count(*) into v_exchange_count from public.research_dialogue_turns
     where dialogue_session_id = p_dialogue_session_id and speaker = 'respondent';
    if v_decision = 'continue'
       and v_exchange_count >= (v_session.protocol_snapshot ->> 'max_turns')::integer then
        p_result := p_result || jsonb_build_object(
            'model_decision', 'continue', 'decision', 'complete', 'next_probe', null,
            'server_limit_applied', true
        );
        v_decision := 'complete';
        v_probe := null;
        v_completion_reason := 'max_turns';
    end if;
    select coalesce(max(ordinal), 0) + 1 into v_ordinal from public.research_dialogue_turns
     where dialogue_session_id = p_dialogue_session_id;
    if v_decision = 'continue' then
        insert into public.research_dialogue_turns (
            dialogue_session_id, ordinal, speaker, content, presented_at,
            provider, model, prompt_version, prompt_sha256, decision_snapshot
        ) values (
            p_dialogue_session_id, v_ordinal, 'ai_facilitator', v_probe, v_now,
            v_session.ai_provider, v_session.ai_model, v_session.ai_prompt_version,
            p_prompt_sha256, p_result
        );
        update public.research_dialogue_sessions
           set pending_response_turn_id = null, pending_processing_token = null
         where dialogue_session_id = p_dialogue_session_id;
        return jsonb_build_object('status', 'active', 'prompt', v_probe,
            'decision', p_result);
    end if;
    update public.research_dialogue_sessions
       set status = 'completed', completed_at = v_now,
           completion_reason = v_completion_reason,
           pending_response_turn_id = null, pending_processing_token = null
     where dialogue_session_id = p_dialogue_session_id;
    update public.research_dialogue_measurements set status = 'completed'
     where dialogue_session_id = p_dialogue_session_id;
    return jsonb_build_object('status', 'completed', 'decision', p_result,
        'completion_reason', v_completion_reason);
end;
$$;

create or replace function public.discard_respondent_dialogue_session(
    p_respondent_account_id uuid,
    p_dialogue_session_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_now timestamptz := clock_timestamp();
begin
    update public.research_dialogue_sessions
       set status = 'discarded', discarded_at = v_now,
           completion_reason = left(coalesce(nullif(btrim(p_reason), ''), 'respondent_exit'), 500),
           pending_response_turn_id = null, pending_processing_token = null
     where dialogue_session_id = p_dialogue_session_id
       and respondent_account_id = p_respondent_account_id and status = 'active';
    if not found then raise exception 'Active dialogue session was not found'; end if;
    update public.research_dialogue_measurements set status = 'available', dialogue_session_id = null
     where dialogue_session_id = p_dialogue_session_id;
    return jsonb_build_object('dialogue_session_id', p_dialogue_session_id, 'status', 'discarded');
end;
$$;

create or replace function public.save_owned_qualitative_project(
    p_project jsonb,
    p_researcher_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid := (p_project ->> 'qualitative_project_id')::uuid;
    v_version integer := (p_project ->> 'version')::integer;
    v_existing public.qualitative_projects%rowtype;
    v_item jsonb;
begin
    if p_project ->> 'schema' is distinct from 'research_os.qualitative_project'
       or (p_project ->> 'schema_version')::integer is distinct from 1
       or v_version < 1
       or p_project ->> 'status' not in ('draft', 'trial', 'active')
       or p_project ->> 'methodology' not in (
           'thematic_analysis', 'content_analysis', 'grounded_theory',
           'discourse_analysis', 'narrative_analysis', 'mixed_qualitative'
       )
       or nullif(btrim(p_project ->> 'title'), '') is null
       or jsonb_typeof(p_project -> 'sources') is distinct from 'array'
       or jsonb_typeof(p_project -> 'segments') is distinct from 'array'
       or jsonb_typeof(p_project -> 'codes') is distinct from 'array'
       or jsonb_typeof(p_project -> 'codings') is distinct from 'array'
       or jsonb_typeof(p_project -> 'memos') is distinct from 'array'
       or jsonb_typeof(p_project -> 'triangulation_links') is distinct from 'array' then
        raise exception 'Complete research_os.qualitative_project v1 package is required';
    end if;
    select * into v_existing from public.qualitative_projects
     where qualitative_project_id = v_id and version = v_version for update;
    if found and v_existing.status = 'active' then
        if v_existing.package_data is distinct from p_project then
            raise exception 'Active qualitative project versions are immutable';
        end if;
        return jsonb_build_object('qualitative_project_id', v_id, 'version', v_version,
            'status', v_existing.status, 'idempotent', true);
    end if;
    perform public.claim_research_os_entity('qualitative_project', v_id, p_researcher_account_id);
    if exists (select 1 from public.research_os_entity_ownership o
        where o.entity_type = 'qualitative_project' and o.entity_id = v_id
          and o.researcher_account_id <> p_researcher_account_id) then
        raise exception 'Qualitative project belongs to another researcher';
    end if;
    if not found and v_version > 1 and not exists (
        select 1 from public.qualitative_projects
         where qualitative_project_id = v_id and version = v_version - 1
    ) then raise exception 'Qualitative project versions must be consecutive'; end if;

    insert into public.qualitative_projects (
        qualitative_project_id, version, code, title, status, primary_language,
        study_id, study_version, methodology, package_data, generated_at, updated_at
    ) values (
        v_id, v_version, p_project ->> 'code', p_project ->> 'title',
        p_project ->> 'status', p_project ->> 'primary_language',
        nullif(p_project ->> 'study_id', '')::uuid,
        nullif(p_project ->> 'study_version', '')::integer,
        p_project ->> 'methodology', p_project,
        (p_project ->> 'generated_at')::timestamptz, clock_timestamp()
    ) on conflict (qualitative_project_id, version) do update set
        code = excluded.code, title = excluded.title, status = excluded.status,
        primary_language = excluded.primary_language, study_id = excluded.study_id,
        study_version = excluded.study_version, methodology = excluded.methodology,
        package_data = excluded.package_data, generated_at = excluded.generated_at,
        updated_at = clock_timestamp();

    update public.qualitative_sources set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'sources') loop
        insert into public.qualitative_sources (
            source_id, qualitative_project_id, project_version, source_type,
            title, language, content, provenance, position, included_in_version
        ) values (
            (v_item ->> 'source_id')::uuid, v_id, v_version, v_item ->> 'source_type',
            v_item ->> 'title', v_item ->> 'language', v_item ->> 'content',
            coalesce(v_item -> 'provenance', '{}'::jsonb), (v_item ->> 'position')::integer, true
        ) on conflict (qualitative_project_id, project_version, source_id) do update set
            source_type=excluded.source_type,title=excluded.title,language=excluded.language,
            content=excluded.content,provenance=excluded.provenance,position=excluded.position,
            included_in_version=true;
    end loop;
    update public.qualitative_segments set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'segments') loop
        insert into public.qualitative_segments (
            segment_id, qualitative_project_id, project_version, source_id,
            start_offset, end_offset, exact_text_snapshot, speaker_label, included_in_version
        ) values (
            (v_item ->> 'segment_id')::uuid,v_id,v_version,(v_item ->> 'source_id')::uuid,
            (v_item ->> 'start_offset')::integer,(v_item ->> 'end_offset')::integer,
            v_item ->> 'exact_text_snapshot',v_item ->> 'speaker_label',true
        ) on conflict (qualitative_project_id, project_version, segment_id) do update set
            source_id=excluded.source_id,start_offset=excluded.start_offset,end_offset=excluded.end_offset,
            exact_text_snapshot=excluded.exact_text_snapshot,speaker_label=excluded.speaker_label,
            included_in_version=true;
    end loop;
    update public.qualitative_codes set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'codes') loop
        insert into public.qualitative_codes (
            qualitative_project_id, project_version, code_id, parent_code_id, code,
            label, definition, inclusion_rules, exclusion_rules, examples,
            color, position, included_in_version
        ) values (
            v_id,v_version,(v_item ->> 'code_id')::uuid,nullif(v_item ->> 'parent_code_id','')::uuid,
            v_item ->> 'code',v_item ->> 'label',v_item ->> 'definition',
            coalesce(v_item ->> 'inclusion_rules',''),coalesce(v_item ->> 'exclusion_rules',''),
            coalesce(v_item -> 'examples','[]'::jsonb),v_item ->> 'color',
            (v_item ->> 'position')::integer,true
        ) on conflict (qualitative_project_id, project_version, code_id) do update set
            parent_code_id=excluded.parent_code_id,code=excluded.code,label=excluded.label,
            definition=excluded.definition,inclusion_rules=excluded.inclusion_rules,
            exclusion_rules=excluded.exclusion_rules,examples=excluded.examples,color=excluded.color,
            position=excluded.position,included_in_version=true;
    end loop;
    update public.qualitative_codings set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'codings') loop
        insert into public.qualitative_codings (
            coding_id, qualitative_project_id, project_version, segment_id, code_id,
            coder_account_id, interpretation, confidence, included_in_version
        ) values (
            (v_item ->> 'coding_id')::uuid,v_id,v_version,(v_item ->> 'segment_id')::uuid,
            (v_item ->> 'code_id')::uuid,p_researcher_account_id,v_item ->> 'interpretation',
            coalesce(v_item ->> 'confidence','not_stated'),true
        ) on conflict (qualitative_project_id, project_version, coding_id) do update set
            segment_id=excluded.segment_id,code_id=excluded.code_id,
            interpretation=excluded.interpretation,confidence=excluded.confidence,
            included_in_version=true;
    end loop;
    update public.qualitative_memos set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'memos') loop
        insert into public.qualitative_memos (
            memo_id, qualitative_project_id, project_version, memo_type, title, body,
            linked_entity, author_account_id, included_in_version, created_at, updated_at
        ) values (
            (v_item ->> 'memo_id')::uuid,v_id,v_version,v_item ->> 'memo_type',
            v_item ->> 'title',v_item ->> 'body',v_item -> 'linked_entity',
            p_researcher_account_id,true,(v_item ->> 'created_at')::timestamptz,
            (v_item ->> 'updated_at')::timestamptz
        ) on conflict (qualitative_project_id, project_version, memo_id) do update set
            memo_type=excluded.memo_type,title=excluded.title,body=excluded.body,
            linked_entity=excluded.linked_entity,updated_at=excluded.updated_at,
            included_in_version=true;
    end loop;
    update public.qualitative_triangulation_links set included_in_version = false
     where qualitative_project_id = v_id and project_version = v_version;
    for v_item in select value from jsonb_array_elements(p_project -> 'triangulation_links') loop
        insert into public.qualitative_triangulation_links (
            link_id, qualitative_project_id, project_version, qualitative_evidence,
            quantitative_evidence, relationship, rationale, researcher_account_id,
            included_in_version, created_at
        ) values (
            (v_item ->> 'link_id')::uuid,v_id,v_version,v_item -> 'qualitative_evidence',
            v_item -> 'quantitative_evidence',v_item ->> 'relationship',v_item ->> 'rationale',
            p_researcher_account_id,true,(v_item ->> 'created_at')::timestamptz
        ) on conflict (qualitative_project_id, project_version, link_id) do update set
            qualitative_evidence=excluded.qualitative_evidence,
            quantitative_evidence=excluded.quantitative_evidence,relationship=excluded.relationship,
            rationale=excluded.rationale,included_in_version=true;
    end loop;
    return jsonb_build_object('qualitative_project_id',v_id,'version',v_version,
        'status',p_project ->> 'status','idempotent',false);
end;
$$;

create or replace function public.list_owned_qualitative_projects(p_researcher_account_id uuid)
returns table (qualitative_project_id uuid, version integer, code text, title text,
    status text, primary_language text, methodology text, study_id uuid, study_version integer,
    source_count bigint, segment_count bigint, code_count bigint, coding_count bigint,
    memo_count bigint, triangulation_count bigint, access_role text)
language sql stable security definer set search_path = public, pg_temp as $$
    select p.qualitative_project_id,p.version,p.code,p.title,p.status,p.primary_language,
           p.methodology,p.study_id,p.study_version,
           (select count(*) from public.qualitative_sources s where s.qualitative_project_id=p.qualitative_project_id and s.project_version=p.version and s.included_in_version),
           (select count(*) from public.qualitative_segments s where s.qualitative_project_id=p.qualitative_project_id and s.project_version=p.version and s.included_in_version),
           (select count(*) from public.qualitative_codes c where c.qualitative_project_id=p.qualitative_project_id and c.project_version=p.version and c.included_in_version),
           (select count(*) from public.qualitative_codings c where c.qualitative_project_id=p.qualitative_project_id and c.project_version=p.version and c.included_in_version),
           (select count(*) from public.qualitative_memos m where m.qualitative_project_id=p.qualitative_project_id and m.project_version=p.version and m.included_in_version),
           (select count(*) from public.qualitative_triangulation_links t where t.qualitative_project_id=p.qualitative_project_id and t.project_version=p.version and t.included_in_version),
           case when o.researcher_account_id is not null then 'owner' else c.role end
      from public.qualitative_projects p
      left join public.research_os_entity_ownership o
        on o.entity_type='qualitative_project' and o.entity_id=p.qualitative_project_id
       and o.researcher_account_id=p_researcher_account_id
      left join public.qualitative_project_collaborators c
        on c.qualitative_project_id=p.qualitative_project_id
       and c.researcher_account_id=p_researcher_account_id and c.status='active'
     where o.researcher_account_id is not null or c.researcher_account_id is not null
     order by p.updated_at desc;
$$;

create or replace function public.load_owned_qualitative_project(
    p_researcher_account_id uuid, p_qualitative_project_id uuid, p_version integer
)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select p.package_data from public.qualitative_projects p
      left join public.research_os_entity_ownership o
        on o.entity_type='qualitative_project' and o.entity_id=p.qualitative_project_id
       and o.researcher_account_id=p_researcher_account_id
      left join public.qualitative_project_collaborators c
        on c.qualitative_project_id=p.qualitative_project_id
       and c.researcher_account_id=p_researcher_account_id and c.status='active'
     where p.qualitative_project_id=p_qualitative_project_id and p.version=p_version
       and (o.researcher_account_id is not null or c.researcher_account_id is not null);
$$;

create or replace function public.list_owned_dialogue_transcripts(
    p_researcher_account_id uuid, p_study_id uuid, p_study_version integer
)
returns table (
    dialogue_session_id uuid, protocol_id uuid, protocol_version integer,
    dialogue_type text, title text, primary_language text,
    respondent_identifier text, started_at timestamptz, completed_at timestamptz,
    transcript_text text, turn_records jsonb
)
language sql stable security definer set search_path = public, pg_temp as $$
    select s.dialogue_session_id,s.protocol_id,s.protocol_version,s.dialogue_type,
           s.protocol_snapshot ->> 'title',s.protocol_snapshot ->> 'primary_language',
           a.user_identifier,s.started_at,s.completed_at,
           string_agg('[' || t.speaker || '] ' || t.content, E'\n\n' order by t.ordinal),
           jsonb_agg(jsonb_build_object(
               'turn_id',t.turn_id,'ordinal',t.ordinal,'speaker',t.speaker,
               'node_id',t.node_id,'content',t.content,'response_value',t.response_value,
               'recorded_at',t.recorded_at,'provider',t.provider,'model',t.model,
               'prompt_version',t.prompt_version,'prompt_sha256',t.prompt_sha256,
               'decision_snapshot',t.decision_snapshot
           ) order by t.ordinal)
      from public.research_dialogue_sessions s
      join public.research_os_accounts a on a.account_id=s.respondent_account_id
      join public.research_dialogue_turns t on t.dialogue_session_id=s.dialogue_session_id
     where s.researcher_account_id=p_researcher_account_id
       and s.study_id=p_study_id and s.study_version=p_study_version
       and s.status='completed'
     group by s.dialogue_session_id,s.protocol_id,s.protocol_version,s.dialogue_type,
              s.protocol_snapshot,a.user_identifier,s.started_at,s.completed_at
     order by s.completed_at,s.dialogue_session_id;
$$;

create or replace function public.set_qualitative_project_collaborator(
    p_owner_account_id uuid, p_qualitative_project_id uuid,
    p_collaborator_username text, p_role text, p_status text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_collaborator public.research_os_accounts%rowtype; v_now timestamptz:=clock_timestamp();
begin
    if p_role not in ('coder','reviewer') or p_status not in ('active','revoked') then
        raise exception 'Collaborator role or status is invalid';
    end if;
    if not exists (select 1 from public.research_os_entity_ownership o
        where o.entity_type='qualitative_project' and o.entity_id=p_qualitative_project_id
          and o.researcher_account_id=p_owner_account_id) then
        raise exception 'Qualitative project owner is required';
    end if;
    select * into v_collaborator from public.research_os_accounts
     where lower(username)=lower(btrim(p_collaborator_username))
       and role='researcher' and status='active';
    if not found or v_collaborator.account_id=p_owner_account_id then
        raise exception 'A different active researcher account is required';
    end if;
    insert into public.qualitative_project_collaborators (
        qualitative_project_id,researcher_account_id,role,status,
        granted_by_account_id,granted_at,revoked_at
    ) values (
        p_qualitative_project_id,v_collaborator.account_id,p_role,p_status,
        p_owner_account_id,v_now,case when p_status='revoked' then v_now end
    ) on conflict (qualitative_project_id,researcher_account_id) do update set
        role=excluded.role,status=excluded.status,granted_by_account_id=p_owner_account_id,
        granted_at=case when excluded.status='active' then v_now
            else public.qualitative_project_collaborators.granted_at end,
        revoked_at=case when excluded.status='revoked' then v_now end;
    return jsonb_build_object('qualitative_project_id',p_qualitative_project_id,
        'researcher_account_id',v_collaborator.account_id,
        'user_identifier',v_collaborator.user_identifier,'role',p_role,'status',p_status);
end;
$$;

create or replace function public.list_qualitative_project_collaborators(
    p_requester_account_id uuid, p_qualitative_project_id uuid
)
returns table (researcher_account_id uuid,username text,user_identifier text,role text,status text,
    granted_at timestamptz,revoked_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
    select c.researcher_account_id,a.username,a.user_identifier,c.role,c.status,c.granted_at,c.revoked_at
      from public.qualitative_project_collaborators c
      join public.research_os_accounts a on a.account_id=c.researcher_account_id
     where c.qualitative_project_id=p_qualitative_project_id
       and exists (select 1 from public.research_os_entity_ownership o
           where o.entity_type='qualitative_project' and o.entity_id=p_qualitative_project_id
             and o.researcher_account_id=p_requester_account_id)
     order by c.granted_at,c.researcher_account_id;
$$;

create or replace function public.add_qualitative_coding_record(
    p_researcher_account_id uuid,p_qualitative_project_id uuid,p_version integer,p_coding jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner boolean; v_role text;
begin
    select exists(select 1 from public.research_os_entity_ownership o
        where o.entity_type='qualitative_project' and o.entity_id=p_qualitative_project_id
          and o.researcher_account_id=p_researcher_account_id) into v_owner;
    select c.role into v_role from public.qualitative_project_collaborators c
     where c.qualitative_project_id=p_qualitative_project_id
       and c.researcher_account_id=p_researcher_account_id and c.status='active';
    if not v_owner and v_role not in ('coder','reviewer') then raise exception 'Qualitative coding access is required'; end if;
    if not exists (select 1 from public.qualitative_projects p
        where p.qualitative_project_id=p_qualitative_project_id and p.version=p_version) then
        raise exception 'Qualitative project version was not found';
    end if;
    if not exists (select 1 from public.qualitative_segments s
        where s.qualitative_project_id=p_qualitative_project_id and s.project_version=p_version
          and s.segment_id=(p_coding->>'segment_id')::uuid and s.included_in_version)
       or not exists (select 1 from public.qualitative_codes c
        where c.qualitative_project_id=p_qualitative_project_id and c.project_version=p_version
          and c.code_id=(p_coding->>'code_id')::uuid and c.included_in_version)
       or p_coding->>'confidence' not in ('high','medium','low','not_stated') then
        raise exception 'Coding must reference an included segment and code';
    end if;
    insert into public.qualitative_codings (
        coding_id,qualitative_project_id,project_version,segment_id,code_id,
        coder_account_id,interpretation,confidence,included_in_version
    ) values (
        (p_coding->>'coding_id')::uuid,p_qualitative_project_id,p_version,
        (p_coding->>'segment_id')::uuid,(p_coding->>'code_id')::uuid,
        p_researcher_account_id,p_coding->>'interpretation',p_coding->>'confidence',true
    );
    return jsonb_build_object('coding_id',p_coding->>'coding_id','coder_account_id',p_researcher_account_id);
end;
$$;

create or replace function public.list_qualitative_coding_records(
    p_researcher_account_id uuid,p_qualitative_project_id uuid,p_version integer
)
returns table (coding_id uuid,segment_id uuid,code_id uuid,coder_account_id uuid,
    coder_identifier text,interpretation text,confidence text,created_at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
    select c.coding_id,c.segment_id,c.code_id,c.coder_account_id,a.user_identifier,
           c.interpretation,c.confidence,c.created_at
      from public.qualitative_codings c
      join public.research_os_accounts a on a.account_id=c.coder_account_id
     where c.qualitative_project_id=p_qualitative_project_id and c.project_version=p_version
       and c.included_in_version
       and (exists(select 1 from public.research_os_entity_ownership o
              where o.entity_type='qualitative_project' and o.entity_id=p_qualitative_project_id
                and o.researcher_account_id=p_researcher_account_id)
            or exists(select 1 from public.qualitative_project_collaborators x
              where x.qualitative_project_id=p_qualitative_project_id
                and x.researcher_account_id=p_researcher_account_id and x.status='active'))
     order by c.created_at,c.coding_id;
$$;

revoke all on function public.save_owned_advanced_study_package(jsonb,uuid,text),
    public.allocate_experimental_group(uuid,integer,uuid,jsonb),
    public.join_study_by_invitation(uuid,uuid,jsonb),
    public.list_respondent_dialogue_measurements(uuid),
    public.get_respondent_dialogue_consent(uuid,uuid,text),
    public.start_respondent_dialogue_session(uuid,uuid,text,boolean),
    public.get_respondent_dialogue_session(uuid,uuid),
    public.append_scripted_dialogue_response(uuid,uuid,jsonb),
    public.prepare_ai_dialogue_turn(uuid,uuid,text),
    public.finish_ai_dialogue_turn(uuid,uuid,uuid,jsonb,text),
    public.discard_respondent_dialogue_session(uuid,uuid,text),
    public.save_owned_qualitative_project(jsonb,uuid),
    public.list_owned_qualitative_projects(uuid),
    public.load_owned_qualitative_project(uuid,uuid,integer)
    ,public.list_owned_dialogue_transcripts(uuid,uuid,integer)
    ,public.set_qualitative_project_collaborator(uuid,uuid,text,text,text)
    ,public.list_qualitative_project_collaborators(uuid,uuid)
    ,public.add_qualitative_coding_record(uuid,uuid,integer,jsonb)
    ,public.list_qualitative_coding_records(uuid,uuid,integer)
from public, anon, authenticated;
grant execute on function public.save_owned_advanced_study_package(jsonb,uuid,text),
    public.allocate_experimental_group(uuid,integer,uuid,jsonb),
    public.join_study_by_invitation(uuid,uuid,jsonb),
    public.list_respondent_dialogue_measurements(uuid),
    public.get_respondent_dialogue_consent(uuid,uuid,text),
    public.start_respondent_dialogue_session(uuid,uuid,text,boolean),
    public.get_respondent_dialogue_session(uuid,uuid),
    public.append_scripted_dialogue_response(uuid,uuid,jsonb),
    public.prepare_ai_dialogue_turn(uuid,uuid,text),
    public.finish_ai_dialogue_turn(uuid,uuid,uuid,jsonb,text),
    public.discard_respondent_dialogue_session(uuid,uuid,text),
    public.save_owned_qualitative_project(jsonb,uuid),
    public.list_owned_qualitative_projects(uuid),
    public.load_owned_qualitative_project(uuid,uuid,integer)
    ,public.list_owned_dialogue_transcripts(uuid,uuid,integer)
    ,public.set_qualitative_project_collaborator(uuid,uuid,text,text,text)
    ,public.list_qualitative_project_collaborators(uuid,uuid)
    ,public.add_qualitative_coding_record(uuid,uuid,integer,jsonb)
    ,public.list_qualitative_coding_records(uuid,uuid,integer)
to service_role;

-- The legacy two-argument join path cannot enforce randomized allocation.
-- Keep its historical definition intact for migration compatibility, but make
-- the three-argument atomic enrollment/allocation contract the only server path.
revoke execute on function public.join_study_by_invitation(uuid,uuid) from service_role;

commit;
