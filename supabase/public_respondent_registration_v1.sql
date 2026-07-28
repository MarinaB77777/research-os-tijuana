-- Research OS public respondent registration v1.
-- Apply after access_control_v2.sql and consent_questionnaire_flow_v1.sql.
--
-- Respondent accounts are self-registered and are not owned by a researcher.
-- Questionnaire ownership determines the researcher for each collection session.

begin;

create or replace function public.register_research_os_respondent(
    p_username text,
    p_password text,
    p_session_id uuid,
    p_token_hash text,
    p_expires_at timestamptz
)
returns table (
    account_id uuid,
    username text,
    role text,
    user_identifier text,
    expires_at timestamptz
)
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_account public.research_os_accounts%rowtype;
    v_identifier text := 'RSP-' || replace(gen_random_uuid()::text, '-', '');
begin
    if p_username is null
       or length(btrim(p_username)) not between 3 and 128
       or btrim(p_username) !~ '^[A-Za-z0-9_.@+-]+$'
       or p_password is null
       or length(p_password) < 10
       or p_session_id is null
       or p_token_hash is null
       or p_token_hash !~ '^[0-9a-f]{64}$'
       or p_expires_at is null
       or p_expires_at <= clock_timestamp()
       or p_expires_at > clock_timestamp() + interval '24 hours' then
        raise exception 'Valid respondent registration and session fields are required';
    end if;

    begin
        insert into public.research_os_accounts (
            username,
            password_hash,
            role,
            user_identifier,
            created_by_account_id
        ) values (
            lower(btrim(p_username)),
            crypt(p_password, gen_salt('bf', 12)),
            'respondent',
            v_identifier,
            null
        )
        returning * into v_account;
    exception
        when unique_violation then
            raise exception 'Username is already registered';
    end;

    insert into public.research_os_auth_sessions (
        session_id,
        account_id,
        token_hash,
        expires_at
    ) values (
        p_session_id,
        v_account.account_id,
        p_token_hash,
        p_expires_at
    );

    return query select
        v_account.account_id,
        v_account.username,
        v_account.role,
        v_account.user_identifier,
        p_expires_at;
end;
$$;

create or replace function public.list_respondent_questionnaires(
    p_respondent_account_id uuid
)
returns table (
    questionnaire_id uuid,
    version integer,
    code text,
    title text,
    description text,
    primary_language text,
    consent_id uuid,
    consent_version integer,
    consent_title text,
    consent_mode text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select available.questionnaire_id,
           available.version,
           available.code,
           available.title,
           available.description,
           available.primary_language,
           available.consent_id,
           available.consent_version,
           available.consent_title,
           available.consent_mode
      from (
          select distinct on (q.questionnaire_id)
                 q.questionnaire_id,
                 q.version,
                 q.code,
                 q.title,
                 q.description,
                 q.primary_language,
                 b.consent_id,
                 b.consent_version,
                 c.title as consent_title,
                 b.consent_mode
            from public.research_os_accounts respondent
            cross join public.research_os_entity_ownership owner
            join public.research_os_accounts researcher
              on researcher.account_id = owner.researcher_account_id
             and researcher.role = 'researcher'
             and researcher.status = 'active'
            join public.questionnaires q
              on q.questionnaire_id = owner.entity_id
             and q.status = 'active'
            join public.questionnaire_consent_bindings b
              on b.questionnaire_id = q.questionnaire_id
             and b.questionnaire_version = q.version
            join public.consent_documents c
              on c.consent_id = b.consent_id
             and c.version = b.consent_version
             and c.status = 'active'
           where respondent.account_id = p_respondent_account_id
             and respondent.role = 'respondent'
             and respondent.status = 'active'
             and owner.entity_type = 'questionnaire'
           order by q.questionnaire_id, q.version desc
      ) available
     order by available.title;
$$;

create or replace function public.get_respondent_questionnaire_consent(
    p_respondent_account_id uuid,
    p_questionnaire_id uuid,
    p_questionnaire_version integer,
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
    select q.title as questionnaire_title,
           q.description,
           owner.researcher_account_id,
           c.consent_id,
           c.version as consent_version,
           c.title as consent_title,
           c.primary_language,
           c.texts
      into v_row
      from public.research_os_accounts respondent
      cross join public.research_os_entity_ownership owner
      join public.research_os_accounts researcher
        on researcher.account_id = owner.researcher_account_id
       and researcher.role = 'researcher'
       and researcher.status = 'active'
      join public.questionnaires q
        on q.questionnaire_id = owner.entity_id
       and q.questionnaire_id = p_questionnaire_id
       and q.version = p_questionnaire_version
       and q.status = 'active'
      join public.questionnaire_consent_bindings b
        on b.questionnaire_id = q.questionnaire_id
       and b.questionnaire_version = q.version
      join public.consent_documents c
        on c.consent_id = b.consent_id
       and c.version = b.consent_version
       and c.status = 'active'
     where respondent.account_id = p_respondent_account_id
       and respondent.role = 'respondent'
       and respondent.status = 'active'
       and owner.entity_type = 'questionnaire';
    if not found then
        return null;
    end if;

    v_language := case
        when nullif(btrim(v_row.texts ->> p_requested_language), '') is not null
            then p_requested_language
        else v_row.primary_language
    end;
    v_text := v_row.texts ->> v_language;
    if nullif(btrim(v_text), '') is null then
        return null;
    end if;

    return jsonb_build_object(
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version,
        'questionnaire_title', v_row.questionnaire_title,
        'questionnaire_description', v_row.description,
        'researcher_account_id', v_row.researcher_account_id,
        'consent_id', v_row.consent_id,
        'consent_version', v_row.consent_version,
        'consent_title', v_row.consent_title,
        'language', v_language,
        'text', v_text,
        'text_sha256', encode(digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex')
    );
end;
$$;

create or replace function public.accept_consent_and_start_questionnaire(
    p_respondent_account_id uuid,
    p_questionnaire_id uuid,
    p_questionnaire_version integer,
    p_requested_language text,
    p_explicit_acceptance boolean
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_respondent public.research_os_accounts%rowtype;
    v_researcher_account_id uuid;
    v_consent jsonb;
    v_session_id uuid := gen_random_uuid();
    v_acceptance_id uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_consent_record jsonb;
begin
    if p_explicit_acceptance is distinct from true then
        raise exception 'Explicit consent acceptance is required';
    end if;

    select * into v_respondent
      from public.research_os_accounts
     where account_id = p_respondent_account_id
       and role = 'respondent'
       and status = 'active'
     for share;
    if not found then
        raise exception 'An active respondent account is required';
    end if;

    select owner.researcher_account_id
      into v_researcher_account_id
      from public.research_os_entity_ownership owner
      join public.research_os_accounts researcher
        on researcher.account_id = owner.researcher_account_id
       and researcher.role = 'researcher'
       and researcher.status = 'active'
     where owner.entity_type = 'questionnaire'
       and owner.entity_id = p_questionnaire_id;
    if not found then
        raise exception 'The questionnaire does not have an active researcher owner';
    end if;

    v_consent := public.get_respondent_questionnaire_consent(
        p_respondent_account_id,
        p_questionnaire_id,
        p_questionnaire_version,
        p_requested_language
    );
    if v_consent is null
       or (v_consent ->> 'researcher_account_id')::uuid
          is distinct from v_researcher_account_id then
        raise exception 'Active questionnaire with a valid non-empty consent is required';
    end if;

    v_consent_record := jsonb_build_object(
        'consent_status', 'accepted',
        'consent_id', v_consent ->> 'consent_id',
        'consent_version', (v_consent ->> 'consent_version')::integer,
        'language', v_consent ->> 'language',
        'text_sha256', v_consent ->> 'text_sha256',
        'accepted_at', v_now,
        'acceptance_basis', 'authenticated_checkbox',
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version
    );

    insert into public.research_os_collection_sessions (
        session_id,
        respondent_account_id,
        researcher_account_id,
        respondent_identifier,
        study_id,
        questionnaire_id,
        questionnaire_version,
        status,
        consent_record,
        global_time_reference,
        started_at
    ) values (
        v_session_id,
        v_respondent.account_id,
        v_researcher_account_id,
        v_respondent.user_identifier,
        p_questionnaire_id::text,
        p_questionnaire_id,
        p_questionnaire_version,
        'active',
        v_consent_record,
        v_now,
        v_now
    );

    insert into public.consent_acceptances (
        acceptance_id,
        session_id,
        respondent_account_id,
        researcher_account_id,
        questionnaire_id,
        questionnaire_version,
        consent_id,
        consent_version,
        consent_language,
        consent_title_snapshot,
        consent_text_snapshot,
        consent_text_sha256,
        acceptance_basis,
        accepted_at
    ) values (
        v_acceptance_id,
        v_session_id,
        v_respondent.account_id,
        v_researcher_account_id,
        p_questionnaire_id,
        p_questionnaire_version,
        (v_consent ->> 'consent_id')::uuid,
        (v_consent ->> 'consent_version')::integer,
        v_consent ->> 'language',
        v_consent ->> 'consent_title',
        v_consent ->> 'text',
        v_consent ->> 'text_sha256',
        'authenticated_checkbox',
        v_now
    );

    update public.research_os_collection_sessions
       set consent_acceptance_id = v_acceptance_id
     where session_id = v_session_id;

    return jsonb_build_object(
        'session_id', v_session_id,
        'global_time_reference', v_now,
        'questionnaire_id', p_questionnaire_id,
        'questionnaire_version', p_questionnaire_version,
        'consent_acceptance_id', v_acceptance_id,
        'consent_id', v_consent ->> 'consent_id',
        'consent_version', (v_consent ->> 'consent_version')::integer,
        'consent_language', v_consent ->> 'language',
        'accepted_at', v_now
    );
end;
$$;

revoke all on function public.register_research_os_respondent(
    text, text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_research_os_respondent(
    text, text, uuid, text, timestamptz
) to service_role;

revoke all on function public.list_respondent_questionnaires(uuid)
    from public, anon, authenticated;
revoke all on function public.get_respondent_questionnaire_consent(
    uuid, uuid, integer, text
) from public, anon, authenticated;
revoke all on function public.accept_consent_and_start_questionnaire(
    uuid, uuid, integer, text, boolean
) from public, anon, authenticated;

grant execute on function public.list_respondent_questionnaires(uuid)
    to service_role;
grant execute on function public.get_respondent_questionnaire_consent(
    uuid, uuid, integer, text
) to service_role;
grant execute on function public.accept_consent_and_start_questionnaire(
    uuid, uuid, integer, text, boolean
) to service_role;

commit;
