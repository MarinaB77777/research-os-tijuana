import { createHash, randomBytes, randomUUID } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bearerToken(req) {
    const authorization = req.headers.authorization || '';
    if (/^Bearer\s+/i.test(authorization)) {
        return authorization.replace(/^Bearer\s+/i, '').trim();
    }
    return req.headers['x-researcher-token'] || '';
}

function serviceHeaders(key, extra) {
    return {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        ...(extra || {})
    };
}

function sessionTokenHash(token) {
    return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

async function verifyAccess(req, expectedRole, supabaseUrl, supabaseAdminKey) {
    const token = bearerToken(req);
    if (!token) {
        return { ok: false, status: 401, error: 'Access token is required' };
    }
    if (!supabaseUrl || !supabaseAdminKey) {
        return { ok: false, status: 503, error: 'Server-side access verification is not configured' };
    }
    try {
        const tokenHash = sessionTokenHash(token);
        const response = await fetch(
            `${supabaseUrl}/rest/v1/research_os_auth_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=session_id,account_id,expires_at,revoked_at&limit=1`,
            { headers: serviceHeaders(supabaseAdminKey) }
        );
        if (!response.ok) {
            return { ok: false, status: response.status, error: `Access verification failed: ${await response.text()}` };
        }
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length !== 1) {
            return { ok: false, status: 401, error: 'Access token is invalid' };
        }
        const authSession = rows[0];
        if (authSession.revoked_at || !authSession.expires_at ||
            new Date(authSession.expires_at).getTime() <= Date.now()) {
            return { ok: false, status: 401, error: 'Access session is not active' };
        }
        const accountResponse = await fetch(
            `${supabaseUrl}/rest/v1/research_os_accounts?account_id=eq.${encodeURIComponent(authSession.account_id)}&select=account_id,username,user_identifier,role,status,created_by_account_id&limit=1`,
            { headers: serviceHeaders(supabaseAdminKey) }
        );
        if (!accountResponse.ok) {
            return { ok: false, status: accountResponse.status, error: `Account verification failed: ${await accountResponse.text()}` };
        }
        const accounts = await accountResponse.json();
        if (!Array.isArray(accounts) || accounts.length !== 1) {
            return { ok: false, status: 401, error: 'Account is not available' };
        }
        const principal = accounts[0];
        if (expectedRole && principal.role !== expectedRole) {
            return { ok: false, status: 403, error: `The ${expectedRole} role is required` };
        }
        if (principal.status !== 'active') {
            return { ok: false, status: 401, error: 'Account is not active' };
        }
        return { ok: true, principal, authSession, token, tokenHash };
    } catch (error) {
        return { ok: false, status: 500, error: `Access verification error: ${error.message}` };
    }
}

async function verifyResearcher(req, supabaseUrl, supabaseAdminKey) {
    return verifyAccess(req, 'researcher', supabaseUrl, supabaseAdminKey);
}

async function ownedEntityIds(entityType, researcherAccountId, supabaseUrl, supabaseAdminKey) {
    const response = await fetch(
        `${supabaseUrl}/rest/v1/research_os_entity_ownership?entity_type=eq.${encodeURIComponent(entityType)}&researcher_account_id=eq.${encodeURIComponent(researcherAccountId)}&select=entity_id`,
        { headers: serviceHeaders(supabaseAdminKey) }
    );
    if (!response.ok) {
        const error = new Error(`Entity ownership lookup failed: ${await response.text()}`);
        error.status = response.status;
        throw error;
    }
    return new Set((await response.json()).map(row => row.entity_id));
}

async function callSupabaseRpc(supabaseUrl, key, functionName, body) {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(body || {})
    });
    if (!response.ok) {
        const details = await response.text();
        const error = new Error(`Supabase RPC ${functionName} failed: ${details || response.statusText}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

export default async function handler(req, res) {
    const { url, method } = req;
    const requestUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const path = requestUrl.pathname.replace(/^\/api(?=\/|$)/, '');
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (path === '/auth/login' && method === 'POST') {
        const { username, password, expected_role: expectedRole } = req.body || {};
        if (expectedRole && !['researcher', 'respondent'].includes(expectedRole)) {
            return res.status(400).json({ ok: false, error: 'Invalid expected role' });
        }
        if (!username || !password) {
            return res.status(400).json({ ok: false, error: 'Username and password are required' });
        }
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Server-side authentication is not configured' });
        }
        let authenticated;
        try {
            const result = await callSupabaseRpc(supabaseUrl, supabaseAdminKey, 'authenticate_research_os_account', {
                p_username: username,
                p_password: password
            });
            authenticated = Array.isArray(result) ? result[0] : result;
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
        if (!authenticated?.account_id) {
            return res.status(401).json({ ok: false, error: 'Invalid username or password' });
        }
        if (expectedRole && authenticated.role !== expectedRole) {
            return res.status(403).json({ ok: false, error: `The ${expectedRole} role is required` });
        }
        const sessionToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        const sessionWrite = await fetch(`${supabaseUrl}/rest/v1/research_os_auth_sessions`, {
            method: 'POST',
            headers: serviceHeaders(supabaseAdminKey, {
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }),
            body: JSON.stringify({
                session_id: randomUUID(),
                account_id: authenticated.account_id,
                token_hash: sessionTokenHash(sessionToken),
                expires_at: expiresAt
            })
        });
        if (!sessionWrite.ok) {
            return res.status(sessionWrite.status).json({ ok: false, error: `Session creation failed: ${await sessionWrite.text()}` });
        }
        return res.status(200).json({
            ok: true,
            session_token: sessionToken,
            account_id: authenticated.account_id,
            role: authenticated.role,
            user_identifier: authenticated.user_identifier,
            expires_at: expiresAt
        });
    }

    if (path === '/auth/verify' && method === 'GET') {
        const access = await verifyAccess(req, null, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        return res.status(200).json({
            ok: true,
            account_id: access.principal.account_id,
            role: access.principal.role,
            user_identifier: access.principal.user_identifier,
            expires_at: access.authSession.expires_at
        });
    }

    if (path === '/auth/revoke' && method === 'POST') {
        const access = await verifyAccess(req, null, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const revokeResponse = await fetch(
            `${supabaseUrl}/rest/v1/research_os_auth_sessions?token_hash=eq.${encodeURIComponent(access.tokenHash)}`,
            {
                method: 'PATCH',
                headers: serviceHeaders(supabaseAdminKey, {
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }),
                body: JSON.stringify({
                    revoked_at: new Date().toISOString()
                })
            }
        );
        if (!revokeResponse.ok) {
            return res.status(revokeResponse.status).json({ ok: false, error: await revokeResponse.text() });
        }
        return res.status(200).json({ ok: true });
    }

    if (path === '/accounts' && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Server-side account storage is not configured' });
        }
        const { username, password, role, user_identifier: userIdentifier } = req.body || {};
        const normalizedUsername = String(username || '').trim();
        if (!['researcher', 'respondent'].includes(role) || !normalizedUsername || !password || !userIdentifier) {
            return res.status(400).json({ ok: false, error: 'Username, password, role and user identifier are required' });
        }
        if (!/^[A-Za-z0-9_.@+-]{3,128}$/.test(normalizedUsername)) {
            return res.status(400).json({
                ok: false,
                error: "Username must be 3 to 128 characters and contain only letters, numbers, '.', '_', '@', '+' or '-'"
            });
        }
        if (String(password).length < 10) {
            return res.status(400).json({ ok: false, error: 'Password must contain at least 10 characters' });
        }
        let creatorAccountId = null;
        const presentedToken = bearerToken(req);
        if (presentedToken) {
            const authorization = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
            if (!authorization.ok) return res.status(authorization.status).json({ ok: false, error: authorization.error });
            creatorAccountId = authorization.principal.account_id;
        } else {
            const bootstrapSecret = req.headers['x-research-os-bootstrap-secret'];
            if (role !== 'researcher' || !process.env.RESEARCH_OS_BOOTSTRAP_SECRET ||
                bootstrapSecret !== process.env.RESEARCH_OS_BOOTSTRAP_SECRET) {
                return res.status(403).json({ ok: false, error: 'Researcher authorization or first-account bootstrap secret is required' });
            }
            const existingResponse = await fetch(
                `${supabaseUrl}/rest/v1/research_os_accounts?role=eq.researcher&select=account_id&limit=1`,
                { headers: serviceHeaders(supabaseAdminKey) }
            );
            const existing = existingResponse.ok ? await existingResponse.json() : null;
            if (!existingResponse.ok) {
                return res.status(existingResponse.status).json({ ok: false, error: await existingResponse.text() });
            }
            if (Array.isArray(existing) && existing.length) {
                return res.status(409).json({ ok: false, error: 'The first researcher already exists; sign in as a researcher to create another account' });
            }
        }
        try {
            const result = await callSupabaseRpc(supabaseUrl, supabaseAdminKey, 'create_research_os_account', {
                p_username: normalizedUsername,
                p_password: password,
                p_role: role,
                p_user_identifier: userIdentifier,
                p_created_by_account_id: creatorAccountId
            });
            const account = Array.isArray(result) ? result[0] : result;
            return res.status(201).json({ ok: true, ...account });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Query-string token verification is intentionally disabled: URLs leak into
    // history and logs. Login uses POST /api/auth/login and immediately cleans the URL.
    if (path === '/verify') {
        return res.status(410).json({
            valid: false,
            error: 'Use POST /api/auth/login; tokens are not verified in query strings'
        });
    }

    // Legacy browser-authored consent records are no longer accepted. Consent
    // must be resolved from the questionnaire version and accepted through the
    // atomic respondent endpoint below.
    if (path === '/pilot/accounts/start-session' && method === 'POST') {
        return res.status(410).json({
            ok: false,
            error: 'Use the questionnaire consent endpoint; browser-authored consent records are not accepted'
        });
    }

    // Участник не создает локальную поддельную учетную запись: его account_id
    // всегда равен идентичности подтвержденного respondent-токена.
    if (path === '/pilot/accounts' && method === 'POST') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        return res.status(200).json({ ok: true, account_id: access.principal.user_identifier });
    }

    if (path.startsWith('/pilot/accounts/') && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const accountId = decodeURIComponent(path.slice('/pilot/accounts/'.length));
        if (accountId !== access.principal.user_identifier) {
            return res.status(403).json({ ok: false, error: 'This respondent account is not accessible' });
        }
        return res.status(200).json({ ok: true, account_id: accountId });
    }

    // Legacy bank listing remains available to old internal tooling. The
    // participant cabinet uses /respondent/questionnaires and never treats a
    // question bank as a questionnaire.
    if (path.startsWith('/pilot/questionnaire-banks')) {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Questionnaire catalog is not configured' });
        }
        try {
            const rows = await callSupabaseRpc(supabaseUrl, supabaseAdminKey, 'list_question_banks', {});
            const banks = (Array.isArray(rows) ? rows : [])
                .filter(bank => bank.status === 'active')
                .map(bank => ({
                    id: bank.bank_id || bank.code,
                    version: bank.version,
                    enabled: true,
                    title_by_lang: typeof bank.title === 'object'
                        ? bank.title
                        : { ru: bank.title, es: bank.title, en: bank.title }
                }));
            return res.status(200).json({ ok: true, banks });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Legacy hard-coded consent text is intentionally retired.
    if (path.startsWith('/consent/')) {
        return res.status(410).json({
            ok: false,
            error: 'Consent is versioned and must be loaded from the respondent questionnaire endpoint'
        });
    }

    // Versioned consent registry for researchers. The system standard document
    // and the researcher's own special documents share one catalog.
    if (path === '/consents' && method === 'GET') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const requestedStatus = requestUrl.searchParams.get('status') || 'all';
        if (!['all', 'draft', 'trial', 'active'].includes(requestedStatus)) {
            return res.status(400).json({ ok: false, error: 'Consent status filter is invalid' });
        }
        try {
            const documents = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_consent_documents_for_account',
                {
                    p_researcher_account_id: access.principal.account_id,
                    requested_status: requestedStatus
                }
            );
            return res.status(200).json({
                ok: true,
                consents: Array.isArray(documents) ? documents : []
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/consents/save' && method === 'POST') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const consentData = req.body;
        if (consentData?.schema !== 'research_os.consent_document' ||
            consentData?.schema_version !== 1 ||
            !UUID_V4.test(consentData?.consent_id || '') ||
            !Number.isInteger(consentData?.version) ||
            consentData.version < 1 ||
            consentData?.consent_kind !== 'special' ||
            consentData?.is_system !== false ||
            !['draft', 'trial', 'active'].includes(consentData?.status) ||
            !consentData?.title ||
            !consentData?.code ||
            !consentData?.primary_language ||
            !consentData?.texts ||
            Array.isArray(consentData.texts) ||
            typeof consentData.texts !== 'object') {
            return res.status(400).json({
                ok: false,
                error: 'Valid research_os.consent_document v1 special-consent package is required'
            });
        }
        try {
            const saved = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'save_owned_consent_document',
                {
                    consent_data: consentData,
                    p_researcher_account_id: access.principal.account_id
                }
            );
            const result = Array.isArray(saved) ? saved[0] : saved;
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const consentLoadMatch = path.match(/^\/consents\/([0-9a-f-]+)$/i);
    if (consentLoadMatch && method === 'GET') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const requestedVersion = Number(requestUrl.searchParams.get('version'));
        if (!UUID_V4.test(consentLoadMatch[1]) ||
            !Number.isInteger(requestedVersion) || requestedVersion < 1) {
            return res.status(400).json({ ok: false, error: 'Valid consent UUID and positive version are required' });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_consent_document_for_account',
                {
                    p_consent_id: consentLoadMatch[1],
                    p_consent_version: requestedVersion,
                    p_researcher_account_id: access.principal.account_id
                }
            );
            const consent = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!consent) {
                return res.status(404).json({ ok: false, error: 'Consent document not found' });
            }
            return res.status(200).json({ ok: true, consent });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // A respondent sees all active questionnaire versions owned by the
    // researcher who registered that account. No per-respondent consent setup
    // is required.
    if (path === '/respondent/questionnaires' && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        try {
            const questionnaires = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_respondent_questionnaires',
                { p_respondent_account_id: access.principal.account_id }
            );
            return res.status(200).json({
                ok: true,
                questionnaires: Array.isArray(questionnaires) ? questionnaires : []
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const respondentConsentMatch = path.match(
        /^\/respondent\/questionnaires\/([0-9a-f-]+)\/consent$/i
    );
    if (respondentConsentMatch && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const questionnaireVersion = Number(requestUrl.searchParams.get('version'));
        const language = String(requestUrl.searchParams.get('lang') || 'es').trim();
        if (!UUID_V4.test(respondentConsentMatch[1]) ||
            !Number.isInteger(questionnaireVersion) || questionnaireVersion < 1 || !language) {
            return res.status(400).json({
                ok: false,
                error: 'Questionnaire version and requested language are required'
            });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'get_respondent_questionnaire_consent',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_questionnaire_id: respondentConsentMatch[1],
                    p_questionnaire_version: questionnaireVersion,
                    p_requested_language: language
                }
            );
            const consent = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!consent) {
                return res.status(409).json({
                    ok: false,
                    error: 'This questionnaire does not have an active non-empty consent in an available language'
                });
            }
            return res.status(200).json({ ok: true, consent });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const respondentStartMatch = path.match(
        /^\/respondent\/questionnaires\/([0-9a-f-]+)\/start$/i
    );
    if (respondentStartMatch && method === 'POST') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const questionnaireVersion = Number(req.body?.questionnaire_version);
        const language = String(req.body?.language || 'es').trim();
        const explicitAcceptance = req.body?.explicit_acceptance === true;
        if (!UUID_V4.test(respondentStartMatch[1]) ||
            !Number.isInteger(questionnaireVersion) || questionnaireVersion < 1 ||
            !language || !explicitAcceptance) {
            return res.status(400).json({
                ok: false,
                error: 'Questionnaire version, language and explicit acceptance are required'
            });
        }
        try {
            const started = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'accept_consent_and_start_questionnaire',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_questionnaire_id: respondentStartMatch[1],
                    p_questionnaire_version: questionnaireVersion,
                    p_requested_language: language,
                    p_explicit_acceptance: true
                }
            );
            const result = Array.isArray(started) ? started[0] : started;
            if (!result?.session_id) {
                return res.status(500).json({
                    ok: false,
                    error: 'Consent acceptance did not create a collection session'
                });
            }
            return res.status(201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/respondent/sessions' && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        try {
            const sessions = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_respondent_collection_sessions',
                { p_respondent_account_id: access.principal.account_id }
            );
            return res.status(200).json({
                ok: true,
                sessions: Array.isArray(sessions) ? sessions : []
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const respondentSessionMatch = path.match(/^\/respondent\/sessions\/([0-9a-f-]+)$/i);
    if (respondentSessionMatch && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        if (!UUID_V4.test(respondentSessionMatch[1])) {
            return res.status(400).json({ ok: false, error: 'Valid collection session UUID is required' });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_respondent_collection_session',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_session_id: respondentSessionMatch[1]
                }
            );
            const session = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!session) {
                return res.status(404).json({ ok: false, error: 'Collection session not found' });
            }
            return res.status(200).json({ ok: true, session });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Каталог зарегистрированных банков используется конструкторами анкеты
    // и параметров. Он не содержит жёстко заданных тестовых сущностей.
    if (url.split('?')[0] === '/question-banks' && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        try {
            const rows = await callSupabaseRpc(supabaseUrl, supabaseAdminKey, 'list_question_banks', {});
            let banks = Array.isArray(rows) ? rows : [];
            if (bearerToken(req)) {
                const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
                if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
                const owned = await ownedEntityIds('question_bank', access.principal.account_id, supabaseUrl, supabaseAdminKey);
                banks = banks.filter(bank => bank.status === 'active' || owned.has(bank.bank_id));
            } else {
                banks = banks.filter(bank => bank.status === 'active');
            }
            return res.status(200).json({ ok: true, banks });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Версионированное определение параметра: научное определение, маркеры,
    // зависимости, время, измерения и явная вычислительная спецификация.
    if (url.split('?')[0] === '/parameters/save' && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase URL and server-side service-role key are required' });
        }
        const authorization = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!authorization.ok) {
            return res.status(authorization.status).json({ ok: false, error: authorization.error });
        }
        const parameterData = req.body;
        if (parameterData?.schema !== 'research_os.parameter_definition' ||
            parameterData?.schema_version !== 1 ||
            !parameterData?.parameter_id ||
            !parameterData?.global_time_reference ||
            parameterData?.computation?.unknown_policy !== 'propagate_unknown') {
            return res.status(400).json({
                ok: false,
                error: 'research_os.parameter_definition v1 with immutable identity, Global Time Reference and propagate_unknown policy is required'
            });
        }
        try {
            const saved = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'save_owned_parameter_definition',
                {
                    parameter_data: parameterData,
                    p_researcher_account_id: authorization.principal.account_id
                }
            );
            const result = Array.isArray(saved) ? saved[0] : saved;
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (url.split('?')[0] === '/parameters' && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        let requestedStatus = urlObj.searchParams.get('status') || 'active';
        if (!['all', 'draft', 'trial', 'active'].includes(requestedStatus)) {
            return res.status(400).json({ ok: false, error: 'Parameter status filter is invalid' });
        }
        let access = null;
        if (bearerToken(req) || requestedStatus !== 'active') {
            access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
            if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        }
        try {
            const rows = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_parameter_definitions',
                { requested_status: requestedStatus }
            );
            let parameters = Array.isArray(rows) ? rows : [];
            if (access) {
                const owned = await ownedEntityIds('parameter', access.principal.account_id, supabaseUrl, supabaseAdminKey);
                parameters = parameters.filter(parameter => parameter.status === 'active' || owned.has(parameter.parameter_id));
            } else {
                parameters = parameters.filter(parameter => parameter.status === 'active');
            }
            return res.status(200).json({ ok: true, parameters });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (url.startsWith('/parameters/') && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const parameterReference = decodeURIComponent(urlObj.pathname.slice('/parameters/'.length));
        const requestedVersion = urlObj.searchParams.get('version');
        if (!parameterReference || parameterReference === 'save') {
            return res.status(400).json({ ok: false, error: 'Parameter UUID or code is required' });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_parameter_definition',
                {
                    parameter_reference: parameterReference,
                    requested_version: requestedVersion ? Number(requestedVersion) : null
                }
            );
            const parameter = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!parameter) return res.status(404).json({ ok: false, error: 'Parameter definition not found' });
            if (parameter.status !== 'active') {
                const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
                if (!access.ok) return res.status(404).json({ ok: false, error: 'Parameter definition not found' });
                const owned = await ownedEntityIds('parameter', access.principal.account_id, supabaseUrl, supabaseAdminKey);
                if (!owned.has(parameter.parameter_id)) {
                    return res.status(404).json({ ok: false, error: 'Parameter definition not found' });
                }
            }
            return res.status(200).json({ ok: true, parameter });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Анкета владеет только составом, порядком и маршрутизацией; определения
    // вопросов остаются независимыми и ссылаются по UUID + версии.
    if (url.split('?')[0] === '/questionnaires/save' && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase URL and server-side service-role key are required' });
        }
        const authorization = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!authorization.ok) {
            return res.status(authorization.status).json({ ok: false, error: authorization.error });
        }
        const questionnaireData = req.body;
        if (questionnaireData?.schema !== 'research_os.questionnaire' ||
            questionnaireData?.schema_version !== 1 ||
            !UUID_V4.test(questionnaireData?.questionnaire_id || '') ||
            !questionnaireData?.global_time_reference ||
            !Array.isArray(questionnaireData?.items) ||
            !questionnaireData?.routing?.nodes ||
            !UUID_V4.test(questionnaireData?.consent?.consent_id || '') ||
            !Number.isInteger(questionnaireData?.consent?.consent_version) ||
            !['standard', 'special'].includes(questionnaireData?.consent?.mode)) {
            return res.status(400).json({
                ok: false,
                error: 'research_os.questionnaire v1 with identity, items, routing, consent binding and Global Time Reference is required'
            });
        }
        try {
            const saved = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'save_owned_questionnaire_with_consent',
                {
                    questionnaire_data: questionnaireData,
                    p_researcher_account_id: authorization.principal.account_id
                }
            );
            const result = Array.isArray(saved) ? saved[0] : saved;
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (url.split('?')[0] === '/questionnaires' && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        let requestedStatus = urlObj.searchParams.get('status') || 'active';
        if (!['all', 'draft', 'trial', 'active'].includes(requestedStatus)) {
            return res.status(400).json({ ok: false, error: 'Questionnaire status filter is invalid' });
        }
        let access = null;
        if (bearerToken(req) || requestedStatus !== 'active') {
            access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
            if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        }
        try {
            const rows = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_questionnaires',
                { requested_status: requestedStatus }
            );
            let questionnaires = Array.isArray(rows) ? rows : [];
            if (access) {
                const owned = await ownedEntityIds('questionnaire', access.principal.account_id, supabaseUrl, supabaseAdminKey);
                questionnaires = questionnaires.filter(questionnaire =>
                    questionnaire.status === 'active' || owned.has(questionnaire.questionnaire_id)
                );
            } else {
                questionnaires = questionnaires.filter(questionnaire => questionnaire.status === 'active');
            }
            return res.status(200).json({ ok: true, questionnaires });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (url.startsWith('/questionnaires/') && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const questionnaireReference = decodeURIComponent(urlObj.pathname.slice('/questionnaires/'.length));
        const requestedVersion = urlObj.searchParams.get('version');
        if (!questionnaireReference || questionnaireReference === 'save') {
            return res.status(400).json({ ok: false, error: 'Questionnaire UUID or code is required' });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_questionnaire_package',
                {
                    questionnaire_reference: questionnaireReference,
                    requested_version: requestedVersion ? Number(requestedVersion) : null
                }
            );
            const questionnaire = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!questionnaire) return res.status(404).json({ ok: false, error: 'Questionnaire not found' });
            if (questionnaire.status !== 'active') {
                const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
                if (!access.ok) return res.status(404).json({ ok: false, error: 'Questionnaire not found' });
                const owned = await ownedEntityIds('questionnaire', access.principal.account_id, supabaseUrl, supabaseAdminKey);
                if (!owned.has(questionnaire.questionnaire_id)) {
                    return res.status(404).json({ ok: false, error: 'Questionnaire not found' });
                }
            }
            return res.status(200).json({ ok: true, questionnaire });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    // Сохранение канонического банка вопросов в Supabase.
    // RPC выполняет запись банка, независимых версий вопросов и таблицы связей
    // в одной транзакции; вопрос не принадлежит эксклюзивно одному банку.
    if (url.startsWith('/question-banks/save') && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase URL and server-side service-role key are required' });
        }
        const authorization = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!authorization.ok) {
            return res.status(authorization.status).json({ ok: false, error: authorization.error });
        }

        const packageData = req.body;
        const questionMap = packageData?.questions;
        const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (packageData?.schema !== 'research_os.question_bank' || packageData?.schema_version !== 2) {
            return res.status(400).json({ ok: false, error: 'research_os.question_bank schema version 2 is required' });
        }
        if (!uuidV4.test(packageData.bank_id || '')) {
            return res.status(400).json({ ok: false, error: 'Valid bank_id UUID is required' });
        }
        if (!packageData.code || !packageData.title || !Number.isInteger(packageData.version) || packageData.version < 1) {
            return res.status(400).json({ ok: false, error: 'Bank code, title, and positive integer version are required' });
        }
        if (!['draft', 'trial', 'active'].includes(packageData.status)) {
            return res.status(400).json({ ok: false, error: 'Bank status must be draft, trial, or active' });
        }
        if (!questionMap || typeof questionMap !== 'object' || Array.isArray(questionMap)) {
            return res.status(400).json({ ok: false, error: 'Canonical questions object is required' });
        }

        const entries = Object.entries(questionMap);
        if (entries.length === 0) {
            return res.status(400).json({ ok: false, error: 'Question bank is empty' });
        }

        for (const [entryCode, question] of entries) {
            if (!uuidV4.test(question?.question_id || '') ||
                question?.code !== entryCode ||
                !question?.prompt ||
                !Number.isInteger(question?.version) ||
                question.version < 1 ||
                !question?.type ||
                !question?.scale ||
                !Array.isArray(question?.options) ||
                Object.prototype.hasOwnProperty.call(question, 'routing') ||
                question.options.some(option =>
                    option && typeof option === 'object' &&
                    (Object.prototype.hasOwnProperty.call(option, 'next') ||
                     Object.prototype.hasOwnProperty.call(option, 'target'))
                )) {
                return res.status(400).json({
                    ok: false,
                    error: `Question ${entryCode} does not satisfy the canonical identity/measurement contract or contains questionnaire routing`
                });
            }
        }

        try {
            const response = await fetch(`${supabaseUrl}/rest/v1/rpc/save_owned_question_bank_package`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseAdminKey,
                    'Authorization': `Bearer ${supabaseAdminKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify({
                    package_data: packageData,
                    p_researcher_account_id: authorization.principal.account_id
                })
            });

            if (!response.ok) {
                const details = await response.text();
                return res.status(response.status).json({
                    ok: false,
                    error: `Supabase transactional question-bank write failed: ${details || response.statusText}`
                });
            }

            const saved = await response.json();
            return res.status(200).json({
                ok: true,
                saved_count: entries.length,
                bank_id: packageData.bank_id,
                bank_version: packageData.version,
                database_result: saved
            });
        } catch (error) {
            console.error('Question bank save error:', error);
            return res.status(500).json({ ok: false, error: error.message });
        }
    }

    // Загрузка сохранённой версии банка без тестовых и жёстко заданных вопросов.
    if (url.startsWith('/question-banks/') && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const bankReference = decodeURIComponent(urlObj.pathname.slice('/question-banks/'.length));
        const requestedVersion = urlObj.searchParams.get('version');
        if (!bankReference || bankReference === 'save') {
            return res.status(400).json({ ok: false, error: 'Bank UUID or code is required' });
        }
        try {
            let access = null;
            if (bearerToken(req)) {
                access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
                if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
            }
            const loadFunction = access
                ? 'load_question_bank_package_for_account'
                : 'load_question_bank_package';
            const requestBody = {
                bank_reference: bankReference,
                requested_version: requestedVersion ? Number(requestedVersion) : null
            };
            if (access) requestBody.p_researcher_account_id = access.principal.account_id;
            const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${loadFunction}`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseAdminKey,
                    'Authorization': `Bearer ${supabaseAdminKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                const details = await response.text();
                return res.status(response.status).json({
                    ok: false,
                    error: `Supabase question-bank load failed: ${details || response.statusText}`
                });
            }
            const rows = await response.json();
            const packageData = Array.isArray(rows) ? rows[0] : rows;
            if (!packageData) {
                return res.status(404).json({ ok: false, error: 'Question bank not found' });
            }
            if (packageData.status !== 'active') {
                const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
                if (!access.ok) return res.status(404).json({ ok: false, error: 'Question bank not found' });
            }
            return res.status(200).json({ ok: true, ...packageData });
        } catch (error) {
            console.error('Question bank load error:', error);
            return res.status(500).json({ ok: false, error: error.message });
        }
    }

    // Сохранение ответов респондента в базу данных Supabase
    if (path.includes('/answers') && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase URL and server-side service-role key are required' });
        }
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const { response_records: responseRecords, domain_data_identity: sourceIdentity } = req.body || {};
        const pathMatch = path.match(/^\/pilot\/sessions\/([^/]+)\/answers/);
        const pathSessionId = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
        if (!pathSessionId || !sourceIdentity || sourceIdentity.session_id !== pathSessionId) {
            return res.status(400).json({ ok: false, error: 'Session identity is missing or inconsistent' });
        }
        if (!Array.isArray(responseRecords) || responseRecords.length === 0) {
            return res.status(400).json({ ok: false, error: 'Non-empty response_records array is required' });
        }
        const sessionResponse = await fetch(
            `${supabaseUrl}/rest/v1/research_os_collection_sessions?session_id=eq.${encodeURIComponent(pathSessionId)}&respondent_identifier=eq.${encodeURIComponent(access.principal.user_identifier)}&status=eq.active&select=session_id,global_time_reference,questionnaire_id,questionnaire_version&limit=1`,
            {
                headers: {
                    'apikey': supabaseAdminKey,
                    'Authorization': `Bearer ${supabaseAdminKey}`
                }
            }
        );
        if (!sessionResponse.ok) {
            return res.status(sessionResponse.status).json({ ok: false, error: `Collection session verification failed: ${await sessionResponse.text()}` });
        }
        const sessionRows = await sessionResponse.json();
        if (!Array.isArray(sessionRows) || sessionRows.length !== 1) {
            return res.status(403).json({ ok: false, error: 'The collection session is invalid or belongs to another respondent' });
        }
        const collectionSession = sessionRows[0];
        const sessionGlobalTimeReference = collectionSession.global_time_reference;
        if (sourceIdentity.global_time_reference !== sessionGlobalTimeReference) {
            return res.status(400).json({ ok: false, error: 'Global Time Reference does not match the collection session' });
        }
        if (sourceIdentity.questionnaire_id !== collectionSession.questionnaire_id ||
            Number(sourceIdentity.questionnaire_version) !== Number(collectionSession.questionnaire_version)) {
            return res.status(400).json({
                ok: false,
                error: 'Questionnaire identity does not match the collection session'
            });
        }
        for (const record of responseRecords) {
            if (record?.session_id !== pathSessionId ||
                !record?.response_id ||
                !record?.questionnaire_item_id ||
                !record?.question_id ||
                !record?.question_version ||
                !record?.bank_id ||
                !record?.bank_version ||
                !record?.code ||
                record?.value === undefined ||
                !record?.answered_at ||
                !record?.global_time_reference ||
                record.global_time_reference !== sessionGlobalTimeReference) {
                return res.status(400).json({ ok: false, error: 'A response record does not satisfy the identity/time contract' });
            }
        }
        try {
            const response = await fetch(`${supabaseUrl}/rest/v1/rpc/save_response_records`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseAdminKey,
                    'Authorization': `Bearer ${supabaseAdminKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify({
                    source_identity: sourceIdentity,
                    response_records: responseRecords
                })
            });
            if (!response.ok) {
                const details = await response.text();
                return res.status(response.status).json({
                    ok: false,
                    error: `Supabase response write failed: ${details || response.statusText}`
                });
            }
            const saved = await response.json();
            const completionWrite = await fetch(
                `${supabaseUrl}/rest/v1/research_os_collection_sessions?session_id=eq.${encodeURIComponent(pathSessionId)}&respondent_identifier=eq.${encodeURIComponent(access.principal.user_identifier)}`,
                {
                    method: 'PATCH',
                    headers: {
                        'apikey': supabaseAdminKey,
                        'Authorization': `Bearer ${supabaseAdminKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({
                        status: 'completed',
                        completed_at: new Date().toISOString()
                    })
                }
            );
            if (!completionWrite.ok) {
                return res.status(completionWrite.status).json({
                    ok: false,
                    error: `Answers were stored but session completion failed: ${await completionWrite.text()}`
                });
            }
            return res.status(200).json({ ok: true, saved_count: responseRecords.length, database_result: saved });
        } catch (error) {
            console.error('Supabase response write error:', error);
            return res.status(500).json({ ok: false, error: error.message });
        }
    }

    // Запуск сессии и генерация отчета
    if (path.includes('/run') || path.includes('/participant-report')) {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const sessionMatch = path.match(/^\/pilot\/sessions\/([^/]+)\/(?:run|participant-report)/);
        const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;
        if (!sessionId) {
            return res.status(400).json({ ok: false, error: 'Collection session is required' });
        }
        const ownedResponse = await fetch(
            `${supabaseUrl}/rest/v1/research_os_collection_sessions?session_id=eq.${encodeURIComponent(sessionId)}&respondent_identifier=eq.${encodeURIComponent(access.principal.user_identifier)}&select=session_id&limit=1`,
            {
                headers: {
                    'apikey': supabaseAdminKey,
                    'Authorization': `Bearer ${supabaseAdminKey}`
                }
            }
        );
        const ownedRows = ownedResponse.ok ? await ownedResponse.json() : [];
        if (!Array.isArray(ownedRows) || ownedRows.length !== 1) {
            return res.status(403).json({ ok: false, error: 'The collection session is not accessible' });
        }
        return res.status(501).json({
            ok: false,
            error: 'The calculation/report engine is not connected to this API route yet; no report was generated'
        });
    }

    return res.status(404).json({ error: 'Endpoint not found', url });
}
