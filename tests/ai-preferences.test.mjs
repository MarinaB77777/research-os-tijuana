import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [apiSource, routerSource, settingsSource, accessSql] = await Promise.all([
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../ai-router.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../settings.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../supabase/access_control_v2.sql', import.meta.url), 'utf8')
]);

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function jsonFetch(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function authFetchSequence(calls, rpcPayload) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return jsonFetch([{
        session_id: '83ca8b34-acde-45be-a279-8188edaa8a05',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    if (calls.length === 2) {
      return jsonFetch([{
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        username: 'owner',
        user_identifier: 'OWNER-001',
        role: 'researcher',
        status: 'active'
      }]);
    }
    return jsonFetch(rpcPayload);
  };
}

test('AI preferences are account-scoped task/model choices with no credential fields', () => {
  assert.match(accessSql, /research_os_ai_preferences/);
  assert.match(accessSql, /researcher_account_id uuid primary key/);
  assert.match(accessSql, /save_researcher_ai_preferences/);
  assert.doesNotMatch(accessSql, /GROQ_API_KEY|GEMINI_API_KEY|provider_key|api_key/i);
  assert.match(routerSource, /fetch\('\/api\/ai\/preferences'/);
  assert.match(settingsSource, /AIRouter\.savePreferences/);
  assert.match(settingsSource, /task_study_design/);
  assert.match(routerSource, /study_design/);
  assert.match(apiSource, /study_design: Object\.freeze/);
  assert.doesNotMatch(settingsSource, /localStorage\.setItem\(['"]ai_router_config/);
  assert.match(apiSource, /openai\/gpt-oss-20b/);
  assert.doesNotMatch(apiSource, /openai\/gpt-oss-120b/);
  assert.doesNotMatch(routerSource, /openai\/gpt-oss-120b/);
  assert.doesNotMatch(settingsSource, /openai\/gpt-oss-120b/);
  assert.doesNotMatch(apiSource, /llama-3\.3-70b-versatile/);
  assert.doesNotMatch(routerSource, /llama-3\.3-70b-versatile/);
  assert.match(settingsSource, /Do not send personal, confidential, or participant data to Gemini free-tier models/);
});

test('researcher can save only allow-listed per-account AI preferences', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#save-ai-preferences`
  )).default;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authFetchSequence(calls, [{
    analyzer: { provider: 'gemini', model: 'gemini-3.6-flash' },
    translator: { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
    study_design: { provider: 'groq', model: 'openai/gpt-oss-20b' }
  }]);

  try {
    const preferences = {
      analyzer: { provider: 'gemini', model: 'gemini-3.6-flash' },
      translator: { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      study_design: { provider: 'groq', model: 'openai/gpt-oss-20b' }
    };
    const res = response();
    await handler({
      method: 'PUT',
      url: '/api/ai/preferences',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-session'
      },
      body: { preferences }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.preferences, preferences);
    assert.match(calls[2].url, /rpc\/save_researcher_ai_preferences/);
    const rpcBody = JSON.parse(calls[2].options.body);
    assert.equal(
      rpcBody.p_researcher_account_id,
      'a22cb0be-acde-42c4-86aa-a1c023b0c329'
    );
    assert.deepEqual(rpcBody.p_preferences, preferences);
    assert.doesNotMatch(JSON.stringify(rpcBody), /api.?key|secret|token/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retired stored models fall back to the current free Groq model', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#retired-ai-preferences`
  )).default;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authFetchSequence(calls, {
    analyzer: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    translator: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    study_design: { provider: 'groq', model: 'retired-study-model' }
  });

  try {
    const res = response();
    await handler({
      method: 'GET',
      url: '/api/ai/preferences',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-session'
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.preferences, {
      analyzer: { provider: 'groq', model: 'openai/gpt-oss-20b' },
      translator: { provider: 'groq', model: 'openai/gpt-oss-20b' },
      study_design: { provider: 'groq', model: 'openai/gpt-oss-20b' }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI preference endpoint rejects secrets and unsupported models before database write', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#reject-ai-secret`
  )).default;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = authFetchSequence(calls, []);
  try {
    const res = response();
    await handler({
      method: 'PUT',
      url: '/api/ai/preferences',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-session'
      },
      body: {
        preferences: {
          analyzer: { provider: 'groq', model: 'made-up-model' },
          translator: { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
          api_key: 'must-not-be-stored'
        }
      }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /task-to-model choices only|not allowed/i);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
