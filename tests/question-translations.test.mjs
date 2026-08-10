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

test('translation migration and UI retain immutable source and provenance', async () => {
  const [migration, translator, constructor, assessment] = await Promise.all([
    fs.readFile(new URL('../supabase/question_translation_variants_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../translator.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /question_id uuid not null/);
  assert.match(migration, /target_language text not null/);
  assert.match(migration, /translation_version integer not null/);
  assert.match(migration, /references public\.question_definitions\(question_id, version\) on delete restrict/);
  assert.match(translator, /saveAcceptedTranslation\(\)/);
  assert.match(translator, /\/question-translations\/save/);
  assert.match(constructor, /questionnaireLanguage/);
  assert.match(constructor, /missing|lang=/);
  assert.match(assessment, /question_translation_references/);
  assert.match(assessment, /questionnaire_primary_language/);
});
