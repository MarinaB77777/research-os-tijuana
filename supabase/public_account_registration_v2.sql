-- Research OS public account registration v2.
-- Apply after access_control_v2.sql and public_respondent_registration_v1.sql.
--
-- Researchers and respondents self-register. Registration creates the account
-- and its first short-lived authenticated session in one transaction. A public
-- caller cannot assign ownership, elevated privileges, or another creator.

begin;

create or replace function public.register_research_os_account(
    p_username text,
    p_password text,
    p_role text,
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
    v_identifier text;
begin
    if p_role is null
       or p_role not in ('researcher', 'respondent')
       or p_username is null
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
        raise exception 'Valid account registration and session fields are required';
    end if;

    v_identifier := case p_role
        when 'researcher' then 'RSR-'
        else 'RSP-'
    end || replace(gen_random_uuid()::text, '-', '');

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
            p_role,
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

revoke all on function public.register_research_os_account(
    text, text, text, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_research_os_account(
    text, text, text, uuid, text, timestamptz
) to service_role;

commit;
