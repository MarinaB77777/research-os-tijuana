import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');

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

test('DOI verification confirms only deposited metadata and requires researcher judgment', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#doi-verification`
  )).default;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return jsonFetch([{
        session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    if (calls.length === 2) {
      return jsonFetch([{
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        username: 'researcher',
        user_identifier: 'RESEARCHER-001',
        role: 'researcher',
        status: 'active',
        created_by_account_id: null
      }]);
    }
    return jsonFetch({
      status: 'ok',
      message: {
        DOI: '10.1000/TEST.Scale',
        title: ['Primary scale development study'],
        author: [{ given: 'Ada', family: 'Researcher' }],
        published: { 'date-parts': [[2020, 4, 3]] },
        'container-title': ['Measurement Journal'],
        publisher: 'Scientific Publisher',
        type: 'journal-article',
        URL: 'https://doi.org/10.1000/test.scale',
        license: [{ URL: 'https://example.test/license', 'content-version': 'vor' }]
      }
    });
  };

  try {
    const res = response();
    await handler({
      method: 'GET',
      url: '/api/evidence/doi?doi=https%3A%2F%2Fdoi.org%2F10.1000%2FTEST.Scale',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-browser-session'
      }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.verification.status, 'bibliographic_metadata_verified');
    assert.equal(res.payload.verification.registry, 'Crossref');
    assert.match(res.payload.verification.scope, /bibliographic metadata only/i);
    assert.equal(
      res.payload.verification.scientific_appropriateness,
      'requires_researcher_review'
    );
    assert.equal(res.payload.verification.rights_status, 'requires_researcher_review');
    assert.equal(res.payload.metadata.doi, '10.1000/test.scale');
    assert.equal(res.payload.metadata.title, 'Primary scale development study');
    assert.deepEqual(res.payload.metadata.authors, [{
      given: 'Ada',
      family: 'Researcher',
      orcid: null
    }]);
    assert.equal(res.payload.metadata.published_date, '2020-04-03');
    assert.match(calls[2].url, /^https:\/\/api\.crossref\.org\/works\//);
    assert.doesNotMatch(calls[2].url, /researcher-browser-session|service-role-test-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DOI verification rejects malformed identifiers before an external lookup', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#invalid-doi`
  )).default;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonFetch([{
        session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    return jsonFetch([{
      account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
      username: 'researcher',
      user_identifier: 'RESEARCHER-001',
      role: 'researcher',
      status: 'active',
      created_by_account_id: null
    }]);
  };
  try {
    const res = response();
    await handler({
      method: 'GET',
      url: '/api/evidence/doi?doi=javascript%3Aalert(1)',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-browser-session'
      }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /valid DOI/i);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
