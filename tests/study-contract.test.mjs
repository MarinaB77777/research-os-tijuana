import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');
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

function researcherRequest(url, body) {
  return {
    method: 'POST',
    url,
    body,
    headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
  };
}

function researcherAccessThen(next) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (call === 1) {
      return jsonFetch([{
        session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    if (call === 2) {
      return jsonFetch([{
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        username: 'researcher',
        user_identifier: 'RESEARCHER-001',
        role: 'researcher',
        status: 'active',
        created_by_account_id: null
      }]);
    }
    return next(url, options, call);
  };
}

test('study save keeps study and questionnaire identities independent', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = researcherAccessThen(async (url, options) => {
    assert.match(url, /rpc\/save_owned_study_package_with_visibility$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      study_id: '9e37af31-acde-4ba9-83c3-f7fe77958322',
      study_version: 1
    });
  });
  try {
    const study = {
      schema: 'research_os.study',
      schema_version: 1,
      study_id: '9e37af31-acde-4ba9-83c3-f7fe77958322',
      version: 1,
      code: 'SOCIAL_SUPPORT',
      title: 'Social support study',
      status: 'trial',
      primary_language: 'es-MX',
      collection_mode: 'fixed_questionnaire_mode',
      longitudinal_linkage: 'within_study_consent_bound',
      global_time_reference: '2026-07-29T18:00:00.000Z',
      generated_at: '2026-07-29T18:00:00.000Z',
      groups: [{
        group_id: 'a7d511ef-acde-4437-8b7d-7c84ebc019d8',
        invitation_id: 'bd382521-acde-4755-8fa1-b0405b6bf628',
        code: 'CONTROL',
        title: 'Control',
        position: 1
      }],
      timepoints: [{
        timepoint_id: '861c7785-acde-48b3-99c4-dd61b0ccadbd',
        code: 'BASELINE',
        title: 'Baseline',
        ordinal: 1,
        planned_offset_iso8601: 'P0D'
      }],
      questionnaire_assignments: [{
        assignment_id: '16d04bf3-acde-4347-91ea-ecbbb8687191',
        timepoint_id: '861c7785-acde-48b3-99c4-dd61b0ccadbd',
        questionnaire_id: '24b68c24-acde-49d0-8a16-6cfd95d19328',
        questionnaire_version: 3,
        position: 1,
        required: true
      }]
    };
    const res = response();
    await handler(researcherRequest('/studies/save', study), res);
    assert.equal(res.statusCode, 200);
    assert.equal(rpcBody.study_data.study_id, study.study_id);
    assert.equal(rpcBody.p_catalog_visibility, 'existence_only');
    assert.equal(Object.hasOwn(rpcBody.study_data, 'catalog_visibility'), false);
    assert.notEqual(
      rpcBody.study_data.study_id,
      rpcBody.study_data.questionnaire_assignments[0].questionnaire_id
    );
    assert.equal(
      rpcBody.study_data.questionnaire_assignments[0].timepoint_id,
      study.timepoints[0].timepoint_id
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server rejects an active study without a scientific minimum analyzable sample', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async () => {
    throw new Error('Invalid protocol must not reach the database RPC');
  });
  try {
    const res = response();
    await handler(researcherRequest('/studies/save', {
      schema: 'research_os.study', schema_version: 1,
      study_id: '9e37af31-acde-4ba9-83c3-f7fe77958322', version: 1,
      code: 'ACTIVE_STUDY', title: 'Active study', status: 'active',
      primary_language: 'es-MX', collection_mode: 'fixed_questionnaire_mode',
      longitudinal_linkage: 'none', global_time_reference: '2026-08-11T18:00:00.000Z',
      generated_at: '2026-08-11T18:00:00.000Z',
      study_design: {
        design_type: 'cross_sectional', objective: 'Measure the outcome',
        research_questions: ['What is the outcome?'], hypotheses: [],
        target_sample_size: 100, minimum_analyzable_sample: null,
        inclusion_criteria: [], exclusion_criteria: []
      },
      groups: [{
        group_id: 'a7d511ef-acde-4437-8b7d-7c84ebc019d8',
        invitation_id: 'bd382521-acde-4755-8fa1-b0405b6bf628',
        code: 'GROUP_1', title: 'Group 1', position: 1
      }],
      timepoints: [{
        timepoint_id: '861c7785-acde-48b3-99c4-dd61b0ccadbd',
        code: 'BASELINE', title: 'Baseline', ordinal: 1,
        planned_offset_iso8601: 'P0D'
      }],
      questionnaire_assignments: [{
        assignment_id: '16d04bf3-acde-4347-91ea-ecbbb8687191',
        timepoint_id: '861c7785-acde-48b3-99c4-dd61b0ccadbd',
        questionnaire_id: '24b68c24-acde-49d0-8a16-6cfd95d19328',
        questionnaire_version: 1, position: 1, required: true,
        available_from: null, available_until: null
      }]
    }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /minimum analyzable sample/i);
    assert.match(res.payload.error, /inclusion criterion/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('study contract stores interval group history and session snapshots', async () => {
  const migration = await fs.readFile(
    new URL('../supabase/research_study_contract_v1.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /research_study_group_memberships/);
  assert.match(migration, /valid_from timestamptz not null/);
  assert.match(migration, /valid_until timestamptz/);
  assert.match(migration, /research_study_one_current_group/);
  assert.match(migration, /group_membership_id uuid/);
  assert.match(migration, /timepoint_id uuid/);
  assert.match(migration, /participant_measurement_id uuid/);
  assert.doesNotMatch(
    migration,
    /p_questionnaire_id::text,\s*p_questionnaire_id,\s*p_questionnaire_version/
  );
});

test('answers preserve per-question observed time and complete atomically', async () => {
  const [assessment, api, migration] = await Promise.all([
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/research_study_contract_v1.sql', import.meta.url), 'utf8')
  ]);
  assert.match(assessment, /presentedAt\.set\(item\.item_id,new Date\(\)\.toISOString\(\)\)/);
  assert.match(assessment, /answered_at:answeredNow\.toISOString\(\)/);
  assert.match(assessment, /answered_utc_offset_minutes:-answeredNow\.getTimezoneOffset\(\)/);
  assert.match(assessment, /presented_at:answer\.presented_at/);
  assert.match(api, /Study\/session identity mismatch/);
  assert.match(api, /Number\.isFinite\(presentedTime\)/);
  assert.match(api, /presentedTime > answeredTime/);
  assert.match(migration, /set status = 'completed',\s*completed_at/s);
  assert.match(migration, /research_participant_measurements\s*\n\s*set status = 'completed'/);
  assert.doesNotMatch(api, /Answers were stored but session completion failed/);
});

test('respondent cabinet starts an assigned measurement, not a bare questionnaire', async () => {
  const [cabinet, migration] = await Promise.all([
    fs.readFile(new URL('../cabinet.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/research_study_contract_v1.sql', import.meta.url), 'utf8')
  ]);
  assert.match(cabinet, /\/respondent\/measurements/);
  assert.match(cabinet, /participant_measurement_id/);
  assert.match(cabinet, /timepoint_title/);
  assert.match(cabinet, /group_title/);
  assert.match(migration, /pm\.status in \('scheduled', 'available'\)/);
  assert.match(migration, /pm\.available_from is null or pm\.available_from <= clock_timestamp\(\)/);
});

test('direct questionnaire collection cannot create a second data format', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Retired route must not touch storage');
  };
  try {
    const res = response();
    await handler({
      method: 'POST',
      url: '/respondent/questionnaires/24b68c24-acde-49d0-8a16-6cfd95d19328/start',
      body: { questionnaire_version: 1, language: 'es', explicit_acceptance: true },
      headers: { host: 'research-os.test' }
    }, res);
    assert.equal(res.statusCode, 410);
    assert.match(res.payload.error, /assigned study measurement/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual researcher enrollment is retired', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Retired route must not touch authentication or storage');
  };
  try {
    const res = response();
    await handler(researcherRequest(
      '/studies/9e37af31-acde-4ba9-83c3-f7fe77958322/enrollments',
      {
        study_version: 1,
        respondent_identifier: 'RESPONDENT-001',
        group_id: 'a7d511ef-acde-4437-8b7d-7c84ebc019d8',
        participant_role: 'participant'
      }
    ), res);
    assert.equal(res.statusCode, 410);
    assert.match(res.payload.error, /invitation link or QR code/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('study constructor exposes the complete versioned protocol without weakening collection contracts', async () => {
  const page = await fs.readFile(
    new URL('../constructor_study.html', import.meta.url),
    'utf8'
  );
  assert.match(page, /function readIdentity\(\)/);
  assert.match(page, /study_design/);
  assert.match(page, /research_questions/);
  assert.match(page, /hypotheses/);
  assert.match(page, /minimum_analyzable_sample/);
  assert.match(page, /inclusion_criteria/);
  assert.match(page, /exclusion_criteria/);
  assert.match(page, /eligibility_criteria/);
  assert.match(page, /eligibility_ai_reviews/);
  assert.match(page, /EligibilityCriteria/);
  assert.match(page, /sendRequestDetailed\('study_design'/);
  assert.match(page, /available_from/);
  assert.match(page, /available_until/);
  assert.match(page, /required:a\.required!==false/);
  assert.match(page, /function createNewVersion\(\)/);
  assert.match(page, /next\.groups\.forEach\(g=>g\.invitation_id=RC\.createUuid\(\)\)/);
  assert.match(page, /next\.questionnaire_assignments\.forEach\(a=>a\.assignment_id=RC\.createUuid\(\)\)/);
  assert.match(page, /loaded&&state\?\.status==='active'/);
  assert.match(page, /research_os\.study/);
  assert.match(page, /CRM Sharks &amp; Ray/);
  assert.doesNotMatch(page, /localStorage\.setItem\([^)]*study/i);
});
