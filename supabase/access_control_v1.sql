-- Research OS access-control migration v1
-- Apply after reviewing the existing public.app_users table.

begin;

alter table public.app_users
  add column if not exists status text not null default 'active',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists last_verified_at timestamptz;

alter table public.app_users
  drop constraint if exists app_users_status_check;

alter table public.app_users
  add constraint app_users_status_check
  check (status in ('active', 'revoked', 'expired'));

create unique index if not exists app_users_token_unique
  on public.app_users (token);

create index if not exists app_users_active_token_lookup
  on public.app_users (token, type, status)
  where revoked_at is null;

update public.app_users
set expires_at = case
  when type = 'researcher' then now() + interval '30 days'
  when type = 'respondent' then now() + interval '7 days'
  else now()
end
where expires_at is null;

alter table public.app_users enable row level security;
revoke all on table public.app_users from anon, authenticated;

create table if not exists public.research_os_collection_sessions (
  session_id uuid primary key,
  respondent_identifier text not null,
  study_id text not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'discarded', 'revoked')),
  consent_record jsonb not null,
  global_time_reference timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (session_id, respondent_identifier)
);

alter table public.research_os_collection_sessions enable row level security;
revoke all on table public.research_os_collection_sessions from anon, authenticated;

-- Catalog reads pass through the API so it can expose active definitions publicly
-- while keeping draft/trial definitions researcher-only.
revoke all on function public.list_question_banks() from anon, authenticated;
revoke all on function public.load_question_bank_package(text, integer) from anon, authenticated;
revoke all on function public.list_parameter_definitions(text) from anon, authenticated;
revoke all on function public.load_parameter_definition(text, integer) from anon, authenticated;
revoke all on function public.list_questionnaires(text) from anon, authenticated;
revoke all on function public.load_questionnaire_package(text, integer) from anon, authenticated;

commit;
