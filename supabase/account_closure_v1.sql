-- Research OS account closure and research-record preservation v1.
-- Apply after research_study_contract_v1.sql.

begin;

alter table public.research_os_accounts
    add column if not exists deleted_at timestamptz;

alter table public.research_os_accounts
    drop constraint if exists research_os_accounts_status_check;
alter table public.research_os_accounts
    add constraint research_os_accounts_status_check
    check (status in ('active', 'suspended', 'revoked', 'deleted'));

create or replace function public.close_research_os_account(
    p_account_id uuid,
    p_password text
)
returns table (closed_at timestamptz)
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
    v_account public.research_os_accounts%rowtype;
    v_closed_at timestamptz := clock_timestamp();
begin
    select a.* into v_account
      from public.research_os_accounts a
     where a.account_id = p_account_id
     for update;

    if not found or v_account.status <> 'active' then
        raise exception 'Account is not active';
    end if;
    if p_password is null
       or v_account.password_hash is distinct from crypt(p_password, v_account.password_hash) then
        raise exception 'Current password is incorrect';
    end if;

    -- Closing a researcher account revokes access only. Scientific entities,
    -- immutable authorship snapshots, ownership links, studies, sessions,
    -- consent acceptances and responses remain in place. The owner must remove
    -- any still-deletable material before closing the account; closure itself
    -- never cascades, transfers, archives or changes catalog permissions.
    update public.research_os_accounts
       set username = 'deleted_' || replace(account_id::text, '-', ''),
           user_identifier = 'DEL-' || replace(account_id::text, '-', ''),
           password_hash = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf', 12)),
           status = 'deleted',
           deleted_at = v_closed_at,
           updated_at = v_closed_at,
           password_changed_at = v_closed_at,
           failed_login_count = 0,
           locked_until = null
     where account_id = p_account_id;

    update public.research_os_auth_sessions
       set revoked_at = coalesce(revoked_at, v_closed_at)
     where account_id = p_account_id;

    return query select v_closed_at;
end;
$$;

revoke all on function public.close_research_os_account(uuid, text)
    from public, anon, authenticated;
grant execute on function public.close_research_os_account(uuid, text)
    to service_role;

commit;
