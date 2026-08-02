import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [constructorPage, contracts, apiSource, bankSql, accessSql, catalogSql, settings] =
  await Promise.all([
    fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../research-contracts.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_bank_contract_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/access_control_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/research_configuration_contract_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../settings.html', import.meta.url), 'utf8')
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

function canonicalBank(reusePermission) {
  return {
    schema: 'research_os.question_bank',
    schema_version: 2,
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'AUTHOR_BANK',
    title: 'Author bank',
    version: 1,
    status: 'draft',
    primary_language: 'es-MX',
    interface_language: 'es',
    global_mode: 'static',
    global_time_reference: '2026-07-29T20:00:00.000Z',
    generated_at: '2026-07-29T20:00:00.000Z',
    reuse_policy: {
      permission: reusePermission,
      attribution_required: true,
      ownership_retained_by_author: true
    },
    question_order: ['Q_1'],
    questions: {
      Q_1: {
        question_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        code: 'Q_1',
        version: 1,
        status: 'draft',
        type: 'single_select',
        prompt: 'Question',
        scale: { id: 'binary', psychometric_level: 'nominal' },
        options: [{ value: 0, text: 'No' }, { value: 1, text: 'Yes' }]
      }
    }
  };
}

test('question-bank constructor defaults to attribution-permitted reuse while retaining authorship', () => {
  assert.match(constructorPage, /id="reusePolicySelect"/);
  assert.match(constructorPage, /value="attribution_permitted"/);
  assert.match(constructorPage, /value="permission_required"/);
  assert.match(constructorPage, /attribution_required:\s*true/);
  assert.match(constructorPage, /ownership_retained_by_author:\s*true/);
  assert.match(contracts, /'attribution_permitted',\s*'permission_required'/);
});

test('server binds authorship to the authenticated owner and never trusts a browser author', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#reuse-policy`
  )).default;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
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
    return jsonFetch([{ saved_count: 1 }]);
  };

  try {
    const body = canonicalBank('permission_required');
    body.authorship = { owner_account_id: 'attacker-supplied' };
    const res = response();
    await handler({
      method: 'POST',
      url: '/question-banks/save',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-session'
      },
      body
    }, res);
    assert.equal(res.statusCode, 200);
    const rpcBody = JSON.parse(calls[2].options.body);
    assert.equal(
      rpcBody.package_data.authorship.owner_account_id,
      'a22cb0be-acde-42c4-86aa-a1c023b0c329'
    );
    assert.equal(rpcBody.package_data.authorship.owner_identifier, 'OWNER-001');
    assert.equal(rpcBody.package_data.reuse_policy.permission, 'permission_required');
    assert.equal(rpcBody.package_data.reuse_policy.attribution_required, true);
    assert.equal(rpcBody.package_data.reuse_policy.ownership_retained_by_author, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('database contracts expose freely reusable active banks and keep restricted banks owner-only', () => {
  assert.match(bankSql, /reuse_policy,permission/);
  assert.match(bankSql, /attribution_required/);
  assert.match(bankSql, /ownership_retained_by_author/);
  assert.match(accessSql, /reuse_policy,permission/);
  assert.match(accessSql, /\{authorship\}/);
  assert.match(accessSql, /'asserted_by', 'authenticated_server'/);
  assert.match(accessSql, /researcher_account_id\s*=\s*p_researcher_account_id/);
  assert.match(catalogSql, /reuse_permission text/);
  assert.match(catalogSql, /attribution_permitted/);
});

test('AI provider secrets are environment-only and absent from database contracts', () => {
  const databaseContracts = `${bankSql}\n${accessSql}\n${catalogSql}`;
  assert.doesNotMatch(databaseContracts, /GROQ_API_KEY|GEMINI_API_KEY|ai_api_keys/i);
  assert.match(settings, /не записываются в базу данных/i);
  assert.doesNotMatch(settings, /id=["']key_(?:groq|gemini)["']/);
});
