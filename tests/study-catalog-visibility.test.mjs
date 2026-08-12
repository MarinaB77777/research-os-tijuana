import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const [apiSource, migration, page] = await Promise.all([
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../supabase/study_catalog_visibility_v1.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_study.html', import.meta.url), 'utf8')
]);
const handler = (await import(
  `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`
)).default;

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    send(payload) { this.payload = payload; return this; }
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

function researcherAccessThen(next) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (call === 1) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
      account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
      username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    return next(url, options, call);
  };
}

test('existing and new study identities default to existence-only visibility', () => {
  assert.match(migration, /default 'existence_only'/);
  assert.match(migration, /catalog_visibility in \('listed', 'existence_only'\)/);
  assert.match(page, /catalogVisibility='existence_only'/);
  assert.match(page, /existenceOnly:'Показывать только факт существования'/);
});

test('hidden shared studies disclose no identity or protocol fields', () => {
  assert.match(migration, /case when s\.catalog_visibility = 'listed' then s\.study_id else null::uuid end/);
  assert.match(migration, /case when s\.catalog_visibility = 'listed' then s\.title else null::text end/);
  assert.match(migration, /case when s\.catalog_visibility = 'listed' then[\s\S]*?jsonb_build_object\([\s\S]*?'research_questions'/);
  assert.match(page, /hidden\.length/);
  assert.match(page, /!s\.content_visible/);
  assert.doesNotMatch(migration, /'invitation_id'/);
  assert.doesNotMatch(migration, /'questionnaire_assignments'/);
});

test('visibility is administrative metadata and remains changeable for active versions', () => {
  assert.match(migration, /research_os_entity_ownership[\s\S]*catalog_visibility/);
  assert.match(migration, /set_owned_study_catalog_visibility/);
  assert.match(page, /method:'PATCH'/);
  assert.match(page, /saveVisibilityButton/);
  assert.doesNotMatch(page, /catalogVisibility[^\n]*disabled=locked/);
});

test('only the owner can change a study visibility through the API', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = researcherAccessThen(async (url, options) => {
    assert.match(url, /rpc\/set_owned_study_catalog_visibility$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      study_id: '9e37af31-acde-4ba9-83c3-f7fe77958322',
      catalog_visibility: 'listed'
    });
  });
  try {
    const res = response();
    await handler({
      method: 'PATCH',
      url: '/studies/9e37af31-acde-4ba9-83c3-f7fe77958322/visibility',
      body: { catalog_visibility: 'listed' },
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-token'
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(rpcBody.p_researcher_account_id, 'a22cb0be-acde-42c4-86aa-a1c023b0c329');
    assert.equal(rpcBody.p_catalog_visibility, 'listed');
    assert.equal(res.payload.catalog_visibility, 'listed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an invalid visibility value is rejected before any database mutation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async () => {
    throw new Error('Invalid visibility must not reach its RPC');
  });
  try {
    const res = response();
    await handler({
      method: 'PATCH',
      url: '/studies/9e37af31-acde-4ba9-83c3-f7fe77958322/visibility',
      body: { catalog_visibility: 'public_without_limits' },
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-token'
      }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /catalog visibility/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('operational study package loading remains owner-only', () => {
  assert.match(migration, /create function public\.list_studies_for_account/);
  assert.match(page, /shared\.map\([\s\S]*public_summary/);
  assert.doesNotMatch(page, /loadStudyByIdentity\([^)]*shared/);
  assert.match(apiSource, /load_study_package_for_account/);
});
