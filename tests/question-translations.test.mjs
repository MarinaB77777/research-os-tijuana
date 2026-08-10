import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

const apiSource = await fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8');
const handler = (await import(
  `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`
)).default;

const researcherId = 'a22cb0be-acde-42c4-86aa-a1c023b0c329';
const bankId = '7010261c-acde-4f36-9ee5-25c038bd607a';
const questionId = '7dc963f0-acde-4816-9935-b6c0b39035f4';
const questionnaireId = '24b68c24-acde-49d0-8a16-6cfd95d19328';
const itemId = 'e7023349-acde-4c83-93cc-63845a15d766';

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
    headers: { get: () => 'application/json' },
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
      account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: researcherId,
      username: 'researcher',
      user_identifier: 'RESEARCHER-001',
      role: 'researcher',
      status: 'active',
      created_by_account_id: null
    }]);
    return next(url, options, call);
  };
}

const sourceQuestion = {
  question_id: questionId,
  version: 1,
  code: 'Q_SUPPORT',
  prompt: 'How supported do you feel?',
  type: 'single_select',
  status: 'active',
  scale: { id: 'likert_5', psychometric_level: 'ordinal', min: 1, max: 5, step: 1 },
  options: [1, 2, 3, 4, 5].map(value => ({ value, text: String(value) }))
};

function translationDocument() {
  return {
    schema: 'research_os.question_bank',
    schema_version: 2,
    bank_id: bankId,
    version: 1,
    code: 'SUPPORT',
    title: 'Apoyo',
    status: 'active',
    primary_language: 'es-MX',
    questions: {
      Q_SUPPORT: {
        ...sourceQuestion,
        prompt: '¿Qué tanto apoyo siente?',
        options: sourceQuestion.options.map(option => ({ ...option, text: `Opción ${option.value}` }))
      }
    },
    question_order: ['Q_SUPPORT'],
    translation_provenance: {
      schema: 'research_os.ai_translation_provenance',
      schema_version: 1,
      source_identity: { schema: 'research_os.question_bank', bank_id: bankId, code: 'SUPPORT', version: 1 },
      source_primary_language: 'en-US',
      target_language: 'es-MX',
      source_sha256: 'a'.repeat(64),
      human_disposition: {
        status: 'accepted',
        researcher_account_id: researcherId,
        decided_at: '2026-08-09T20:00:00.000Z'
      }
    }
  };
}

test('accepted translation is structurally verified and saved beside the source', async () => {
  const originalFetch = globalThis.fetch;
  let saveBody;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    if (call === 3) {
      assert.match(url, /rpc\/load_question_definitions_for_translation$/);
      return jsonFetch({ [`${questionId}:1`]: sourceQuestion });
    }
    assert.equal(call, 4);
    assert.match(url, /rpc\/save_accepted_question_translation_package$/);
    saveBody = JSON.parse(options.body);
    return jsonFetch({
      translation_package_id: '3e66454f-acde-437b-9ae2-fd3529b977ba',
      translation_version: 1,
      target_language: 'es-MX',
      saved_question_count: 1
    });
  });
  try {
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: translationDocument(),
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(saveBody.p_researcher_account_id, researcherId);
    assert.equal(saveBody.translation_data.questions.Q_SUPPORT.prompt, '¿Qué tanto apoyo siente?');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translation cannot change scale values or response structure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    assert.equal(call, 3);
    return jsonFetch({ [`${questionId}:1`]: sourceQuestion });
  });
  try {
    const translated = translationDocument();
    translated.questions.Q_SUPPORT.options[0].value = 99;
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: translated,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /immutable structure/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bank language loading requires a complete accepted translation set', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    if (call === 3) return jsonFetch({
      schema: 'research_os.question_bank', schema_version: 2, bank_id: bankId,
      version: 1, code: 'SUPPORT', title: 'Support', status: 'active',
      primary_language: 'en-US', questions: { Q_SUPPORT: sourceQuestion },
      question_order: ['Q_SUPPORT']
    });
    assert.equal(call, 4);
    return jsonFetch({});
  });
  try {
    const res = response();
    await handler({
      method: 'GET',
      url: `/question-banks/${bankId}?version=1&lang=es-MX`,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.payload.missing_question_codes, ['Q_SUPPORT']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saved translation catalog is discoverable and enriches the bank language selector', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url) => {
    call += 1;
    if (call === 1) {
      assert.match(url, /rpc\/list_question_banks$/);
      return jsonFetch([{
        bank_id: bankId, version: 1, code: 'SUPPORT', title: 'Support',
        status: 'active', primary_language: 'en-US', reuse_permission: 'attribution_permitted'
      }]);
    }
    if (call === 2) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 3) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    if (call === 4) {
      assert.match(url, /research_os_entity_ownership/);
      return jsonFetch([{ entity_id: bankId }]);
    }
    assert.equal(call, 5);
    assert.match(url, /rpc\/list_question_translation_catalog$/);
    return jsonFetch({
      packages: [],
      bank_languages: [
        { source_entity_id: bankId, source_version: 1, language: 'en-US', is_source: true },
        { source_entity_id: bankId, source_version: 1, language: 'es-MX', is_source: false,
          expected_question_count: 1, translated_question_count: 1 }
      ],
      questionnaire_languages: []
    });
  };
  try {
    const res = response();
    await handler({
      method: 'GET', url: '/question-banks',
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.banks[0].available_languages.map(row => row.language), ['en-US', 'es-MX']);
    assert.equal(res.payload.banks[0].source_language, 'en-US');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translation registry endpoint returns the researcher-scoped saved package', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    assert.equal(call, 3);
    assert.match(url, /rpc\/list_question_translation_catalog$/);
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.p_researcher_account_id, researcherId);
    return jsonFetch({
      packages: [{
        translation_package_id: '3e66454f-acde-437b-9ae2-fd3529b977ba',
        source_schema: 'research_os.question_bank', source_entity_id: bankId,
        source_version: 1, source_language: 'en-US', target_language: 'es-MX',
        translation_version: 1, expected_question_count: 1,
        translated_question_count: 1, coverage_complete: true
      }],
      bank_languages: [], questionnaire_languages: []
    });
  });
  try {
    const res = response();
    await handler({
      method: 'GET', url: '/question-translations',
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.packages.length, 1);
    assert.equal(res.payload.packages[0].coverage_complete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepted questionnaire language loads translated snapshots without changing routing identity', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  const sourceQuestionnaire = {
    schema: 'research_os.questionnaire', schema_version: 1,
    questionnaire_id: questionnaireId, version: 1, code: 'SUPPORT_SURVEY',
    title: 'Support survey', status: 'active', primary_language: 'en-US',
    items: [{
      item_id: itemId, question_id: questionId, question_version: 1,
      source_bank_id: bankId, source_bank_version: 1, code: 'Q_SUPPORT',
      definition_snapshot: sourceQuestion
    }],
    start_item_id: itemId,
    routing: { nodes: { [itemId]: { default_target: 'end', rules: [] } } }
  };
  globalThis.fetch = async (url) => {
    call += 1;
    if (call === 1) {
      assert.match(url, /rpc\/load_questionnaire_package$/);
      return jsonFetch(sourceQuestionnaire);
    }
    if (call === 2) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 3) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    if (call === 4) {
      assert.match(url, /rpc\/load_question_translation_variants$/);
      return jsonFetch({
        [`${questionId}:1`]: {
          translated_definition: {
            ...sourceQuestion,
            prompt: '¿Qué tanto apoyo siente?',
            options: sourceQuestion.options.map(option => ({ ...option, text: `Opción ${option.value}` }))
          },
          translation_reference: {
            translation_package_id: '3e66454f-acde-437b-9ae2-fd3529b977ba',
            translation_version: 1, target_language: 'es-MX'
          }
        }
      });
    }
    assert.equal(call, 5);
    assert.match(url, /rpc\/load_question_translation_document$/);
    return jsonFetch({ title: 'Encuesta de apoyo', description: 'Descripción traducida' });
  };
  try {
    const res = response();
    await handler({
      method: 'GET',
      url: `/questionnaires/${questionnaireId}?version=1&lang=es-MX`,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.questionnaire.primary_language, 'es-MX');
    assert.equal(res.payload.questionnaire.title, 'Encuesta de apoyo');
    assert.equal(res.payload.questionnaire.items[0].definition_snapshot.prompt, '¿Qué tanto apoyo siente?');
    assert.equal(res.payload.questionnaire.items[0].item_id, itemId);
    assert.deepEqual(res.payload.questionnaire.routing, sourceQuestionnaire.routing);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translation migration and UI retain immutable source and provenance', async () => {
  const [migration, catalogMigration, translator, constructor, assessment, vercel] = await Promise.all([
    fs.readFile(new URL('../supabase/question_translation_variants_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_translation_catalog_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../translator.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /question_id uuid not null/);
  assert.match(migration, /target_language text not null/);
  assert.match(migration, /translation_version integer not null/);
  assert.match(migration, /references public\.question_definitions\(question_id, version\) on delete restrict/);
  assert.match(translator, /saveAcceptedTranslation\(\)/);
  assert.match(translator, /\/question-translations\/save/);
  assert.match(translator, /Translation Registry/);
  assert.match(translator, /loadTranslationRegistry\(\)/);
  assert.match(translator, /Coverage:/);
  assert.match(catalogMigration, /list_question_translation_catalog/);
  assert.match(catalogMigration, /coverage_complete/);
  assert.match(catalogMigration, /having count\(distinct/);
  assert.match(constructor, /questionnaireLanguage/);
  assert.match(constructor, /id="bankLanguage"/);
  assert.match(constructor, /id="savedQuestionnaireLanguage"/);
  assert.match(constructor, /available_languages/);
  assert.match(constructor, /&lang=/);
  assert.match(assessment, /question_translation_references/);
  assert.match(assessment, /questionnaire_primary_language/);
  assert.match(vercel, /"source": "\/question-translations"/);
});
