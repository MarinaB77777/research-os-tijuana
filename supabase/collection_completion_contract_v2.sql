-- Research OS: scientifically admissible questionnaire completion.
-- Apply after research_study_contract_v1.sql.
-- The function remains the single atomic boundary for response persistence and
-- completion of both the collection session and its assigned measurement.

alter table public.research_os_collection_sessions
    add column if not exists discarded_at timestamptz,
    add column if not exists discard_reason text;

create or replace function public.discard_response_session(
    p_session_id uuid,
    p_respondent_account_id uuid,
    p_reason text default 'participant_exit_before_completion'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session public.research_os_collection_sessions%rowtype;
    v_discarded_at timestamptz := clock_timestamp();
begin
    select * into v_session
      from public.research_os_collection_sessions
     where session_id = p_session_id
       and respondent_account_id = p_respondent_account_id
     for update;
    if not found then
        raise exception 'Collection session was not found for this respondent';
    end if;
    if v_session.status <> 'active' then
        return jsonb_build_object(
            'session_id', v_session.session_id,
            'session_status', v_session.status,
            'idempotent', true
        );
    end if;
    update public.research_os_collection_sessions
       set status = 'discarded',
           discarded_at = v_discarded_at,
           discard_reason = coalesce(nullif(btrim(p_reason), ''), 'participant_exit_before_completion')
     where session_id = v_session.session_id;
    update public.research_participant_measurements
       set status = 'missed'
     where participant_measurement_id = v_session.participant_measurement_id
       and collection_session_id = v_session.session_id
       and status = 'in_progress';
    return jsonb_build_object(
        'session_id', v_session.session_id,
        'session_status', 'discarded',
        'measurement_status', 'missed',
        'discarded_at', v_discarded_at
    );
end;
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
    v_questionnaire jsonb;
    v_route jsonb;
    v_item jsonb;
    v_next_item jsonb;
    v_node jsonb;
    v_rule jsonb;
    v_route_item_id text;
    v_current_item_id text;
    v_target text;
    v_response jsonb;
    v_route_index integer := 0;
    v_minimum_answered integer;
    v_saved integer := 0;
begin
    if jsonb_typeof(source_identity) is distinct from 'object'
       or jsonb_typeof(response_records) is distinct from 'array'
       or jsonb_array_length(response_records) = 0 then
        raise exception 'Source identity and non-empty response-record array are required';
    end if;
    if jsonb_typeof(source_identity -> 'route_item_ids') is distinct from 'array'
       or jsonb_array_length(source_identity -> 'route_item_ids') = 0 then
        raise exception 'A non-empty completed questionnaire route is required';
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
       or (source_identity ->> 'collection_started_at')::timestamptz
            is distinct from v_session.started_at
       or source_identity ->> 'collection_finished_at' is null
       or (source_identity ->> 'collection_finished_at')::timestamptz < v_session.started_at then
        raise exception 'Source identity does not match the study collection session';
    end if;

    select q.package_data into v_questionnaire
      from public.questionnaires q
     where q.questionnaire_id = v_session.questionnaire_id
       and q.version = v_session.questionnaire_version;
    if v_questionnaire is null then
        raise exception 'Session questionnaire version was not found';
    end if;
    v_minimum_answered := coalesce(
        (v_questionnaire #>> '{completion_policy,minimum_answered_items}')::integer,
        1
    );
    if v_minimum_answered < 1
       or jsonb_array_length(response_records) < v_minimum_answered then
        raise exception 'Completed route does not meet the minimum answered-item threshold';
    end if;
    if coalesce(
        (source_identity #>> '{completion_policy_snapshot,minimum_answered_items}')::integer,
        0
    ) is distinct from v_minimum_answered
       or coalesce(
        (source_identity #>> '{completion_policy_snapshot,require_terminal_route}')::boolean,
        false
    ) is distinct from true then
        raise exception 'Questionnaire completion-policy snapshot is missing or inconsistent';
    end if;

    v_route := source_identity -> 'route_item_ids';
    v_current_item_id := v_questionnaire ->> 'start_item_id';
    while v_current_item_id is distinct from 'end' loop
        if v_route_index >= jsonb_array_length(v_route)
           or v_route_index >= jsonb_array_length(v_questionnaire -> 'items')
           or v_route ->> v_route_index is distinct from v_current_item_id then
            raise exception 'Submitted route does not match questionnaire routing';
        end if;
        if exists (
            select 1
              from jsonb_array_elements(v_route) with ordinality prior(value, ordinal)
             where prior.ordinal <= v_route_index
               and prior.value #>> '{}' = v_current_item_id
        ) then
            raise exception 'Submitted questionnaire route contains a cycle';
        end if;

        select candidate.value into v_item
          from jsonb_array_elements(v_questionnaire -> 'items') candidate(value)
         where candidate.value ->> 'item_id' = v_current_item_id
         limit 1;
        if v_item is null then
            raise exception 'Submitted route contains an unknown questionnaire item';
        end if;
        v_response := null;
        select candidate.value into v_response
          from jsonb_array_elements(response_records) candidate(value)
         where candidate.value ->> 'questionnaire_item_id' = v_current_item_id
         limit 1;
        if coalesce((v_item ->> 'required')::boolean, true) and (
            v_response is null
            or not (v_response ? 'value')
            or v_response -> 'value' = 'null'::jsonb
            or (
                jsonb_typeof(v_response -> 'value') = 'string'
                and btrim(v_response #>> '{value}') = ''
            )
            or (
                jsonb_typeof(v_response -> 'value') = 'array'
                and jsonb_array_length(v_response -> 'value') = 0
            )
        ) then
            raise exception 'A required item on the completed route has no response';
        end if;

        v_node := v_questionnaire #> array['routing', 'nodes', v_current_item_id];
        if jsonb_typeof(v_node) is distinct from 'object' then
            raise exception 'Questionnaire routing node is missing';
        end if;
        v_target := coalesce(v_node ->> 'default_target', 'next');
        for v_rule in
            select value from jsonb_array_elements(coalesce(v_node -> 'rules', '[]'::jsonb))
        loop
            if v_rule ->> 'operator' = 'equals'
               and v_response is not null
               and (
                   v_response -> 'value' = v_rule -> 'value'
                   or (
                       jsonb_typeof(v_response -> 'value') = 'array'
                       and exists (
                           select 1 from jsonb_array_elements(v_response -> 'value') answer(value)
                            where answer.value = v_rule -> 'value'
                       )
                   )
               ) then
                v_target := v_rule ->> 'target';
                exit;
            end if;
        end loop;
        if v_target = 'next' then
            v_next_item := null;
            select candidate.value into v_next_item
              from jsonb_array_elements(v_questionnaire -> 'items') candidate(value)
             where (candidate.value ->> 'position')::integer >
                   (v_item ->> 'position')::integer
             order by (candidate.value ->> 'position')::integer
             limit 1;
            v_target := coalesce(v_next_item ->> 'item_id', 'end');
        end if;
        if v_target <> 'end' and not exists (
            select 1 from jsonb_array_elements(v_questionnaire -> 'items') candidate(value)
             where candidate.value ->> 'item_id' = v_target
        ) then
            raise exception 'Questionnaire route target does not exist';
        end if;
        v_current_item_id := v_target;
        v_route_index := v_route_index + 1;
        v_item := null;
    end loop;
    if v_route_index is distinct from jsonb_array_length(v_route) then
        raise exception 'Submitted route contains items after terminal completion';
    end if;
    if exists (
        select 1
          from jsonb_array_elements(response_records) response(value)
         where not exists (
             select 1 from jsonb_array_elements(v_route) route(value)
              where route.value #>> '{}' = response.value ->> 'questionnaire_item_id'
         )
    ) then
        raise exception 'Response records contain an item outside the completed route';
    end if;
    if exists (
        select 1
          from jsonb_array_elements(response_records) response(value)
         group by response.value ->> 'questionnaire_item_id'
        having count(*) > 1
    ) then
        raise exception 'A questionnaire item was answered more than once';
    end if;

    for v_record in select value from jsonb_array_elements(response_records)
    loop
        if (v_record ->> 'session_id')::uuid is distinct from v_session.session_id
           or v_record ->> 'participant_id' is distinct from v_session.respondent_identifier
           or v_record ->> 'questionnaire_item_id' is null
           or not (v_record ? 'value')
           or v_record -> 'value' = 'null'::jsonb
           or (
               jsonb_typeof(v_record -> 'value') = 'string'
               and btrim(v_record #>> '{value}') = ''
           )
           or (
               jsonb_typeof(v_record -> 'value') = 'array'
               and jsonb_array_length(v_record -> 'value') = 0
           )
           or v_record ->> 'presented_at' is null
           or v_record ->> 'answered_at' is null
           or (v_record ->> 'global_time_reference')::timestamptz
                is distinct from v_session.global_time_reference
           or (v_record ->> 'presented_at')::timestamptz >
              (v_record ->> 'answered_at')::timestamptz
           or (v_record ->> 'answered_at')::timestamptz >
              (source_identity ->> 'collection_finished_at')::timestamptz then
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
        );
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
        'session_id', v_session.session_id,
        'saved_count', v_saved,
        'route_item_ids', v_route,
        'session_status', 'completed',
        'measurement_status', 'completed'
    );
end;
$$;

revoke all on function public.save_response_records(jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function public.save_response_records(jsonb, jsonb)
    to service_role;
revoke all on function public.discard_response_session(uuid, uuid, text)
    from public, anon, authenticated;
grant execute on function public.discard_response_session(uuid, uuid, text)
    to service_role;
