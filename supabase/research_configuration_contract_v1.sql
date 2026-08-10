begin;

-- Parameter definitions are independent, versioned scientific entities.
create table if not exists public.parameter_definitions (
    parameter_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    name text not null check (length(btrim(name)) > 0),
    domain text not null check (length(btrim(domain)) > 0),
    status text not null check (status in ('draft', 'trial', 'active')),
    schema_version integer not null check (schema_version = 1),
    global_time_reference timestamptz not null,
    generated_at timestamptz not null,
    definition jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (parameter_id, version),
    unique (code, version)
);

-- A questionnaire owns composition, order and routing. Questions remain independent.
create table if not exists public.questionnaires (
    questionnaire_id uuid not null,
    version integer not null check (version > 0),
    code text not null check (code ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$'),
    title text not null check (length(btrim(title)) > 0),
    description text,
    status text not null check (status in ('draft', 'trial', 'active')),
    schema_version integer not null check (schema_version = 1),
    primary_language text not null,
    interface_language text,
    global_time_reference timestamptz not null,
    generated_at timestamptz not null,
    start_item_id uuid not null,
    package_data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (questionnaire_id, version),
    unique (code, version)
);

create table if not exists public.questionnaire_items (
    questionnaire_id uuid not null,
    questionnaire_version integer not null,
    item_id uuid not null,
    position integer not null check (position > 0),
    source_bank_id uuid not null,
    source_bank_version integer not null,
    question_id uuid not null,
    question_version integer not null,
    code text not null,
    definition_snapshot jsonb not null,
    created_at timestamptz not null default now(),
    primary key (questionnaire_id, questionnaire_version, item_id),
    unique (questionnaire_id, questionnaire_version, position),
    foreign key (questionnaire_id, questionnaire_version)
        references public.questionnaires (questionnaire_id, version) on delete cascade,
    foreign key (source_bank_id, source_bank_version)
        references public.question_banks (bank_id, version) on delete restrict,
    foreign key (question_id, question_version)
        references public.question_definitions (question_id, version) on delete restrict
);

create table if not exists public.questionnaire_routes (
    questionnaire_id uuid not null,
    questionnaire_version integer not null,
    item_id uuid not null,
    default_target text not null,
    rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
    created_at timestamptz not null default now(),
    primary key (questionnaire_id, questionnaire_version, item_id),
    foreign key (questionnaire_id, questionnaire_version, item_id)
        references public.questionnaire_items (questionnaire_id, questionnaire_version, item_id)
        on delete cascade
);

alter table public.parameter_definitions enable row level security;
alter table public.questionnaires enable row level security;
alter table public.questionnaire_items enable row level security;
alter table public.questionnaire_routes enable row level security;

create or replace function public.save_parameter_definition(parameter_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_version integer;
    v_status text;
    v_existing jsonb;
    v_measurement jsonb;
    v_dependency jsonb;
begin
    if parameter_data ->> 'schema' is distinct from 'research_os.parameter_definition'
       or (parameter_data ->> 'schema_version')::integer is distinct from 1 then
        raise exception 'research_os.parameter_definition schema version 1 is required';
    end if;
    v_id := (parameter_data ->> 'parameter_id')::uuid;
    v_version := (parameter_data ->> 'version')::integer;
    if v_version < 1
       or parameter_data ->> 'status' not in ('draft', 'trial', 'active')
       or nullif(btrim(parameter_data ->> 'name'), '') is null
       or nullif(btrim(parameter_data ->> 'domain'), '') is null
       or nullif(btrim(parameter_data ->> 'preliminary_definition'), '') is null then
        raise exception 'Parameter identity, status, domain and preliminary definition are required';
    end if;
    if jsonb_typeof(parameter_data -> 'observable_markers') is distinct from 'array'
       or jsonb_array_length(parameter_data -> 'observable_markers') = 0
       or jsonb_typeof(parameter_data -> 'measurements') is distinct from 'array'
       or jsonb_array_length(parameter_data -> 'measurements') = 0
       or jsonb_typeof(parameter_data #> '{computation,steps}') is distinct from 'array'
       or jsonb_array_length(parameter_data #> '{computation,steps}') = 0 then
        raise exception 'Observable markers, measurements and computation steps must be non-empty arrays';
    end if;
    if parameter_data #>> '{computation,unknown_policy}' is distinct from 'propagate_unknown' then
        raise exception 'Unknown policy must be propagate_unknown; Unknown cannot be converted to zero';
    end if;
    if (parameter_data #>> '{time_dependency,global_time_reference_required}')::boolean is distinct from true
       or parameter_data ->> 'global_time_reference' is null then
        raise exception 'Global Time Reference is mandatory';
    end if;

    for v_measurement in select value from jsonb_array_elements(parameter_data -> 'measurements')
    loop
        if not exists (
            select 1
              from public.question_bank_items qbi
             where qbi.bank_id = (v_measurement ->> 'bank_id')::uuid
               and qbi.bank_version = (v_measurement ->> 'bank_version')::integer
               and qbi.question_id = (v_measurement ->> 'question_id')::uuid
               and qbi.question_version = (v_measurement ->> 'question_version')::integer
        ) then
            raise exception 'Measurement references a question/version not present in its stated bank/version';
        end if;
        if parameter_data ->> 'status' = 'active'
           and jsonb_typeof(v_measurement -> 'scale_snapshot') is distinct from 'object' then
            raise exception 'An active parameter requires a scale snapshot for every measurement';
        end if;
    end loop;

    for v_dependency in
        select value from jsonb_array_elements(coalesce(parameter_data -> 'dependencies', '[]'::jsonb))
    loop
        if (v_dependency ->> 'parameter_id')::uuid = v_id
           or not exists (
               select 1 from public.parameter_definitions pd
                where pd.parameter_id = (v_dependency ->> 'parameter_id')::uuid
                  and pd.version = (v_dependency ->> 'parameter_version')::integer
           ) then
            raise exception 'A dependency must reference another registered parameter version';
        end if;
    end loop;

    select status, definition into v_status, v_existing
      from public.parameter_definitions
     where parameter_id = v_id and version = v_version
     for update;
    if found and v_status in ('trial', 'active') then
        if v_existing = parameter_data then
            return jsonb_build_object('parameter_id', v_id, 'parameter_version', v_version, 'idempotent', true);
        end if;
        raise exception 'Parameter version % is immutable in status %; create a new version', v_version, v_status;
    end if;

    insert into public.parameter_definitions (
        parameter_id, version, code, name, domain, status, schema_version,
        global_time_reference, generated_at, definition, updated_at
    ) values (
        v_id, v_version, parameter_data ->> 'code', parameter_data ->> 'name',
        parameter_data ->> 'domain', parameter_data ->> 'status',
        (parameter_data ->> 'schema_version')::integer,
        (parameter_data ->> 'global_time_reference')::timestamptz,
        (parameter_data ->> 'generated_at')::timestamptz,
        parameter_data, now()
    )
    on conflict (parameter_id, version) do update set
        code = excluded.code,
        name = excluded.name,
        domain = excluded.domain,
        status = excluded.status,
        global_time_reference = excluded.global_time_reference,
        generated_at = excluded.generated_at,
        definition = excluded.definition,
        updated_at = now();

    return jsonb_build_object('parameter_id', v_id, 'parameter_version', v_version, 'idempotent', false);
end;
$$;

create or replace function public.save_questionnaire_package(questionnaire_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_version integer;
    v_status text;
    v_existing jsonb;
    v_item jsonb;
    v_node jsonb;
    v_rule jsonb;
    v_snapshot jsonb;
    v_position integer := 0;
    v_item_id uuid;
    v_target text;
begin
    if questionnaire_data ->> 'schema' is distinct from 'research_os.questionnaire'
       or (questionnaire_data ->> 'schema_version')::integer is distinct from 1 then
        raise exception 'research_os.questionnaire schema version 1 is required';
    end if;
    v_id := (questionnaire_data ->> 'questionnaire_id')::uuid;
    v_version := (questionnaire_data ->> 'version')::integer;
    if v_version < 1
       or questionnaire_data ->> 'status' not in ('draft', 'trial', 'active')
       or nullif(btrim(questionnaire_data ->> 'title'), '') is null
       or jsonb_typeof(questionnaire_data -> 'items') is distinct from 'array'
       or jsonb_array_length(questionnaire_data -> 'items') = 0
       or jsonb_typeof(questionnaire_data #> '{routing,nodes}') is distinct from 'object' then
        raise exception 'Questionnaire identity, status, items and routing nodes are required';
    end if;

    select status, package_data into v_status, v_existing
      from public.questionnaires
     where questionnaire_id = v_id and version = v_version
     for update;
    if found and v_status in ('trial', 'active') then
        if v_existing = questionnaire_data then
            return jsonb_build_object('questionnaire_id', v_id, 'questionnaire_version', v_version, 'idempotent', true);
        end if;
        raise exception 'Questionnaire version % is immutable in status %; create a new version', v_version, v_status;
    end if;

    insert into public.questionnaires (
        questionnaire_id, version, code, title, description, status, schema_version,
        primary_language, interface_language, global_time_reference, generated_at,
        start_item_id, package_data, updated_at
    ) values (
        v_id, v_version, questionnaire_data ->> 'code', questionnaire_data ->> 'title',
        questionnaire_data ->> 'description', questionnaire_data ->> 'status',
        (questionnaire_data ->> 'schema_version')::integer,
        questionnaire_data ->> 'primary_language', questionnaire_data ->> 'interface_language',
        (questionnaire_data ->> 'global_time_reference')::timestamptz,
        (questionnaire_data ->> 'generated_at')::timestamptz,
        (questionnaire_data ->> 'start_item_id')::uuid,
        questionnaire_data, now()
    )
    on conflict (questionnaire_id, version) do update set
        code = excluded.code, title = excluded.title, description = excluded.description,
        status = excluded.status, primary_language = excluded.primary_language,
        interface_language = excluded.interface_language,
        global_time_reference = excluded.global_time_reference,
        generated_at = excluded.generated_at, start_item_id = excluded.start_item_id,
        package_data = excluded.package_data, updated_at = now();

    delete from public.questionnaire_routes
     where questionnaire_id = v_id and questionnaire_version = v_version;
    delete from public.questionnaire_items
     where questionnaire_id = v_id and questionnaire_version = v_version;

    for v_item in
        select value from jsonb_array_elements(questionnaire_data -> 'items')
    loop
        v_position := v_position + 1;
        v_item_id := (v_item ->> 'item_id')::uuid;
        if (v_item ->> 'position')::integer <> v_position then
            raise exception 'Questionnaire positions must be contiguous and ordered';
        end if;
        -- A questionnaire pins the complete immutable scientific definition,
        -- not a lossy hand-written subset. Identity belongs to the item
        -- reference; every other registered field (time, family, direction,
        -- provenance-bearing source context, and future compatible fields)
        -- remains in the snapshot.
        select (qd.definition - 'question_id' - 'version' - 'code') ||
               jsonb_build_object(
                   'definition_language', coalesce(
                       qd.definition ->> 'definition_language',
                       qb.primary_language
                   )
               )
          into v_snapshot
          from public.question_bank_items qbi
          join public.question_definitions qd
            on qd.question_id = qbi.question_id and qd.version = qbi.question_version
          join public.question_banks qb
            on qb.bank_id = qbi.bank_id and qb.version = qbi.bank_version
         where qbi.bank_id = (v_item ->> 'source_bank_id')::uuid
           and qbi.bank_version = (v_item ->> 'source_bank_version')::integer
           and qbi.question_id = (v_item ->> 'question_id')::uuid
           and qbi.question_version = (v_item ->> 'question_version')::integer;
        if not found then
            raise exception 'Questionnaire item references a question/version not present in its source bank/version';
        end if;
        if v_snapshot is distinct from v_item -> 'definition_snapshot' then
            raise exception 'Questionnaire item snapshot differs from the registered immutable question definition';
        end if;
        if questionnaire_data ->> 'status' = 'active'
           and v_item #>> '{definition_snapshot,status}' <> 'active' then
            raise exception 'An active questionnaire may contain only active question versions';
        end if;
        if questionnaire_data ->> 'status' = 'trial'
           and v_item #>> '{definition_snapshot,status}' = 'draft' then
            raise exception 'A trial questionnaire may not contain draft question versions';
        end if;

        insert into public.questionnaire_items (
            questionnaire_id, questionnaire_version, item_id, position,
            source_bank_id, source_bank_version, question_id, question_version,
            code, definition_snapshot
        ) values (
            v_id, v_version, v_item_id, v_position,
            (v_item ->> 'source_bank_id')::uuid,
            (v_item ->> 'source_bank_version')::integer,
            (v_item ->> 'question_id')::uuid,
            (v_item ->> 'question_version')::integer,
            v_item ->> 'code', v_item -> 'definition_snapshot'
        );
    end loop;

    if not exists (
        select 1 from public.questionnaire_items
         where questionnaire_id = v_id and questionnaire_version = v_version
           and item_id = (questionnaire_data ->> 'start_item_id')::uuid
    ) then
        raise exception 'start_item_id is not a questionnaire item';
    end if;
    if (
        select count(*)::integer
          from jsonb_object_keys(questionnaire_data #> '{routing,nodes}')
    ) <> v_position then
        raise exception 'Routing nodes and questionnaire items must have a one-to-one correspondence';
    end if;

    for v_item_id in
        select item_id from public.questionnaire_items
         where questionnaire_id = v_id and questionnaire_version = v_version
    loop
        v_node := questionnaire_data #> array['routing', 'nodes', v_item_id::text];
        if v_node is null or jsonb_typeof(v_node -> 'rules') is distinct from 'array' then
            raise exception 'Every questionnaire item requires one routing node';
        end if;
        if exists (
            select 1
              from jsonb_array_elements(v_node -> 'rules') rule_value
             group by rule_value -> 'value'
            having count(*) > 1
        ) then
            raise exception 'Routing conditions for an item must have unique response values';
        end if;
        v_target := v_node ->> 'default_target';
        if v_target not in ('next', 'end') and not exists (
            select 1 from public.questionnaire_items
             where questionnaire_id = v_id and questionnaire_version = v_version
               and item_id = v_target::uuid
        ) then
            raise exception 'Routing default target does not exist';
        end if;
        for v_rule in select value from jsonb_array_elements(v_node -> 'rules')
        loop
            v_target := v_rule ->> 'target';
            if v_rule ->> 'operator' <> 'equals' or not (v_rule ? 'value') then
                raise exception 'Questionnaire routing rules require equals operator and an explicit value';
            end if;
            if v_target not in ('next', 'end') and not exists (
                select 1 from public.questionnaire_items
                 where questionnaire_id = v_id and questionnaire_version = v_version
                   and item_id = v_target::uuid
            ) then
                raise exception 'Routing rule target does not exist';
            end if;
        end loop;
        insert into public.questionnaire_routes (
            questionnaire_id, questionnaire_version, item_id, default_target, rules
        ) values (v_id, v_version, v_item_id, v_node ->> 'default_target', v_node -> 'rules');
    end loop;

    return jsonb_build_object(
        'questionnaire_id', v_id,
        'questionnaire_version', v_version,
        'saved_item_count', v_position,
        'idempotent', false
    );
end;
$$;

drop function if exists public.list_question_banks();
create function public.list_question_banks()
returns table (
    bank_id uuid, version integer, code text, title text, status text,
    primary_language text, question_count bigint, reuse_permission text,
    global_time_reference timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
    select qb.bank_id, qb.version, qb.code, qb.title, qb.status,
           qb.primary_language, count(qbi.question_id) as question_count,
           coalesce(
               qb.package_data #>> '{reuse_policy,permission}',
               'attribution_permitted'
           ) as reuse_permission,
           qb.global_time_reference, qb.updated_at
      from public.question_banks qb
      left join public.question_bank_items qbi
        on qbi.bank_id = qb.bank_id and qbi.bank_version = qb.version
     group by qb.bank_id, qb.version, qb.code, qb.title, qb.status,
              qb.primary_language, qb.package_data, qb.global_time_reference,
              qb.updated_at
     order by qb.title, qb.version desc;
$$;

create or replace function public.list_parameter_definitions(requested_status text default 'all')
returns table (
    parameter_id uuid, version integer, code text, name text, domain text,
    status text, global_time_reference timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
    select pd.parameter_id, pd.version, pd.code, pd.name, pd.domain,
           pd.status, pd.global_time_reference, pd.updated_at
      from public.parameter_definitions pd
     where requested_status = 'all' or pd.status = requested_status
     order by pd.name, pd.version desc;
$$;

create or replace function public.load_parameter_definition(
    parameter_reference text,
    requested_version integer default null
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select pd.definition
      from public.parameter_definitions pd
     where (
         pd.code = upper(parameter_reference)
         or (
             parameter_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             and pd.parameter_id = parameter_reference::uuid
         )
     )
       and (requested_version is null or pd.version = requested_version)
     order by pd.version desc limit 1;
$$;

drop function if exists public.list_questionnaires(text);
create function public.list_questionnaires(requested_status text default 'all')
returns table (
    questionnaire_id uuid, version integer, code text, title text, status text,
    primary_language text, item_count bigint,
    global_time_reference timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
    select q.questionnaire_id, q.version, q.code, q.title, q.status,
           q.primary_language,
           count(qi.item_id) as item_count,
           q.global_time_reference, q.updated_at
      from public.questionnaires q
      left join public.questionnaire_items qi
        on qi.questionnaire_id = q.questionnaire_id
       and qi.questionnaire_version = q.version
     where requested_status = 'all' or q.status = requested_status
     group by q.questionnaire_id, q.version, q.code, q.title, q.status,
              q.primary_language,
              q.global_time_reference, q.updated_at
     order by q.title, q.version desc;
$$;

create or replace function public.load_questionnaire_package(
    questionnaire_reference text,
    requested_version integer default null
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
    select q.package_data
      from public.questionnaires q
     where (
         q.code = upper(questionnaire_reference)
         or (
             questionnaire_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             and q.questionnaire_id = questionnaire_reference::uuid
         )
     )
       and (requested_version is null or q.version = requested_version)
     order by q.version desc limit 1;
$$;

revoke all on function public.save_parameter_definition(jsonb) from public, anon, authenticated;
grant execute on function public.save_parameter_definition(jsonb) to service_role;
revoke all on function public.save_questionnaire_package(jsonb) from public, anon, authenticated;
grant execute on function public.save_questionnaire_package(jsonb) to service_role;
revoke all on function public.list_question_banks() from public;
revoke all on function public.list_question_banks() from anon, authenticated;
grant execute on function public.list_question_banks() to service_role;
revoke all on function public.list_parameter_definitions(text) from public;
revoke all on function public.list_parameter_definitions(text) from anon, authenticated;
grant execute on function public.list_parameter_definitions(text) to service_role;
revoke all on function public.load_parameter_definition(text, integer) from public;
revoke all on function public.load_parameter_definition(text, integer) from anon, authenticated;
grant execute on function public.load_parameter_definition(text, integer) to service_role;
revoke all on function public.list_questionnaires(text) from public;
revoke all on function public.list_questionnaires(text) from anon, authenticated;
grant execute on function public.list_questionnaires(text) to service_role;
revoke all on function public.load_questionnaire_package(text, integer) from public;
revoke all on function public.load_questionnaire_package(text, integer) from anon, authenticated;
grant execute on function public.load_questionnaire_package(text, integer) to service_role;

revoke all on public.parameter_definitions from anon, authenticated;
revoke all on public.questionnaires from anon, authenticated;
revoke all on public.questionnaire_items from anon, authenticated;
revoke all on public.questionnaire_routes from anon, authenticated;

commit;
