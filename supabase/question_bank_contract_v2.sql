begin;

create table if not exists public.question_banks (
    bank_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    status text not null check (status in ('draft', 'trial', 'active')),
    schema_version integer not null check (schema_version = 2),
    primary_language text not null,
    interface_language text,
    global_mode text,
    global_time_reference timestamptz not null,
    generated_at timestamptz not null,
    package_data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (bank_id, version),
    unique (code, version)
);

create table if not exists public.question_definitions (
    question_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    prompt text not null check (length(btrim(prompt)) > 0),
    question_type text not null,
    status text not null check (status in ('draft', 'trial', 'active')),
    definition jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (question_id, version),
    unique (code, version)
);

create table if not exists public.question_bank_items (
    bank_id uuid not null,
    bank_version integer not null,
    position integer not null check (position > 0),
    question_id uuid not null,
    question_version integer not null,
    created_at timestamptz not null default now(),
    primary key (bank_id, bank_version, position),
    unique (bank_id, bank_version, question_id, question_version),
    foreign key (bank_id, bank_version)
        references public.question_banks (bank_id, version)
        on delete cascade,
    foreign key (question_id, question_version)
        references public.question_definitions (question_id, version)
        on delete restrict
);

create table if not exists public.research_response_records (
    response_id uuid primary key,
    session_id text not null,
    participant_id text not null,
    bank_id uuid not null,
    bank_version integer not null,
    question_id uuid not null,
    question_version integer not null,
    code text not null,
    value jsonb not null,
    scale_snapshot jsonb,
    answered_at timestamptz not null,
    global_time_reference timestamptz not null,
    source_identity jsonb not null,
    created_at timestamptz not null default now(),
    unique (session_id, question_id, question_version),
    foreign key (bank_id, bank_version)
        references public.question_banks (bank_id, version)
        on delete restrict,
    foreign key (question_id, question_version)
        references public.question_definitions (question_id, version)
        on delete restrict
);

alter table public.question_banks enable row level security;
alter table public.question_definitions enable row level security;
alter table public.question_bank_items enable row level security;
alter table public.research_response_records enable row level security;

create or replace function public.save_question_bank_package(package_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_bank_id uuid;
    v_bank_version integer;
    v_existing_status text;
    v_existing_package jsonb;
    v_code text;
    v_question jsonb;
    v_question_id uuid;
    v_question_version integer;
    v_existing_definition jsonb;
    v_position integer;
begin
    if package_data ->> 'schema' is distinct from 'research_os.question_bank'
       or (package_data ->> 'schema_version')::integer is distinct from 2 then
        raise exception 'research_os.question_bank schema version 2 is required';
    end if;
    if package_data #>> '{reuse_policy,permission}' not in
       ('attribution_permitted', 'permission_required')
       or (package_data #>> '{reuse_policy,attribution_required}')::boolean is distinct from true
       or (package_data #>> '{reuse_policy,ownership_retained_by_author}')::boolean is distinct from true then
        raise exception 'A valid reuse policy with retained authorship and required attribution is required';
    end if;

    v_bank_id := (package_data ->> 'bank_id')::uuid;
    v_bank_version := (package_data ->> 'version')::integer;

    if jsonb_typeof(package_data -> 'questions') is distinct from 'object'
       or jsonb_typeof(package_data -> 'question_order') is distinct from 'array'
       or jsonb_array_length(package_data -> 'question_order') = 0 then
        raise exception 'questions object and non-empty question_order array are required';
    end if;
    if package_data ->> 'status' = 'active' and exists (
        select 1
          from jsonb_each(package_data -> 'questions') q
         where q.value ->> 'status' <> 'active'
    ) then
        raise exception 'An active bank may contain only active question versions';
    end if;
    if package_data ->> 'status' = 'trial' and exists (
        select 1
          from jsonb_each(package_data -> 'questions') q
         where q.value ->> 'status' = 'draft'
    ) then
        raise exception 'A trial bank may not contain draft question versions';
    end if;

    select status, package_data
      into v_existing_status, v_existing_package
      from public.question_banks
     where bank_id = v_bank_id and version = v_bank_version
     for update;

    if found and v_existing_status in ('trial', 'active') then
        if v_existing_package = package_data then
            return jsonb_build_object(
                'bank_id', v_bank_id,
                'bank_version', v_bank_version,
                'saved_count', jsonb_array_length(package_data -> 'question_order'),
                'idempotent', true
            );
        end if;
        raise exception 'Bank version % is immutable in status %; create a new version',
            v_bank_version, v_existing_status;
    end if;

    insert into public.question_banks (
        bank_id, version, code, title, status, schema_version,
        primary_language, interface_language, global_mode,
        global_time_reference, generated_at, package_data, updated_at
    ) values (
        v_bank_id,
        v_bank_version,
        package_data ->> 'code',
        package_data ->> 'title',
        package_data ->> 'status',
        (package_data ->> 'schema_version')::integer,
        package_data ->> 'primary_language',
        package_data ->> 'interface_language',
        package_data ->> 'global_mode',
        (package_data ->> 'global_time_reference')::timestamptz,
        (package_data ->> 'generated_at')::timestamptz,
        package_data,
        now()
    )
    on conflict (bank_id, version) do update set
        code = excluded.code,
        title = excluded.title,
        status = excluded.status,
        schema_version = excluded.schema_version,
        primary_language = excluded.primary_language,
        interface_language = excluded.interface_language,
        global_mode = excluded.global_mode,
        global_time_reference = excluded.global_time_reference,
        generated_at = excluded.generated_at,
        package_data = excluded.package_data,
        updated_at = now();

    delete from public.question_bank_items
     where bank_id = v_bank_id and bank_version = v_bank_version;

    v_position := 0;
    for v_code in
        select jsonb_array_elements_text(package_data -> 'question_order')
    loop
        v_position := v_position + 1;
        v_question := package_data -> 'questions' -> v_code;
        if v_question is null or jsonb_typeof(v_question) is distinct from 'object' then
            raise exception 'question_order references missing question %', v_code;
        end if;
        if v_question ->> 'code' is distinct from v_code then
            raise exception 'Question key % does not match its code', v_code;
        end if;
        if v_question ? 'routing'
           or exists (
               select 1
                 from jsonb_array_elements(coalesce(v_question -> 'options', '[]'::jsonb)) option_value
                where option_value ? 'next' or option_value ? 'target'
           ) then
            raise exception 'Question % contains questionnaire routing; transitions belong to research_os.questionnaire',
                v_code;
        end if;

        v_question_id := (v_question ->> 'question_id')::uuid;
        v_question_version := (v_question ->> 'version')::integer;

        select definition
          into v_existing_definition
          from public.question_definitions
         where question_id = v_question_id and version = v_question_version
         for update;

        if found and v_existing_definition <> v_question then
            raise exception 'Question % version % already exists with a different definition; increment its version',
                v_question_id, v_question_version;
        end if;

        insert into public.question_definitions (
            question_id, version, code, prompt, question_type,
            status, definition, updated_at
        ) values (
            v_question_id,
            v_question_version,
            v_code,
            v_question ->> 'prompt',
            v_question ->> 'type',
            v_question ->> 'status',
            v_question,
            now()
        )
        on conflict (question_id, version) do nothing;

        insert into public.question_bank_items (
            bank_id, bank_version, position, question_id, question_version
        ) values (
            v_bank_id, v_bank_version, v_position,
            v_question_id, v_question_version
        );
    end loop;

    if v_position <> jsonb_object_length(package_data -> 'questions') then
        raise exception 'question_order and questions must contain the same questions exactly once';
    end if;

    return jsonb_build_object(
        'bank_id', v_bank_id,
        'bank_version', v_bank_version,
        'saved_count', v_position,
        'idempotent', false
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
    v_session_id text;
    v_saved integer := 0;
begin
    if jsonb_typeof(source_identity) is distinct from 'object'
       or jsonb_typeof(response_records) is distinct from 'array'
       or jsonb_array_length(response_records) = 0 then
        raise exception 'Source identity and non-empty response-record array are required';
    end if;

    v_session_id := source_identity ->> 'session_id';
    if v_session_id is null
       or source_identity ->> 'global_time_reference' is null
       or source_identity ->> 'collection_started_at' is null
       or source_identity ->> 'collection_finished_at' is null then
        raise exception 'Source identity lacks session or global-time fields';
    end if;

    for v_record in select value from jsonb_array_elements(response_records)
    loop
        if v_record ->> 'session_id' is distinct from v_session_id then
            raise exception 'Response session does not match source identity';
        end if;
        if not exists (
            select 1
              from public.question_bank_items qbi
             where qbi.bank_id = (v_record ->> 'bank_id')::uuid
               and qbi.bank_version = (v_record ->> 'bank_version')::integer
               and qbi.question_id = (v_record ->> 'question_id')::uuid
               and qbi.question_version = (v_record ->> 'question_version')::integer
        ) then
            raise exception 'Response references a question/version not present in the stated bank/version';
        end if;

        insert into public.research_response_records (
            response_id, session_id, participant_id,
            bank_id, bank_version, question_id, question_version,
            code, value, scale_snapshot, answered_at,
            global_time_reference, source_identity
        ) values (
            (v_record ->> 'response_id')::uuid,
            v_session_id,
            v_record ->> 'participant_id',
            (v_record ->> 'bank_id')::uuid,
            (v_record ->> 'bank_version')::integer,
            (v_record ->> 'question_id')::uuid,
            (v_record ->> 'question_version')::integer,
            v_record ->> 'code',
            v_record -> 'value',
            v_record -> 'scale',
            (v_record ->> 'answered_at')::timestamptz,
            (v_record ->> 'global_time_reference')::timestamptz,
            source_identity
        )
        on conflict (response_id) do nothing;
        v_saved := v_saved + 1;
    end loop;

    return jsonb_build_object('session_id', v_session_id, 'saved_count', v_saved);
end;
$$;

create or replace function public.attach_question_to_draft_bank(
    p_bank_id uuid,
    p_bank_version integer,
    p_question jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_package jsonb;
    v_status text;
    v_code text;
    v_order jsonb;
begin
    select package_data, status
      into v_package, v_status
      from public.question_banks
     where bank_id = p_bank_id and version = p_bank_version
     for update;

    if not found then
        raise exception 'Question bank/version not found';
    end if;
    if v_status <> 'draft' then
        raise exception 'Questions can be attached only to a draft bank version';
    end if;

    v_code := p_question ->> 'code';
    if v_code is null or p_question ->> 'question_id' is null then
        raise exception 'Canonical question code and question_id are required';
    end if;

    v_package := jsonb_set(v_package, array['questions', v_code], p_question, true);
    v_order := v_package -> 'question_order';
    if not exists (
        select 1 from jsonb_array_elements_text(v_order) value where value = v_code
    ) then
        v_package := jsonb_set(v_package, '{question_order}', v_order || to_jsonb(v_code), true);
    end if;
    v_package := jsonb_set(v_package, '{generated_at}', to_jsonb(now()::text), true);
    v_package := jsonb_set(v_package, '{global_time_reference}', to_jsonb(now()::text), true);

    return public.save_question_bank_package(v_package);
end;
$$;

create or replace function public.load_question_bank_package(
    bank_reference text,
    requested_version integer default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select qb.package_data
      from public.question_banks qb
     where qb.status = 'active'
       and coalesce(
           qb.package_data #>> '{reuse_policy,permission}',
           'attribution_permitted'
       ) = 'attribution_permitted'
       and (
           qb.code = upper(bank_reference)
           or (
               bank_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               and qb.bank_id = bank_reference::uuid
           )
       )
       and (requested_version is null or qb.version = requested_version)
     order by qb.version desc
     limit 1;
$$;

revoke all on function public.save_question_bank_package(jsonb) from public, anon, authenticated;
grant execute on function public.save_question_bank_package(jsonb) to service_role;

revoke all on function public.save_response_records(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_response_records(jsonb, jsonb) to service_role;

revoke all on function public.attach_question_to_draft_bank(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.attach_question_to_draft_bank(uuid, integer, jsonb) to service_role;

revoke all on function public.load_question_bank_package(text, integer) from public;
revoke all on function public.load_question_bank_package(text, integer) from anon, authenticated;
grant execute on function public.load_question_bank_package(text, integer) to service_role;

revoke all on public.question_banks from anon, authenticated;
revoke all on public.question_definitions from anon, authenticated;
revoke all on public.question_bank_items from anon, authenticated;
revoke all on public.research_response_records from anon, authenticated;

commit;
