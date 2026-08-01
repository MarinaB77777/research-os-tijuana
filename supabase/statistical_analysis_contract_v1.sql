-- Research OS: owner-bound statistical-analysis dataset.
-- Apply after research_study_contract_v1.sql and collection_completion_contract_v2.sql.

create or replace function public.load_researcher_analysis_records(
    p_researcher_account_id uuid,
    p_study_id uuid,
    p_study_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_records jsonb;
begin
    if p_study_version < 1 or not exists (
        select 1
          from public.research_os_entity_ownership ownership
         where ownership.entity_type = 'study'
           and ownership.entity_id = p_study_id
           and ownership.researcher_account_id = p_researcher_account_id
    ) then
        raise exception 'Owned study version is required for statistical analysis';
    end if;

    select coalesce(jsonb_agg(record order by
        record ->> 'participant_id',
        (record ->> 'timepoint_ordinal')::integer,
        record ->> 'session_id',
        record ->> 'answered_at'
    ), '[]'::jsonb)
      into v_records
      from (
        select jsonb_build_object(
            'session_id', session.session_id,
            'participant_id', response.participant_id,
            'subject_link_id', session.subject_link_id,
            'study_id', session.study_id,
            'study_version', session.study_version,
            'group_id', session.group_id,
            'group_code', session.group_code,
            'timepoint_id', session.timepoint_id,
            'timepoint_code', session.timepoint_code,
            'timepoint_ordinal', session.timepoint_ordinal,
            'questionnaire_id', session.questionnaire_id,
            'questionnaire_version', session.questionnaire_version,
            'questionnaire_item_id', response.questionnaire_item_id,
            'question_id', response.question_id,
            'question_version', response.question_version,
            'question_code', response.code,
            'variable_key', response.code || ' · ' || response.questionnaire_item_id::text,
            'value', response.value,
            'scale_snapshot', response.scale_snapshot,
            'presented_at', response.presented_at,
            'answered_at', response.answered_at,
            'answered_utc_offset_minutes', response.answered_utc_offset_minutes,
            'global_time_reference', response.global_time_reference
        ) as record
          from public.research_response_records response
          join public.research_os_collection_sessions session
            on session.session_id::text = response.session_id
         where session.study_id = p_study_id
           and session.study_version = p_study_version
           and session.researcher_account_id = p_researcher_account_id
           and session.status = 'completed'
      ) completed_records;
    return v_records;
end;
$$;

revoke all on function public.load_researcher_analysis_records(uuid, uuid, integer)
    from public, anon, authenticated;
grant execute on function public.load_researcher_analysis_records(uuid, uuid, integer)
    to service_role;
