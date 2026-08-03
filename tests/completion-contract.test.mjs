import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');
const handler = (await import(
  `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`
)).default;

const IDS = {
  session: '11111111-1111-4111-8111-111111111111',
  account: '22222222-2222-4222-8222-222222222222',
  questionnaire: '33333333-3333-4333-8333-333333333333',
  item1: '44444444-4444-4444-8444-444444444444',
  item2: '55555555-5555-4555-8555-555555555555',
  bank: '66666666-6666-4666-8666-666666666666',
  question1: '77777777-7777-4777-8777-777777777777',
  question2: '88888888-8888-4888-8888-888888888888',
  response1: '99999999-9999-4999-8999-999999999999',
  response2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  rule: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};
const startedAt = '2026-08-01T18:00:00.000Z';

function jsonFetch(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    send(payload) { this.payload = payload; return this; }
  };
}

function questionnaire() {
  return {
    schema: 'research_os.questionnaire',
    schema_version: 1,
    questionnaire_id: IDS.questionnaire,
    version: 1,
    start_item_id: IDS.item1,
    completion_policy: { minimum_answered_items: 1, require_terminal_route: true },
    items: [
      { item_id: IDS.item1, position: 1, required: true, definition_snapshot: {
        type: 'single_select', options: [{ value: 'continue', text: 'Continue' }, { value: 'stop', text: 'Stop' }],
        scale: { id: 'single_choice', psychometric_level: 'nominal' }
      } },
      { item_id: IDS.item2, position: 2, required: true, definition_snapshot: {
        type: 'text_input', options: [], scale: { id: 'short_string', psychometric_level: 'textual' }
      } }
    ],
    routing: {
      nodes: {
        [IDS.item1]: {
          default_target: 'next',
          rules: [{ rule_id: IDS.rule, operator: 'equals', value: 'stop', target: 'end' }]
        },
        [IDS.item2]: { default_target: 'end', rules: [] }
      }
    }
  };
}

function sourceIdentity(routeItemIds) {
  return {
    session_id: IDS.session,
    participant_id: 'RESPONDENT-001',
    questionnaire_id: IDS.questionnaire,
    questionnaire_version: 1,
    study_id: null,
    study_version: null,
    enrollment_id: null,
    participant_measurement_id: null,
    study_questionnaire_assignment_id: null,
    timepoint_id: null,
    timepoint_code: null,
    timepoint_ordinal: null,
    group_membership_id: null,
    group_id: null,
    group_code: null,
    subject_link_id: null,
    route_item_ids: routeItemIds,
    completion_policy_snapshot: { minimum_answered_items: 1, require_terminal_route: true },
    collection_started_at: startedAt,
    collection_finished_at: '2026-08-01T18:02:00.000Z',
    global_time_reference: startedAt
  };
}

function answer(itemId, questionId, responseId, value, minute = '01') {
  return {
    response_id: responseId,
    session_id: IDS.session,
    participant_id: 'RESPONDENT-001',
    questionnaire_item_id: itemId,
    bank_id: IDS.bank,
    bank_version: 1,
    question_id: questionId,
    question_version: 1,
    code: itemId === IDS.item1 ? 'Q1' : 'Q2',
    value,
    presented_at: '2026-08-01T18:00:30.000Z',
    answered_at: `2026-08-01T18:${minute}:00.000Z`,
    answered_utc_offset_minutes: -360,
    global_time_reference: startedAt
  };
}

function authenticatedFetch(questionnairePackage, onRpc) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (call === 1) return jsonFetch([{
      session_id: IDS.session,
      account_id: IDS.account,
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: IDS.account,
      username: 'respondent',
      user_identifier: 'RESPONDENT-001',
      role: 'respondent',
      status: 'active'
    }]);
    if (call === 3) return jsonFetch([{
      session_id: IDS.session,
      global_time_reference: startedAt,
      started_at: startedAt,
      questionnaire_id: IDS.questionnaire,
      questionnaire_version: 1,
      study_id: null,
      study_version: null,
      enrollment_id: null,
      participant_measurement_id: null,
      study_questionnaire_assignment_id: null,
      timepoint_id: null,
      timepoint_code: null,
      timepoint_ordinal: null,
      group_membership_id: null,
      group_id: null,
      group_code: null,
      subject_link_id: null
    }]);
    if (call === 4) return jsonFetch([{ package_data: questionnairePackage }]);
    return onRpc(url, options, call);
  };
}

async function submit(records, route, onRpc = async () => jsonFetch({ saved_count: records.length }), questionnairePackage = questionnaire()) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = authenticatedFetch(questionnairePackage, onRpc);
  try {
    const res = response();
    await handler({
      method: 'POST',
      url: `/pilot/sessions/${IDS.session}/answers`,
      body: {
        domain_data_identity: sourceIdentity(route),
        response_records: records
      },
      headers: { host: 'research-os.test', authorization: 'Bearer respondent-token' }
    }, res);
    return res;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a partial default route cannot complete after only one answer', async () => {
  let rpcCalled = false;
  const res = await submit(
    [answer(IDS.item1, IDS.question1, IDS.response1, 'continue')],
    [IDS.item1],
    async () => { rpcCalled = true; return jsonFetch({}); }
  );
  assert.equal(res.statusCode, 422);
  assert.match(res.payload.error, /required questionnaire item/i);
  assert.equal(rpcCalled, false);
});

test('a legitimate terminal branch completes with its exact routed answers', async () => {
  let rpcBody;
  const res = await submit(
    [answer(IDS.item1, IDS.question1, IDS.response1, 'stop')],
    [IDS.item1],
    async (url, options) => {
      assert.match(url, /rpc\/save_response_records$/);
      rpcBody = JSON.parse(options.body);
      return jsonFetch({ saved_count: 1, session_status: 'completed' });
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(rpcBody.source_identity.route_item_ids, [IDS.item1]);
  assert.equal(rpcBody.response_records.length, 1);
});

test('responses from an untraversed branch are rejected', async () => {
  const res = await submit([
    answer(IDS.item1, IDS.question1, IDS.response1, 'stop'),
    answer(IDS.item2, IDS.question2, IDS.response2, 'extra', '01')
  ], [IDS.item1]);
  assert.equal(res.statusCode, 422);
  assert.match(res.payload.error, /outside the completed route/i);
});

test('server rejects a forged numeric response outside the registered scale contract', async () => {
  const numericQuestionnaire = questionnaire();
  numericQuestionnaire.items = [{
    item_id: IDS.item1,
    position: 1,
    required: true,
    definition_snapshot: {
      type: 'numeric_input', options: [],
      scale: { id: 'percentage_share', psychometric_level: 'interval_ratio', min: 0, max: 100, step: 1, unit: '%' }
    }
  }];
  numericQuestionnaire.routing.nodes = { [IDS.item1]: { default_target: 'end', rules: [] } };
  const res = await submit(
    [answer(IDS.item1, IDS.question1, IDS.response1, 101)],
    [IDS.item1],
    async () => jsonFetch({ saved_count: 1 }),
    numericQuestionnaire
  );
  assert.equal(res.statusCode, 422);
  assert.match(res.payload.error, /outside the scale range/i);
});

test('null and empty payloads cannot impersonate completed answers', async () => {
  for (const emptyValue of [null, '', '   ', []]) {
    const res = await submit(
      [answer(IDS.item1, IDS.question1, IDS.response1, emptyValue)],
      [IDS.item1, IDS.item2]
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /identity\/time contract/i);
  }
  const completionSql = await fs.readFile(
    new URL('../supabase/collection_completion_contract_v2.sql', import.meta.url),
    'utf8'
  );
  assert.match(completionSql, /v_record -> 'value' = 'null'::jsonb/);
  assert.match(completionSql, /jsonb_array_length\(v_record -> 'value'\) = 0/);
});

test('completion policy is explicit in the constructor and enforced atomically in SQL', async () => {
  const [constructor, assessment, migration] = await Promise.all([
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/collection_completion_contract_v2.sql', import.meta.url), 'utf8')
  ]);
  assert.match(constructor, /minimum_answered_items/);
  assert.match(constructor, /required:item\.required!==false/);
  assert.match(constructor, /routingCycle/);
  assert.match(constructor, /unreachableItems/);
  assert.match(assessment, /route_item_ids:routeItemIds/);
  assert.match(assessment, /item\.required!==false&&!hasAnswer/);
  assert.match(migration, /Submitted route does not match questionnaire routing/);
  assert.match(migration, /A required item on the completed route has no response/);
  assert.match(migration, /set status = 'completed',\s*completed_at/s);
  assert.match(migration, /research_participant_measurements\s*\n\s*set status = 'completed'/);
  assert.match(migration, /set status = 'discarded'/);
  assert.match(migration, /set status = 'missed'/);
  assert.match(assessment, /pagehide/);
  assert.match(assessment, /discardIncompleteSession/);
  assert.match(assessment, /type="range"/);
  assert.match(assessment, /data-touched/);
  assert.match(assessment, /scaleId==='long_paragraph'/);
  assert.match(assessment, /answerControl\.checkValidity\(\)/);
});

test('respondent exit discards the active session through an owner-bound RPC', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  let rpcBody;
  globalThis.fetch = async (url, options) => {
    call += 1;
    if (call === 1) return jsonFetch([{
      session_id: IDS.session,
      account_id: IDS.account,
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: IDS.account,
      username: 'respondent',
      user_identifier: 'RESPONDENT-001',
      role: 'respondent',
      status: 'active'
    }]);
    assert.match(url, /rpc\/discard_response_session$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({ session_status: 'discarded', measurement_status: 'missed' });
  };
  try {
    const res = response();
    await handler({
      method: 'POST',
      url: `/respondent/sessions/${IDS.session}/discard`,
      body: {},
      headers: { host: 'research-os.test', authorization: 'Bearer respondent-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(rpcBody.p_session_id, IDS.session);
    assert.equal(rpcBody.p_respondent_account_id, IDS.account);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
