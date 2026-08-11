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
        created_by_account_id: null
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
        '/respondent/measurements/24b68c24-acde-49d0-8a16-6cfd95d19328/start',
        { language: 'es', explicit_acceptance: false }
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
    assert.match(url, /rpc\/accept_consent_and_start_measurement$/);
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
        '/respondent/measurements/24b68c24-acde-49d0-8a16-6cfd95d19328/start',
        { language: 'ru', explicit_acceptance: true }
      ),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(
      rpcBody.p_respondent_account_id,
      '23572089-acde-4b51-8566-f770a0be2c3c'
    );
    assert.equal(
      rpcBody.p_participant_measurement_id,
      '24b68c24-acde-49d0-8a16-6cfd95d19328'
    );
    assert.equal(rpcBody.p_requested_language, 'ru');
    assert.equal(rpcBody.p_explicit_acceptance, true);
    assert.equal(Object.hasOwn(rpcBody, 'consent_record'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('study invitation join uses the authenticated respondent without starting a session', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = respondentAccessFetches(async (url, options) => {
    assert.match(url, /rpc\/join_study_by_invitation$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      enrollment_id: '00edfb1a-acde-4dc1-a448-d50cc1e29f16',
      created_measurements: 2,
      idempotent: false
    });
  });
  try {
    const res = response();
    await handler(
      request(
        'POST',
        '/respondent/studies/join/bd382521-acde-4755-8fa1-b0405b6bf628',
        undefined
      ),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(
      rpcBody.p_respondent_account_id,
      '23572089-acde-4b51-8566-f770a0be2c3c'
    );
    assert.equal(
      rpcBody.p_invitation_id,
      'bd382521-acde-4755-8fa1-b0405b6bf628'
    );
    assert.equal(Object.hasOwn(rpcBody, 'p_explicit_acceptance'), false);
    assert.equal(Object.hasOwn(rpcBody, 'p_requested_language'), false);
    assert.equal(Object.hasOwn(rpcBody, 'respondent_identifier'), false);
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
  assert.match(loginSource, /auth_unavailable/);
  assert.match(authSource, /AUTH_REQUEST_TIMEOUT_MS = 35000/);
});

test('authenticated account closure revokes access without deleting research records', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = respondentAccessFetches(async (url, options) => {
    assert.match(url, /rpc\/close_research_os_account$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({ closed_at: '2026-08-02T12:00:00.000Z' });
  });
  try {
    const res = response();
    await handler(request('DELETE', '/account', { password: 'current-password' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.role, 'respondent');
    assert.equal(rpcBody.p_account_id, '23572089-acde-4b51-8566-f770a0be2c3c');
    assert.equal(rpcBody.p_password, 'current-password');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account closure contract anonymizes login and preserves referenced records', async () => {
  const [migration, authSource, cabinet, settings] = await Promise.all([
    fs.readFile(new URL('../supabase/account_closure_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../auth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../cabinet.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../settings.html', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /status in \('active', 'suspended', 'revoked', 'deleted'\)/);
  assert.match(migration, /username = 'deleted_'/);
  assert.match(migration, /update public\.research_os_auth_sessions/);
  assert.match(migration, /Active research must be closed or transferred/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.research_os_accounts/i);
  assert.match(authSource, /DELETE/);
  assert.match(cabinet, /deleteAccount\(\)/);
  assert.match(settings, /deleteResearcherAccount\(\)/);
});

test('public respondent registration creates its account and session atomically', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /rpc\/register_research_os_account$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      account_id: '23572089-acde-4b51-8566-f770a0be2c3c',
      username: 'new.respondent',
      role: 'respondent',
      user_identifier: 'RSP-0ea04476fdac4b89a4c9df9451cb25d2',
      expires_at: '2099-01-01T00:00:00.000Z'
    });
  };
  try {
    const res = response();
    await handler(
      request('POST', '/auth/register', {
        username: 'New.Respondent',
        password: 'a-valid-password',
        role: 'respondent'
      }),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.role, 'respondent');
    assert.equal(res.payload.user_identifier, 'RSP-0ea04476fdac4b89a4c9df9451cb25d2');
    assert.equal(rpcBody.p_role, 'respondent');
    assert.match(rpcBody.p_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(rpcBody, 'p_created_by_account_id'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public researcher registration creates an independent researcher session', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /rpc\/register_research_os_account$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
      username: 'new.researcher',
      role: 'researcher',
      user_identifier: 'RSR-1ea04476fdac4b89a4c9df9451cb25d2',
      expires_at: '2099-01-01T00:00:00.000Z'
    });
  };
  try {
    const res = response();
    await handler(
      request('POST', '/auth/register', {
        username: 'New.Researcher',
        password: 'a-valid-password',
        role: 'researcher'
      }),
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.role, 'researcher');
    assert.match(res.payload.user_identifier, /^RSR-/);
    assert.equal(rpcBody.p_role, 'researcher');
    assert.equal(Object.hasOwn(rpcBody, 'p_created_by_account_id'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public registration rejects every role outside researcher and respondent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('An invalid public role must not reach storage');
  };
  try {
    const res = response();
    await handler(
      request('POST', '/auth/register', {
        username: 'attempted.admin',
        password: 'a-valid-password',
        role: 'admin'
      }),
      res
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /researcher or respondent/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('self-registered accounts preserve role isolation and respondents join by invitation', async () => {
  const [registrationMigration, studyMigration, registerPage, studyPage, joinPage, loginSource, authSource] = await Promise.all([
    fs.readFile(new URL('../supabase/public_account_registration_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/research_study_contract_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../register.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_study.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../join-study.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../login.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../auth.js', import.meta.url), 'utf8')
  ]);
  assert.match(registrationMigration, /register_research_os_account/);
  assert.match(registrationMigration, /p_role not in \('researcher', 'respondent'\)/);
  assert.match(registrationMigration, /created_by_account_id\s*\)\s*values\s*\([\s\S]*null/i);
  assert.match(registrationMigration, /to service_role/);
  assert.match(registrationMigration, /from public, anon, authenticated/);
  assert.match(studyMigration, /research_study_invitations/);
  assert.match(studyMigration, /join_study_by_invitation/);
  assert.match(studyMigration, /accept_consent_and_start_measurement/);
  assert.match(studyMigration, /p_explicit_acceptance is distinct from true/);
  assert.match(registerPage, /registerAccount/);
  assert.match(registerPage, /value="researcher"/);
  assert.match(loginSource, /role=\$\{encodeURIComponent\(expectedRole\)\}/);
  assert.match(loginSource, /href="register\.html"/);
  assert.match(authSource, /\/api\/auth\/register/);
  assert.match(studyPage, /join-study\.html\?invite=/);
  assert.match(studyPage, /\/qr\.svg/);
  assert.doesNotMatch(studyPage, /id="respondentId"/);
  assert.doesNotMatch(joinPage, /explicit_acceptance/);
  assert.match(joinPage, /role=respondent/);
  assert.match(joinPage, /location\.replace\('cabinet\.html'\)/);
});
