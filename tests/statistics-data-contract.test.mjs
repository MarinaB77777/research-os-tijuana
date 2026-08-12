import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');
const handler = (await import(`data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`)).default;

function jsonFetch(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => payload, text: async () => JSON.stringify(payload) };
}
function response() { return { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; }, send(payload) { this.payload = payload; return this; } }; }

test('analysis records endpoint binds the study dataset to the authenticated researcher', async () => {
  const originalFetch = globalThis.fetch;
  const studyId = '11111111-1111-4111-8111-111111111111';
  const accountId = '22222222-2222-4222-8222-222222222222';
  let call = 0;
  let rpcBody;
  globalThis.fetch = async (url, options) => {
    call += 1;
    if (call === 1) return jsonFetch([{ session_id: '33333333-3333-4333-8333-333333333333', account_id: accountId, expires_at: '2099-01-01T00:00:00Z', revoked_at: null }]);
    if (call === 2) return jsonFetch([{ account_id: accountId, user_identifier: 'RESEARCHER-1', role: 'researcher', status: 'active' }]);
    assert.match(url, /rpc\/load_researcher_analysis_records$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch([{ session_id: '44444444-4444-4444-8444-444444444444', participant_id: 'P1', value: 3 }]);
  };
  try {
    const res = response();
    await handler({ method: 'GET', url: `/analysis/studies/${studyId}/records?version=2`, body: null, headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(rpcBody.p_researcher_account_id, accountId);
    assert.equal(rpcBody.p_study_id, studyId);
    assert.equal(rpcBody.p_study_version, 2);
    assert.equal(res.payload.records.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('database analysis contract admits only completed sessions from an owned study', async () => {
  const migration = await fs.readFile(new URL('../supabase/statistical_analysis_contract_v1.sql', import.meta.url), 'utf8');
  assert.match(migration, /research_os_entity_ownership/);
  assert.match(migration, /researcher_account_id = p_researcher_account_id/);
  assert.match(migration, /session\.status = 'completed'/);
  assert.doesNotMatch(migration, /status in \('active',\s*'completed'/);
  assert.match(migration, /global_time_reference/);
  assert.match(migration, /questionnaire_item_id/);
  assert.match(migration, /question_version/);
  assert.match(migration, /'question_prompt', question\.definition -> 'prompt'/);
  assert.match(migration, /'question_domain', question\.definition -> 'domain'/);
  assert.match(migration, /'question_parameter', question\.definition -> 'parameter'/);
  assert.match(migration, /response\.question_id::text \|\| ':v' \|\| response\.question_version::text/);
});

test('statistical page has no fabricated startup result and exposes the complete method set', async () => {
  const page = await fs.readFile(new URL('../data-analysis.html', import.meta.url), 'utf8');
  assert.match(page, /await import\('\.\/analyticsCore\.js'\)/);
  for (const method of ['pearsonCorrelation','spearmanCorrelation','welchTTest','mannWhitney','oneWayAnova','kruskalWallis','pairedTTest','fisherExact','chiSquareIndependence']) assert.match(page, new RegExp(method));
  assert.match(page, /\/analysis\/studies\//);
  assert.match(page, /ResearchAuth\.requireRole\('researcher'/);
  assert.match(page, /question_prompt/);
  assert.match(page, /subject_by_study_timepoint/);
  assert.match(page, /laggedPearson/);
  assert.match(page, /changeSpearman/);
  assert.doesNotMatch(page, /"participant_id": "P_01"/);
  assert.doesNotMatch(page, /Условия применимости статистического метода соблюдены/);
  assert.match(page, /CRM Sharks &amp; Ray AI/);
});

test('statistical planning blocks methods that conflict with psychometric level', async () => {
  const page = await fs.readFile(new URL('../data-analysis.html', import.meta.url), 'utf8');
  assert.match(page, /methodMeasurementError/);
  assert.match(page, /level!=='interval_ratio'/);
  assert.match(page, /!\['ordinal','interval_ratio'\]\.includes\(level\)/);
  assert.match(page, /!\['nominal','ordinal'\]\.includes\(level\)/);
  assert.match(page, /numeric category codes are not continuous measurements/);
});

test('statistical page forms reproducible groups from canonical questionnaire answers', async () => {
  const page = await fs.readFile(new URL('../data-analysis.html', import.meta.url), 'utf8');
  assert.match(page, /value="derived_group"/);
  assert.match(page, /function applyDerivedGroupMemberships\(\)/);
  assert.match(page, /group\.rules\.every/);
  assert.match(page, /rule\.variable_key/);
  assert.match(page, /rule\.timepoint_code/);
  assert.match(page, /is_missing/);
  assert.match(page, /between/);
  assert.match(page, /derived_group_definitions/);
  assert.match(page, /satisfy more than one selected answer-based group/);
  assert.match(page, /button\.classList\.toggle\('active'/);
  assert.ok(page.indexOf("applyLanguage(storedLanguage()") < page.indexOf("await import('./analyticsCore.js')"), 'language controls must initialize before the statistics engine');
  assert.match(page, /<details class="technical"><summary id="technicalSummary">/);
  assert.doesNotMatch(page, /placeholder="Buscar por código, UUID o escala"/);
});
