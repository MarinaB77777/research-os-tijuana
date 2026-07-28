import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.UPSTREAM_TIMEOUT_MS = '20';

const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');
const apiModule = await import(
  `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`
);
const handler = apiModule.default;

function request(method, url, body = undefined) {
  return {
    method,
    url,
    body,
    headers: {
      host: 'research-os.test',
      authorization: 'Bearer respondent-token'
    }
  };
}

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
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

function respondentAccessFetches(extraFetch) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (call === 1) {
      return jsonFetch([{
        session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        account_id: '23572089-acde-4b51-8566-f770a0be2c3c',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    if (call === 2) {
      return jsonFetch([{
        account_id: '23572089-acde-4b51-8566-f770a0be2c3c',
        username: 'respondent',
        user_identifier: 'RESPONDENT-001',
        role: 'respondent',
        status: 'active',
        created_by_account_id: 'e1d14a75-acde-4ca8-87e0-243ce6ac3f26'
      }]);
    }
    return extraFetch(url, options, call);
  };
}

test('legacy browser-authored consent cannot start a session', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Legacy endpoint must not touch storage');
  };
  try {
    const res = response();
    await handler(
      request('POST', '/pilot/accounts/start-session', {
        consent_record: { consent_status: 'granted' }
      }),
      res
    );
    assert.equal(res.statusCode, 410);
    assert.match(res.payload.error, /browser-authored consent records are not accepted/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('session start requires an explicit authenticated acceptance', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = respondentAccessFetches(async () => {
    throw new Error('RPC must not run without explicit acceptance');
  });
  try {
    const res = response();
    await handler(
      request(
        'POST',
        '/respondent/questionnaires/24b68c24-acde-49d0-8a16-6cfd95d19328/start',
        { questionnaire_version: 1, language: 'es', explicit_acceptance: false }
      ),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /explicit acceptance/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server passes verified respondent identity to the atomic consent RPC', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = respondentAccessFetches(async (url, options) => {
    assert.match(url, /rpc\/accept_consent_and_start_questionnaire$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      session_id: 'b759835a-acde-4cd3-8bb8-2c74c222667e',
      global_time_reference: '2026-07-28T12:00:00.000Z',
      consent_acceptance_id: 'a790af38-acde-48d9-8bdb-99d6a93957c1'
    });
  });
  try {
    const res = response();
    await handler(
      request(
        'POST',
        '/respondent/questionnaires/24b68c24-acde-49d0-8a16-6cfd95d19328/start',
        { questionnaire_version: 3, language: 'ru', explicit_acceptance: true }
      ),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(
      rpcBody.p_respondent_account_id,
      '23572089-acde-4b51-8566-f770a0be2c3c'
    );
    assert.equal(rpcBody.p_questionnaire_version, 3);
    assert.equal(rpcBody.p_requested_language, 'ru');
    assert.equal(rpcBody.p_explicit_acceptance, true);
    assert.equal(Object.hasOwn(rpcBody, 'consent_record'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('questionnaire packages require a pinned consent version', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
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
    await handler(
      {
        ...request('POST', '/questionnaires/save', {
          schema: 'research_os.questionnaire',
          schema_version: 1,
          questionnaire_id: '24b68c24-acde-49d0-8a16-6cfd95d19328',
          global_time_reference: '2026-07-28T12:00:00.000Z',
          items: [],
          routing: { nodes: {} }
        }),
        headers: {
          host: 'research-os.test',
          authorization: 'Bearer researcher-token'
        }
      },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /consent binding/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('respondent pages contain no Health Model or simulated AI flow', async () => {
  const [cabinet, assessment] = await Promise.all([
    fs.readFile(new URL('../cabinet.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(cabinet, /Health Model|AI Assistant|ИИ-Ассистент/);
  assert.doesNotMatch(assessment, /Health Model|\/pilot\/questionnaire-banks|consent_record/);
  assert.match(cabinet, /Прочитать согласие и начать/);
  assert.match(assessment, /questionnaire_item_id/);
});

test('login returns a gateway timeout when authentication storage stalls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  try {
    const res = response();
    await handler(
      request('POST', '/auth/login', {
        username: 'respondent',
        password: 'not-a-real-password',
        expected_role: 'respondent'
      }),
      res
    );
    assert.equal(res.statusCode, 504);
    assert.match(res.payload.error, /did not respond in time/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('login interface recovers from an authentication timeout', async () => {
  const [authSource, loginSource] = await Promise.all([
    fs.readFile(new URL('../auth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../login.html', import.meta.url), 'utf8')
  ]);
  assert.match(authSource, /AUTH_REQUEST_TIMEOUT_MS/);
  assert.match(authSource, /controller\.abort\(\)/);
  assert.match(loginSource, /AUTH_REQUEST_TIMEOUT/);
  assert.match(loginSource, /finally\{submitButton\.disabled=false\}/);
});
