import { createHash, randomBytes, randomUUID } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]*$/;
const QUESTION_SCALE_CONTRACTS = Object.freeze({
    single_choice: { level: 'nominal', type: 'single_select' },
    multiple_choice: { level: 'nominal', type: 'multiple_select' },
    dichotomous: { level: 'nominal', type: 'single_select' },
    likert_7: { level: 'ordinal', type: 'single_select', min: 1, max: 7, step: 1 },
    likert_5: { level: 'ordinal', type: 'single_select', min: 1, max: 5, step: 1 },
    frequency_scale: { level: 'ordinal', type: 'single_select' },
    nps_scale: { level: 'ordinal', type: 'single_select', min: 0, max: 10, step: 1 },
    discrete_count: { level: 'interval_ratio', type: 'numeric_input', step: 1 },
    continuous_slider: { level: 'interval_ratio', type: 'numeric_input', min: 0, max: 100, step: 1 },
    currency_metric: { level: 'interval_ratio', type: 'numeric_input' },
    percentage_share: { level: 'interval_ratio', type: 'numeric_input', min: 0, max: 100, step: 1, unit: '%' },
    short_string: { level: 'textual', type: 'text_input' },
    long_paragraph: { level: 'textual', type: 'text_input' }
});

function validQuestionScaleContract(question) {
    const scale = question?.scale || {};
    const contract = QUESTION_SCALE_CONTRACTS[String(scale.id || '')];
    if (!contract || contract.type !== question?.type || contract.level !== scale.psychometric_level) return false;
    for (const field of ['min', 'max', 'step']) {
        if (scale[field] !== null && scale[field] !== undefined && scale[field] !== '' && (typeof scale[field] !== 'number' || !Number.isFinite(scale[field]))) return false;
        if (Object.prototype.hasOwnProperty.call(contract, field) && scale[field] !== contract[field]) return false;
    }
    if (Object.prototype.hasOwnProperty.call(contract, 'unit') && String(scale.unit || '') !== contract.unit) return false;
    if (scale.min !== null && scale.min !== undefined && scale.min !== '' &&
        scale.max !== null && scale.max !== undefined && scale.max !== '' && !(Number(scale.max) > Number(scale.min))) return false;
    if (scale.step !== null && scale.step !== undefined && scale.step !== '' && !(Number(scale.step) > 0)) return false;
    if (contract === QUESTION_SCALE_CONTRACTS.discrete_count && !Number.isInteger(Number(scale.step))) return false;
    const values = Array.isArray(question.options) ? question.options.map(option => Number(option?.value)) : [];
    if (['likert_5', 'likert_7', 'nps_scale'].includes(scale.id)) {
        const expected = Array.from({ length: contract.max - contract.min + 1 }, (_, index) => contract.min + index);
        if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) return false;
    }
    if (scale.id === 'dichotomous' && (values.length !== 2 || new Set(values).size !== 2 || !values.includes(0) || !values.includes(1))) return false;
    if (scale.id === 'frequency_scale' && (values.length < 2 || values.some((value, index) => !Number.isFinite(value) || index > 0 && value <= values[index - 1]))) return false;
    return true;
}
const UPSTREAM_TIMEOUT_MS = (() => {
    const configured = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 8000;
})();
const AI_UPSTREAM_TIMEOUT_MS = (() => {
    const configured = Number.parseInt(process.env.AI_UPSTREAM_TIMEOUT_MS || '60000', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 60000;
})();
const MAX_AI_REQUEST_BYTES = 250000;
const AI_TASK_MODELS = Object.freeze({
    analyzer: Object.freeze({
        groq: new Set(['openai/gpt-oss-20b']),
        gemini: new Set(['gemini-3.6-flash', 'gemini-3.5-flash-lite'])
    }),
    translator: Object.freeze({
        groq: new Set(['openai/gpt-oss-20b']),
        gemini: new Set(['gemini-3.6-flash', 'gemini-3.5-flash-lite'])
    })
});
const DEFAULT_AI_PREFERENCES = Object.freeze({
    analyzer: Object.freeze({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
    translator: Object.freeze({ provider: 'groq', model: 'openai/gpt-oss-20b' })
});

function sameQuestionnaireValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function hasQuestionnaireAnswer(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
}

function validateQuestionnaireAnswer(item, value) {
    const definition = item?.definition_snapshot || {};
    const type = definition.type || 'single_select';
    const options = Array.isArray(definition.options) ? definition.options : [];
    const allowed = candidate => options.some(option => sameQuestionnaireValue(candidate, option?.value));
    if (type === 'single_select') {
        if (Array.isArray(value) || !allowed(value)) throw new Error(`Answer for ${item.item_id} is not an allowed single-selection value`);
        return;
    }
    if (type === 'multiple_select') {
        if (!Array.isArray(value) || !value.length || value.some(candidate => !allowed(candidate)) ||
            new Set(value.map(candidate => JSON.stringify(candidate))).size !== value.length) {
            throw new Error(`Answer for ${item.item_id} is not a valid set of allowed selections`);
        }
        return;
    }
    if (type === 'text_input') {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Answer for ${item.item_id} must be non-empty text`);
        if (Number.isInteger(definition.max_length) && definition.max_length > 0 && value.length > definition.max_length) {
            throw new Error(`Answer for ${item.item_id} exceeds its maximum text length`);
        }
        return;
    }
    if (type === 'numeric_input') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Answer for ${item.item_id} must be a finite number`);
        const scale = definition.scale || {};
        const hasMin = scale.min !== null && scale.min !== undefined && scale.min !== '';
        const hasMax = scale.max !== null && scale.max !== undefined && scale.max !== '';
        const hasStep = scale.step !== null && scale.step !== undefined && scale.step !== '';
        const min = Number(scale.min), max = Number(scale.max), step = Number(scale.step);
        if ((hasMin && value < min) || (hasMax && value > max)) throw new Error(`Answer for ${item.item_id} is outside the scale range`);
        if (hasStep && step > 0) {
            const origin = hasMin ? min : 0;
            const quotient = (value - origin) / step;
            if (Math.abs(quotient - Math.round(quotient)) > 1e-9) throw new Error(`Answer for ${item.item_id} does not follow the scale step`);
        }
        return;
    }
    throw new Error(`Questionnaire item ${item.item_id} has an unsupported response type`);
}

function validateQuestionnaireGraph(questionnaire) {
    const items = Array.isArray(questionnaire?.items)
        ? [...questionnaire.items].sort((a, b) => Number(a?.position) - Number(b?.position))
        : [];
    if (!items.length) throw new Error('Questionnaire has no items');
    const itemById = new Map();
    for (const item of items) {
        if (!UUID_V4.test(item?.item_id || '') || itemById.has(item.item_id)) {
            throw new Error('Questionnaire item identities must be unique UUIDs');
        }
        if (item.required !== undefined && typeof item.required !== 'boolean') {
            throw new Error(`Questionnaire item ${item.item_id} has an invalid required flag`);
        }
        itemById.set(item.item_id, item);
    }
    if (!itemById.has(questionnaire?.start_item_id)) {
        throw new Error('Questionnaire start item is missing');
    }
    const minimumAnswered = Number(questionnaire?.completion_policy?.minimum_answered_items ?? 1);
    if (!Number.isInteger(minimumAnswered) || minimumAnswered < 1 ||
        questionnaire?.completion_policy?.require_terminal_route === false) {
        throw new Error('Questionnaire completion policy is invalid');
    }
    const nextInOrder = itemId => {
        const index = items.findIndex(item => item.item_id === itemId);
        return index >= 0 && index + 1 < items.length ? items[index + 1].item_id : 'end';
    };
    const normalizeTarget = (itemId, target) => {
        const normalized = target || 'next';
        if (normalized === 'next') return nextInOrder(itemId);
        if (normalized === 'end' || itemById.has(normalized)) return normalized;
        throw new Error(`Questionnaire route from ${itemId} has a missing target`);
    };
    const visiting = new Set();
    const shortestById = new Map();
    const reachable = new Set();
    const walk = itemId => {
        if (itemId === 'end') return 0;
        if (visiting.has(itemId)) throw new Error('Questionnaire routing contains a cycle');
        if (shortestById.has(itemId)) return shortestById.get(itemId);
        visiting.add(itemId);
        reachable.add(itemId);
        const node = questionnaire?.routing?.nodes?.[itemId];
        if (!node || !Array.isArray(node.rules || [])) {
            throw new Error(`Questionnaire routing node ${itemId} is missing or invalid`);
        }
        const ruleValues = new Set();
        for (const rule of node.rules || []) {
            if (rule?.operator !== 'equals' || !Object.prototype.hasOwnProperty.call(rule, 'value')) {
                throw new Error(`Questionnaire routing rule at ${itemId} is invalid`);
            }
            const valueKey = JSON.stringify(rule.value);
            if (ruleValues.has(valueKey)) throw new Error(`Questionnaire routing at ${itemId} has duplicate conditions`);
            ruleValues.add(valueKey);
        }
        const targets = [node.default_target, ...(node.rules || []).map(rule => rule.target)]
            .map(target => normalizeTarget(itemId, target));
        let shortest = Infinity;
        for (const target of new Set(targets)) shortest = Math.min(shortest, 1 + walk(target));
        visiting.delete(itemId);
        shortestById.set(itemId, shortest);
        return shortest;
    };
    const shortestRoute = walk(questionnaire.start_item_id);
    if (reachable.size !== items.length) throw new Error('Questionnaire contains unreachable items');
    if (!Number.isFinite(shortestRoute) || minimumAnswered > shortestRoute) {
        throw new Error('Minimum answered items exceeds the shortest valid route');
    }
    return { items, itemById, nextInOrder, minimumAnswered };
}

function validateCompletedQuestionnaireRoute(questionnaire, responseRecords, submittedRoute) {
    const graph = validateQuestionnaireGraph(questionnaire);
    const recordByItemId = new Map();
    for (const record of responseRecords) {
        if (recordByItemId.has(record?.questionnaire_item_id)) {
            throw new Error('A questionnaire item was answered more than once');
        }
        if (!hasQuestionnaireAnswer(record?.value)) {
            throw new Error('A submitted response has no answer value');
        }
        recordByItemId.set(record?.questionnaire_item_id, record);
    }
    const route = [];
    let currentItemId = questionnaire.start_item_id;
    while (currentItemId !== 'end') {
        if (route.includes(currentItemId) || route.length >= graph.items.length) {
            throw new Error('Questionnaire completion route contains a cycle');
        }
        const item = graph.itemById.get(currentItemId);
        if (!item) throw new Error('Questionnaire completion route has a missing item');
        route.push(currentItemId);
        const record = recordByItemId.get(currentItemId);
        if (item.required !== false && !record) {
            throw new Error(`Required questionnaire item ${currentItemId} has no answer`);
        }
        if (record) validateQuestionnaireAnswer(item, record.value);
        const answer = record?.value;
        const node = questionnaire.routing.nodes[currentItemId];
        const rule = (node.rules || []).find(candidate => candidate.operator === 'equals' &&
            (Array.isArray(answer)
                ? answer.some(value => sameQuestionnaireValue(value, candidate.value))
                : sameQuestionnaireValue(answer, candidate.value)));
        const target = rule?.target || node.default_target || 'next';
        currentItemId = target === 'next' ? graph.nextInOrder(currentItemId) : target;
        if (currentItemId !== 'end' && !graph.itemById.has(currentItemId)) {
            throw new Error('Questionnaire completion route has an invalid target');
        }
    }
    if (responseRecords.some(record => !route.includes(record.questionnaire_item_id))) {
        throw new Error('Response records contain an item outside the completed route');
    }
    if (responseRecords.length < graph.minimumAnswered) {
        throw new Error('Completed route does not meet the minimum answered-item threshold');
    }
    if (!Array.isArray(submittedRoute) || submittedRoute.length !== route.length ||
        submittedRoute.some((itemId, index) => itemId !== route[index])) {
        throw new Error('Submitted route does not match the answers and questionnaire routing');
    }
    return route;
}

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

async function fetchWithTimeout(
    url,
    options,
    timeoutMs = UPSTREAM_TIMEOUT_MS,
    timeoutMessage = 'Authentication storage did not respond in time'
) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...(options || {}), signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error(timeoutMessage);
            timeoutError.status = 504;
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
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
    const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
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

function aiProviderKey(provider) {
    if (provider === 'groq') return process.env.GROQ_API_KEY || '';
    if (provider === 'gemini') return process.env.GEMINI_API_KEY || '';
    return '';
}

function validateAiRequest(body) {
    const task = String(body?.task || '');
    const provider = String(body?.provider || '');
    const model = String(body?.model || '');
    const systemPrompt = String(body?.system_prompt || '');
    const taskProviders = AI_TASK_MODELS[task];
    if (!taskProviders || !taskProviders[provider] || !taskProviders[provider].has(model)) {
        return { ok: false, error: 'The requested AI task, provider, or model is not allowed' };
    }
    if (!systemPrompt.trim()) {
        return { ok: false, error: 'A system prompt is required' };
    }
    const serializedPayload = typeof body?.payload === 'string'
        ? body.payload
        : JSON.stringify(body?.payload ?? null);
    const requestBytes = Buffer.byteLength(systemPrompt, 'utf8') +
        Buffer.byteLength(serializedPayload, 'utf8');
    if (requestBytes > MAX_AI_REQUEST_BYTES) {
        return { ok: false, error: 'The AI request exceeds the allowed size' };
    }
    return { ok: true, task, provider, model, systemPrompt, serializedPayload };
}

function validateAiPreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'AI preferences must be an object' };
    }
    const extraKeys = Object.keys(value).filter(key => !Object.hasOwn(AI_TASK_MODELS, key));
    if (extraKeys.length) {
        return { ok: false, error: 'AI preferences may contain task-to-model choices only' };
    }
    const preferences = {};
    for (const task of Object.keys(AI_TASK_MODELS)) {
        const selected = value[task] || DEFAULT_AI_PREFERENCES[task];
        const provider = String(selected?.provider || '');
        const model = String(selected?.model || '');
        if (!AI_TASK_MODELS[task][provider]?.has(model)) {
            return { ok: false, error: `The AI preference for ${task} is not allowed` };
        }
        preferences[task] = { provider, model };
    }
    return { ok: true, preferences };
}

function normalizeDoi(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
        .replace(/^doi:\s*/i, '');
    if (!/^10\.\d{4,9}\/\S+$/i.test(normalized) || normalized.length > 512) return null;
    return normalized.toLowerCase();
}

function firstMetadataValue(value) {
    return Array.isArray(value) && value.length ? String(value[0] || '') : null;
}

function crossrefPublishedDate(message) {
    const parts = message?.published?.['date-parts']?.[0] ||
        message?.['published-print']?.['date-parts']?.[0] ||
        message?.['published-online']?.['date-parts']?.[0];
    if (!Array.isArray(parts) || !parts.length) return null;
    const [year, month = 1, day = 1] = parts.map(Number);
    if (!Number.isInteger(year)) return null;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function verifyCrossrefDoi(doi) {
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'Research-OS-Tijuana/1.0'
    };
    const mailto = String(process.env.CROSSREF_MAILTO || '').trim();
    const query = mailto ? `?mailto=${encodeURIComponent(mailto)}` : '';
    const response = await fetchWithTimeout(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}${query}`,
        { headers },
        UPSTREAM_TIMEOUT_MS,
        'Crossref metadata service did not respond in time'
    );
    if (!response.ok) {
        const error = new Error(
            response.status === 404
                ? 'DOI metadata was not found in Crossref'
                : `Crossref metadata lookup failed with status ${response.status}`
        );
        error.status = response.status === 404 ? 404 : 502;
        throw error;
    }
    const payload = await response.json();
    const message = payload?.message;
    if (!message || normalizeDoi(message.DOI) !== doi) {
        const error = new Error('Crossref returned metadata for a different DOI');
        error.status = 502;
        throw error;
    }
    return {
        doi,
        title: firstMetadataValue(message.title),
        authors: Array.isArray(message.author)
            ? message.author.map(author => ({
                given: author?.given || null,
                family: author?.family || null,
                orcid: author?.ORCID || null
            }))
            : [],
        published_date: crossrefPublishedDate(message),
        container_title: firstMetadataValue(message['container-title']),
        publisher: message.publisher || null,
        work_type: message.type || null,
        url: message.URL || `https://doi.org/${doi}`,
        licenses: Array.isArray(message.license)
            ? message.license.map(item => ({
                url: item?.URL || null,
                start: item?.start?.['date-time'] || null,
                content_version: item?.['content-version'] || null
            }))
            : []
    };
}

async function callAiProvider(request) {
    const apiKey = aiProviderKey(request.provider);
    if (!apiKey) {
        const error = new Error(`Server-side ${request.provider.toUpperCase()} credentials are not configured`);
        error.status = 503;
        throw error;
    }
    let response;
    if (request.provider === 'groq') {
        response = await fetchWithTimeout(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: request.model,
                    messages: [
                        { role: 'system', content: request.systemPrompt },
                        { role: 'user', content: request.serializedPayload }
                    ],
                    temperature: 0.1,
                    response_format: { type: 'json_object' }
                })
            },
            AI_UPSTREAM_TIMEOUT_MS
        );
    } else {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `${request.systemPrompt}\n\nData in JSON:\n${request.serializedPayload}`
                        }]
                    }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            },
            AI_UPSTREAM_TIMEOUT_MS
        );
    }
    if (!response.ok) {
        const error = new Error(`AI provider request failed with status ${response.status}`);
        error.status = 502;
        throw error;
    }
    const data = await response.json();
    const rawText = request.provider === 'groq'
        ? data?.choices?.[0]?.message?.content
        : data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof rawText !== 'string' || !rawText.trim()) {
        const error = new Error('AI provider returned no structured result');
        error.status = 502;
        throw error;
    }
    try {
        return JSON.parse(rawText);
    } catch (_) {
        const error = new Error('AI provider returned invalid JSON');
        error.status = 502;
        throw error;
    }
}

export default async function handler(req, res) {
    const { url, method } = req;
    const requestUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const path = requestUrl.pathname.replace(/^\/api(?=\/|$)/, '');
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (path === '/ai/preferences' && method === 'GET') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_researcher_ai_preferences',
                { p_researcher_account_id: access.principal.account_id }
            );
            const stored = Array.isArray(loaded) ? loaded[0] : loaded;
            const validated = validateAiPreferences(stored || DEFAULT_AI_PREFERENCES);
            const preferences = validated.ok
                ? validated.preferences
                : DEFAULT_AI_PREFERENCES;
            return res.status(200).json({ ok: true, preferences });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/ai/preferences' && method === 'PUT') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const validated = validateAiPreferences(req.body?.preferences);
        if (!validated.ok) {
            return res.status(400).json({ ok: false, error: validated.error });
        }
        try {
            await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'save_researcher_ai_preferences',
                {
                    p_researcher_account_id: access.principal.account_id,
                    p_preferences: validated.preferences
                }
            );
            return res.status(200).json({ ok: true, preferences: validated.preferences });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/ai/request' && method === 'POST') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const validated = validateAiRequest(req.body);
        if (!validated.ok) {
            return res.status(400).json({ ok: false, error: validated.error });
        }
        try {
            const result = await callAiProvider(validated);
            return res.status(200).json({
                ok: true,
                task: validated.task,
                provider: validated.provider,
                model: validated.model,
                result
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/evidence/doi' && method === 'GET') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) {
            return res.status(access.status).json({ ok: false, error: access.error });
        }
        const doi = normalizeDoi(requestUrl.searchParams.get('doi'));
        if (!doi) {
            return res.status(400).json({ ok: false, error: 'A valid DOI is required' });
        }
        try {
            const metadata = await verifyCrossrefDoi(doi);
            return res.status(200).json({
                ok: true,
                verification: {
                    status: 'bibliographic_metadata_verified',
                    registry: 'Crossref',
                    verified_at: new Date().toISOString(),
                    scope: 'DOI existence and deposited bibliographic metadata only',
                    scientific_appropriateness: 'requires_researcher_review',
                    rights_status: 'requires_researcher_review'
                },
                metadata
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/auth/register' && method === 'POST') {
        const normalizedUsername = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');
        if (!/^[A-Za-z0-9_.@+-]{3,128}$/.test(normalizedUsername)) {
            return res.status(400).json({
                ok: false,
                error: "Username must be 3 to 128 characters and contain only letters, numbers, '.', '_', '@', '+' or '-'"
            });
        }
        if (password.length < 10) {
            return res.status(400).json({ ok: false, error: 'Password must contain at least 10 characters' });
        }
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Server-side authentication is not configured' });
        }
        const sessionToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        try {
            const result = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'register_research_os_respondent',
                {
                    p_username: normalizedUsername,
                    p_password: password,
                    p_session_id: randomUUID(),
                    p_token_hash: sessionTokenHash(sessionToken),
                    p_expires_at: expiresAt
                }
            );
            const registered = Array.isArray(result) ? result[0] : result;
            if (!registered?.account_id) {
                return res.status(500).json({ ok: false, error: 'Registration did not create an account' });
            }
            return res.status(201).json({
                ok: true,
                session_token: sessionToken,
                account_id: registered.account_id,
                role: 'respondent',
                user_identifier: registered.user_identifier,
                expires_at: registered.expires_at || expiresAt
            });
        } catch (error) {
            if (/Username is already registered/i.test(error.message)) {
                return res.status(409).json({ ok: false, error: 'Username is already registered' });
            }
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

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
        let sessionWrite;
        try {
            sessionWrite = await fetchWithTimeout(
                `${supabaseUrl}/rest/v1/research_os_auth_sessions`,
                {
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
                }
            );
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
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

    const publicStudyJoinMatch = path.match(
        /^\/public\/studies\/join\/([0-9a-f-]+)(?:\/qr\.svg)?$/i
    );
    if (publicStudyJoinMatch && method === 'GET') {
        if (!UUID_V4.test(publicStudyJoinMatch[1])) {
            return res.status(400).json({ ok: false, error: 'Valid study invitation UUID is required' });
        }
        if (path.endsWith('/qr.svg')) {
            try {
                const { default: QRCode } = await import('qrcode');
                const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0];
                const protocol = forwardedProtocol === 'http' ? 'http' : 'https';
                const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
                if (!host) return res.status(400).send('Request host is required');
                const joinUrl = `${protocol}://${host}/join-study.html?invite=${encodeURIComponent(publicStudyJoinMatch[1])}`;
                const svg = await QRCode.toString(joinUrl, {
                    type: 'svg',
                    errorCorrectionLevel: 'H',
                    margin: 2,
                    width: 320
                });
                res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.status(200).send(svg);
            } catch (error) {
                return res.status(500).send(`QR generation failed: ${error.message}`);
            }
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl, supabaseAdminKey, 'get_public_study_invitation',
                { p_invitation_id: publicStudyJoinMatch[1] }
            );
            const invitation = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!invitation) {
                return res.status(409).json({
                    ok: false,
                    error: 'The study invitation is closed or unavailable'
                });
            }
            return res.status(200).json({ ok: true, invitation });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const respondentStudyJoinMatch = path.match(
        /^\/respondent\/studies\/join\/([0-9a-f-]+)$/i
    );
    if (respondentStudyJoinMatch && method === 'POST') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        if (!UUID_V4.test(respondentStudyJoinMatch[1])) {
            return res.status(400).json({
                ok: false,
                error: 'Valid study invitation UUID is required'
            });
        }
        try {
            const joined = await callSupabaseRpc(
                supabaseUrl, supabaseAdminKey, 'join_study_by_invitation',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_invitation_id: respondentStudyJoinMatch[1]
                }
            );
            const result = Array.isArray(joined) ? joined[0] : joined;
            return res.status(result?.idempotent ? 200 : 201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/respondent/measurements' && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        try {
            const measurements = await callSupabaseRpc(
                supabaseUrl, supabaseAdminKey, 'list_respondent_measurements',
                { p_respondent_account_id: access.principal.account_id }
            );
            return res.status(200).json({
                ok: true, measurements: Array.isArray(measurements) ? measurements : []
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const measurementConsentMatch = path.match(
        /^\/respondent\/measurements\/([0-9a-f-]+)\/consent$/i
    );
    if (measurementConsentMatch && method === 'GET') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const language = String(requestUrl.searchParams.get('lang') || 'es').trim();
        if (!UUID_V4.test(measurementConsentMatch[1]) || !language) {
            return res.status(400).json({
                ok: false, error: 'Valid participant measurement UUID and language are required'
            });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl, supabaseAdminKey, 'get_respondent_measurement_consent',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_participant_measurement_id: measurementConsentMatch[1],
                    p_requested_language: language
                }
            );
            const consent = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!consent) {
                return res.status(409).json({
                    ok: false,
                    error: 'The assigned measurement is not available or lacks active consent'
                });
            }
            return res.status(200).json({ ok: true, consent });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const measurementStartMatch = path.match(
        /^\/respondent\/measurements\/([0-9a-f-]+)\/start$/i
    );
    if (measurementStartMatch && method === 'POST') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const language = String(req.body?.language || 'es').trim();
        if (!UUID_V4.test(measurementStartMatch[1]) ||
            !language || req.body?.explicit_acceptance !== true) {
            return res.status(400).json({
                ok: false,
                error: 'Participant measurement, language and explicit acceptance are required'
            });
        }
        try {
            const started = await callSupabaseRpc(
                supabaseUrl, supabaseAdminKey, 'accept_consent_and_start_measurement',
                {
                    p_respondent_account_id: access.principal.account_id,
                    p_participant_measurement_id: measurementStartMatch[1],
                    p_requested_language: language,
                    p_explicit_acceptance: true
                }
            );
            const result = Array.isArray(started) ? started[0] : started;
            if (!result?.session_id) {
                return res.status(500).json({
                    ok: false, error: 'Consent acceptance did not create a study session'
                });
            }
            return res.status(201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    const legacyRespondentQuestionnaireRoute =
        path === '/respondent/questionnaires' ||
        /^\/respondent\/questionnaires\/[0-9a-f-]+\/(?:consent|start)$/i.test(path);
    if (legacyRespondentQuestionnaireRoute) {
        return res.status(410).json({
            ok: false,
            error: 'Direct questionnaire collection is retired. Use an assigned study measurement.'
        });
    }

    // Unreachable legacy handlers are retained only so older staged database
    // migrations remain auditable; the guard above prevents mixed data formats.
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
                'list_respondent_study_sessions',
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

    const respondentSessionDiscardMatch = path.match(
        /^\/respondent\/sessions\/([0-9a-f-]+)\/discard$/i
    );
    if (respondentSessionDiscardMatch && method === 'POST') {
        const access = await verifyAccess(req, 'respondent', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const sessionId = respondentSessionDiscardMatch[1];
        if (!UUID_V4.test(sessionId)) {
            return res.status(400).json({ ok: false, error: 'Valid collection session UUID is required' });
        }
        try {
            const result = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'discard_response_session',
                {
                    p_session_id: sessionId,
                    p_respondent_account_id: access.principal.account_id,
                    p_reason: 'participant_exit_before_completion'
                }
            );
            return res.status(200).json({ ok: true, result });
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
                banks = banks.filter(bank =>
                    owned.has(bank.bank_id) ||
                    (
                        bank.status === 'active' &&
                        (!bank.reuse_permission || bank.reuse_permission === 'attribution_permitted')
                    )
                ).map(bank => ({ ...bank, owned_by_current_account: owned.has(bank.bank_id) }));
            } else {
                banks = banks.filter(bank =>
                    bank.status === 'active' &&
                    (!bank.reuse_permission || bank.reuse_permission === 'attribution_permitted')
                );
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

    if (path === '/studies/save' && method === 'POST') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const study = req.body;
        const groups = study?.groups;
        const timepoints = study?.timepoints;
        const assignments = study?.questionnaire_assignments;
        if (study?.schema !== 'research_os.study' ||
            study?.schema_version !== 1 ||
            !UUID_V4.test(study?.study_id || '') ||
            !Number.isInteger(study?.version) || study.version < 1 ||
            !['draft', 'trial', 'active'].includes(study?.status) ||
            !['fixed_questionnaire_mode', 'adaptive_dialogue_mode'].includes(study?.collection_mode) ||
            !['none', 'within_study_consent_bound'].includes(study?.longitudinal_linkage) ||
            !study?.code || !study?.title || !study?.primary_language ||
            !study?.global_time_reference || !study?.generated_at ||
            !Array.isArray(groups) || groups.length === 0 ||
            !Array.isArray(timepoints) || timepoints.length === 0 ||
            !Array.isArray(assignments)) {
            return res.status(400).json({
                ok: false,
                error: 'Complete research_os.study schema version 1 is required'
            });
        }
        if (groups.some((group, index) =>
            !UUID_V4.test(group?.group_id || '') ||
            !UUID_V4.test(group?.invitation_id || '') ||
            !group?.code || !group?.title ||
            group?.position !== index + 1
        ) || timepoints.some((timepoint, index) =>
            !UUID_V4.test(timepoint?.timepoint_id || '') ||
            !timepoint?.code || !timepoint?.title || timepoint?.ordinal !== index + 1
        ) || assignments.some(assignment =>
            !UUID_V4.test(assignment?.assignment_id || '') ||
            !UUID_V4.test(assignment?.timepoint_id || '') ||
            !UUID_V4.test(assignment?.questionnaire_id || '') ||
            !Number.isInteger(assignment?.questionnaire_version) ||
            assignment.questionnaire_version < 1 ||
            !Number.isInteger(assignment?.position) || assignment.position < 1
        )) {
            return res.status(400).json({
                ok: false,
                error: 'Study groups, timepoints or questionnaire assignments are invalid'
            });
        }
        try {
            const saved = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'save_owned_study_package',
                {
                    study_data: study,
                    p_researcher_account_id: access.principal.account_id
                }
            );
            const result = Array.isArray(saved) ? saved[0] : saved;
            return res.status(200).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (path === '/studies' && method === 'GET') {
        if (!supabaseUrl || !supabaseAdminKey) {
            return res.status(503).json({ ok: false, error: 'Supabase credentials missing' });
        }
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const requestedStatus = requestUrl.searchParams.get('status') || 'all';
        if (!['all', 'draft', 'trial', 'active'].includes(requestedStatus)) {
            return res.status(400).json({ ok: false, error: 'Study status filter is invalid' });
        }
        try {
            const studies = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'list_studies_for_account',
                {
                    p_researcher_account_id: access.principal.account_id,
                    requested_status: requestedStatus
                }
            );
            return res.status(200).json({
                ok: true,
                studies: Array.isArray(studies) ? studies : []
            });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    if (/^\/studies\/[0-9a-f-]+\/enrollments$/i.test(path)) {
        return res.status(410).json({
            ok: false,
            error: 'Manual participant enrollment is retired. Respondents join through a study invitation link or QR code.'
        });
    }

    const studyLoadMatch = path.match(/^\/studies\/([0-9a-f-]+)$/i);
    if (studyLoadMatch && method === 'GET') {
        const access = await verifyResearcher(req, supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const studyVersion = Number(requestUrl.searchParams.get('version'));
        if (!UUID_V4.test(studyLoadMatch[1]) ||
            !Number.isInteger(studyVersion) || studyVersion < 1) {
            return res.status(400).json({ ok: false, error: 'Valid study UUID and version are required' });
        }
        try {
            const loaded = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_study_package_for_account',
                {
                    p_study_id: studyLoadMatch[1],
                    p_study_version: studyVersion,
                    p_researcher_account_id: access.principal.account_id
                }
            );
            const study = Array.isArray(loaded) ? loaded[0] : loaded;
            if (!study) return res.status(404).json({ ok: false, error: 'Study not found' });
            return res.status(200).json({ ok: true, study });
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
            validateQuestionnaireGraph(questionnaireData);
        } catch (error) {
            return res.status(400).json({ ok: false, error: error.message });
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
                ).map(questionnaire => ({
                    ...questionnaire,
                    owned_by_current_account: owned.has(questionnaire.questionnaire_id)
                }));
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

        const requestedPackageData = req.body;
        const requestedReusePermission = requestedPackageData?.reuse_policy?.permission ||
            'attribution_permitted';
        if (!['attribution_permitted', 'permission_required'].includes(requestedReusePermission)) {
            return res.status(400).json({
                ok: false,
                error: 'Question-bank reuse permission must be attribution_permitted or permission_required'
            });
        }
        const packageData = {
            ...requestedPackageData,
            reuse_policy: {
                permission: requestedReusePermission,
                attribution_required: true,
                ownership_retained_by_author: true
            },
            authorship: {
                owner_account_id: authorization.principal.account_id,
                owner_identifier: authorization.principal.user_identifier,
                asserted_by: 'authenticated_server'
            }
        };
        const questionMap = packageData?.questions;
        const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (packageData?.schema !== 'research_os.question_bank' || packageData?.schema_version !== 2) {
            return res.status(400).json({ ok: false, error: 'research_os.question_bank schema version 2 is required' });
        }
        if (!uuidV4.test(packageData.bank_id || '')) {
            return res.status(400).json({ ok: false, error: 'Valid bank_id UUID is required' });
        }
        if (!packageData.code || !SYSTEM_CODE.test(packageData.code) || !packageData.title || !packageData.primary_language ||
            !packageData.global_time_reference || Number.isNaN(Date.parse(packageData.global_time_reference)) ||
            !Number.isInteger(packageData.version) || packageData.version < 1) {
            return res.status(400).json({ ok: false, error: 'Bank code, title, language, Global Time Reference, and positive integer version are required' });
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
        if (!Array.isArray(packageData.question_order) || packageData.question_order.length !== entries.length ||
            new Set(packageData.question_order).size !== packageData.question_order.length ||
            packageData.question_order.some(entryCode => !Object.prototype.hasOwnProperty.call(questionMap, entryCode))) {
            return res.status(400).json({
                ok: false,
                error: 'question_order and questions must contain the same questions exactly once'
            });
        }

        for (const [entryCode, question] of entries) {
            const selectionType = ['single_select', 'multiple_select'].includes(question?.type);
            const validOptions = Array.isArray(question?.options) &&
                (!selectionType || question.options.length >= 2) &&
                question.options.every(option => option && typeof option === 'object' &&
                    String(option.text || '').trim() &&
                    Object.prototype.hasOwnProperty.call(option, 'value') &&
                    option.value !== null && option.value !== undefined) &&
                new Set(question.options.map(option => JSON.stringify(option.value))).size === question.options.length;
            if (!uuidV4.test(question?.question_id || '') ||
                question?.code !== entryCode ||
                !SYSTEM_CODE.test(entryCode) ||
                !question?.prompt ||
                !Number.isInteger(question?.version) ||
                question.version < 1 ||
                !['single_select', 'multiple_select', 'numeric_input', 'text_input'].includes(question?.type) ||
                !question?.scale || !String(question.scale.id || '').trim() ||
                !['nominal', 'ordinal', 'interval_ratio', 'textual'].includes(question.scale.psychometric_level) ||
                !validQuestionScaleContract(question) ||
                !validOptions ||
                !['draft', 'trial', 'active'].includes(question?.status) ||
                Object.prototype.hasOwnProperty.call(question, 'routing') ||
                question.options.some(option =>
                    option && typeof option === 'object' &&
                    (Object.prototype.hasOwnProperty.call(option, 'next') ||
                     Object.prototype.hasOwnProperty.call(option, 'target'))
                ) ||
                (packageData.status === 'active' && question.status !== 'active') ||
                (packageData.status === 'trial' && question.status === 'draft')) {
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
            `${supabaseUrl}/rest/v1/research_os_collection_sessions?session_id=eq.${encodeURIComponent(pathSessionId)}&respondent_identifier=eq.${encodeURIComponent(access.principal.user_identifier)}&status=eq.active&select=session_id,global_time_reference,started_at,questionnaire_id,questionnaire_version,study_id,study_version,enrollment_id,participant_measurement_id,study_questionnaire_assignment_id,timepoint_id,timepoint_code,timepoint_ordinal,group_membership_id,group_id,group_code,subject_link_id&limit=1`,
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
        const startedTime = new Date(sourceIdentity.collection_started_at).getTime();
        const sessionStartedTime = new Date(collectionSession.started_at).getTime();
        const finishedTime = new Date(sourceIdentity.collection_finished_at).getTime();
        if (!Number.isFinite(startedTime) || !Number.isFinite(sessionStartedTime) ||
            startedTime !== sessionStartedTime || !Number.isFinite(finishedTime) ||
            finishedTime < sessionStartedTime) {
            return res.status(400).json({ ok: false, error: 'Collection start or finish time is invalid' });
        }
        for (const field of [
            'study_id', 'study_version', 'enrollment_id', 'participant_measurement_id',
            'study_questionnaire_assignment_id', 'timepoint_id', 'timepoint_code',
            'timepoint_ordinal', 'group_membership_id', 'group_id', 'group_code',
            'subject_link_id'
        ]) {
            if ((sourceIdentity[field] ?? null) !== (collectionSession[field] ?? null)) {
                return res.status(400).json({
                    ok: false,
                    error: `Study/session identity mismatch: ${field}`
                });
            }
        }
        for (const record of responseRecords) {
            const presentedTime = new Date(record?.presented_at).getTime();
            const answeredTime = new Date(record?.answered_at).getTime();
            if (record?.session_id !== pathSessionId ||
                record?.participant_id !== access.principal.user_identifier ||
                !record?.response_id ||
                !record?.questionnaire_item_id ||
                !record?.question_id ||
                !record?.question_version ||
                !record?.bank_id ||
                !record?.bank_version ||
                !record?.code ||
                !hasQuestionnaireAnswer(record?.value) ||
                !record?.presented_at ||
                !record?.answered_at ||
                !Number.isFinite(presentedTime) ||
                !Number.isFinite(answeredTime) ||
                presentedTime > answeredTime ||
                answeredTime > finishedTime ||
                !Number.isInteger(record?.answered_utc_offset_minutes) ||
                record.answered_utc_offset_minutes < -840 ||
                record.answered_utc_offset_minutes > 840 ||
                !record?.global_time_reference ||
                record.global_time_reference !== sessionGlobalTimeReference) {
                return res.status(400).json({ ok: false, error: 'A response record does not satisfy the identity/time contract' });
            }
        }
        const questionnaireResponse = await fetch(
            `${supabaseUrl}/rest/v1/questionnaires?questionnaire_id=eq.${encodeURIComponent(collectionSession.questionnaire_id)}&version=eq.${encodeURIComponent(collectionSession.questionnaire_version)}&select=package_data&limit=1`,
            { headers: serviceHeaders(supabaseAdminKey) }
        );
        if (!questionnaireResponse.ok) {
            return res.status(questionnaireResponse.status).json({
                ok: false,
                error: `Questionnaire completion contract could not be loaded: ${await questionnaireResponse.text()}`
            });
        }
        const questionnaireRows = await questionnaireResponse.json();
        const questionnairePackage = Array.isArray(questionnaireRows) ? questionnaireRows[0]?.package_data : null;
        if (!questionnairePackage) {
            return res.status(409).json({ ok: false, error: 'Session questionnaire version is unavailable' });
        }
        try {
            validateCompletedQuestionnaireRoute(
                questionnairePackage,
                responseRecords,
                sourceIdentity.route_item_ids
            );
        } catch (error) {
            return res.status(422).json({ ok: false, error: error.message });
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

    const analysisRecordsMatch = path.match(
        /^\/analysis\/studies\/([0-9a-f-]+)\/records$/i
    );
    if (analysisRecordsMatch && method === 'GET') {
        const access = await verifyAccess(req, 'researcher', supabaseUrl, supabaseAdminKey);
        if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
        const studyId = analysisRecordsMatch[1];
        const requestUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const studyVersion = Number(requestUrl.searchParams.get('version'));
        if (!UUID_V4.test(studyId) || !Number.isInteger(studyVersion) || studyVersion < 1) {
            return res.status(400).json({ ok: false, error: 'Valid study UUID and version are required' });
        }
        try {
            const records = await callSupabaseRpc(
                supabaseUrl,
                supabaseAdminKey,
                'load_researcher_analysis_records',
                {
                    p_researcher_account_id: access.principal.account_id,
                    p_study_id: studyId,
                    p_study_version: studyVersion
                }
            );
            return res.status(200).json({ ok: true, records: Array.isArray(records) ? records : [] });
        } catch (error) {
            return res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    }

    return res.status(404).json({ error: 'Endpoint not found', url });
}
