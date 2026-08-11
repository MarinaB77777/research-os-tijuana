import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const [catalogPage, researcherCabinet, api, migration, vercel] = await Promise.all([
  fs.readFile(new URL('../question_catalog.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../survey.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../supabase/research_catalog_management_v1.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8')
]);
const handler = (await import(
  `data:text/javascript;base64,${Buffer.from(api).toString('base64')}`
)).default;
const researcherId = 'a22cb0be-acde-42c4-86aa-a1c023b0c329';

function response() {
  return {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    send(payload) { this.payload = payload; return this; }
  };
}

function jsonFetch(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: () => 'application/json' },
    json: async () => payload, text: async () => JSON.stringify(payload)
  };
}

function researcherAccessThen(next) {
  let call = 0;
  return async (url, options) => {
    call += 1;
    if (call === 1) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    return next(url, options, call);
  };
}

test('the existing question catalog is extended with owned versions, translations, drafts, and guarded actions', () => {
  assert.match(catalogPage, /RC\.requestJson\('\/research-catalog'\)/);
  assert.match(catalogPage, /translation_packages/);
  assert.match(catalogPage, /translation_drafts/);
  assert.match(catalogPage, /action:'inspect'/);
  assert.match(catalogPage, /result\.blocker_count/);
  assert.match(catalogPage, /Grouped current entities/);
  assert.match(catalogPage, /All physical records/);
  assert.match(catalogPage, /Архив/);
  assert.match(api, /path === '\/research-catalog'/);
  assert.match(api, /manage_research_catalog_item/);
  assert.match(vercel, /"source": "\/research-catalog"/);
  assert.match(researcherCabinet, /href="question_catalog\.html"/);
});

test('catalog SQL keeps archive reversible and blocks deletion through every scientific dependency path', () => {
  assert.match(migration, /create table if not exists public\.research_catalog_archives/);
  assert.match(migration, /create table if not exists public\.research_catalog_action_log/);
  assert.match(migration, /create or replace function public\.list_research_catalog/);
  assert.match(migration, /create or replace function public\.manage_research_catalog_item/);
  for (const dependency of [
    'questionnaire_items', 'research_response_records', 'parameter_definitions',
    'research_study_questionnaire_assignments', 'research_os_collection_sessions',
    'consent_acceptances', 'question_translation_packages',
    'question_translation_drafts', 'response_provenance'
  ]) assert.match(migration, new RegExp(dependency));
  assert.match(migration, /p_action = 'inspect'/);
  assert.match(migration, /p_action = 'delete' and v_blocker_count = 0/);
  assert.match(migration, /delete from public\.research_catalog_archives/);
  assert.doesNotMatch(migration, /truncate\s/i);
});

test('catalog endpoints bind listing and dependency inspection to the authenticated researcher', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = researcherAccessThen(async (url, options) => {
      assert.match(url, /rpc\/list_research_catalog$/);
      assert.equal(JSON.parse(options.body).p_researcher_account_id, researcherId);
      return jsonFetch({ banks: [], questions: [], questionnaires: [], translation_packages: [], translation_drafts: [] });
    });
    const listResponse = response();
    await handler({ method: 'GET', url: '/research-catalog', headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' } }, listResponse);
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(listResponse.payload.catalog.questions, []);

    globalThis.fetch = researcherAccessThen(async (url, options) => {
      assert.match(url, /rpc\/manage_research_catalog_item$/);
      const body = JSON.parse(options.body);
      assert.equal(body.p_researcher_account_id, researcherId);
      assert.equal(body.p_action, 'inspect');
      return jsonFetch({ completed: true, blocker_count: 2, dependencies: { blocking: { responses: 2 } } });
    });
    const inspectResponse = response();
    await handler({
      method: 'POST', url: '/research-catalog/action',
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' },
      body: { entity_type: 'question_bank', entity_id: '7010261c-acde-4f36-9ee5-25c038bd607a', entity_version: 1, action: 'inspect' }
    }, inspectResponse);
    assert.equal(inspectResponse.statusCode, 200);
    assert.equal(inspectResponse.payload.result.blocker_count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('management API failure does not break the existing bank, questionnaire, language, or duplicate catalog', async () => {
  const script = [...catalogPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(source => source.includes("'use strict'"));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', innerHTML: '', className: '', style: {}, disabled: false,
      value: id === 'managementView' ? 'grouped' : 'all', options: []
    });
    return elements.get(id);
  };
  const requestJson = async url => {
    if (url === '/research-catalog') throw new Error('management endpoint unavailable');
    if (url === '/question-banks') return { banks: [] };
    if (url === '/questionnaires?status=all') return { questionnaires: [] };
    if (url === '/database/contract-audit') return {
      all_available: true, available_table_count: 1, expected_table_count: 1,
      available_rpc_count: 1, expected_rpc_count: 1, missing_tables: [], missing_rpcs: []
    };
    throw new Error(`Unexpected URL ${url}`);
  };
  const context = vm.createContext({
    console,
    window: { ResearchContracts: { researcherToken: () => 'researcher-token', requestJson } },
    document: { getElementById: element, addEventListener() {}, documentElement: { lang: '' } },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams,
    TextEncoder,
    crypto: globalThis.crypto,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(`${script}\nglobalThis.__loadCompleteCatalog=loadCompleteCatalog;`, context);
  await context.__loadCompleteCatalog();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(elements.get('status').textContent, /Catálogo completo cargado/);
  assert.match(elements.get('managementStatus').textContent, /management endpoint unavailable/);
});

test('management catalog keeps the scroll position visible and signals hidden records', () => {
  assert.match(catalogPage, /overflow-y:scroll/);
  assert.match(catalogPage, /scrollbar-color:var\(--cyan2\)/);
  assert.match(catalogPage, /management-list::-webkit-scrollbar-thumb/);
  assert.match(catalogPage, /id="managementScrollHint"/);
  assert.match(catalogPage, /function updateManagementScrollHint\(\)/);
  assert.match(catalogPage, /Ниже есть ещё записи/);
});
