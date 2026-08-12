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
const translationPackageId = '3e66454f-acde-437b-9ae2-fd3529b977ba';

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
  const translatedPaths = [
    ['title'], ['questions', 'Q_SUPPORT', 'prompt'],
    ...[0, 1, 2, 3, 4].map(index => ['questions', 'Q_SUPPORT', 'options', index, 'text'])
  ];
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
      scoped_input: {
        translated_field_count: translatedPaths.length,
        translated_paths: translatedPaths
      },
      human_disposition: {
        status: 'accepted',
        researcher_account_id: researcherId,
        decided_at: '2026-08-09T20:00:00.000Z',
        field_reviews: translatedPaths.map((path, index) => ({
          field_id: `T${index + 1}`, path, status: 'accepted', edited: false,
          reviewed_at: '2026-08-09T19:59:00.000Z'
        }))
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
    assert.equal(saveBody.translation_data.questions.Q_SUPPORT.definition_language, 'es-MX');
    assert.equal(saveBody.translation_data.questions.Q_SUPPORT.translation_reference, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server rejects package acceptance without complete field-by-field researcher review', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async () => {
    throw new Error('No translation database call is allowed for incomplete human review');
  });
  try {
    const incomplete = translationDocument();
    incomplete.translation_provenance.human_disposition.field_reviews.pop();
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: incomplete,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /complete field-by-field researcher review/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepted questionnaire translation normalizes every nested snapshot language before storage', async () => {
  const originalFetch = globalThis.fetch;
  let saveBody;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    if (call === 3) return jsonFetch({ [`${questionId}:1`]: sourceQuestion });
    assert.equal(call, 4);
    assert.match(url, /rpc\/save_accepted_question_translation_package$/);
    saveBody = JSON.parse(options.body);
    return jsonFetch({ translation_package_id: translationPackageId, translation_version: 1 });
  });
  const translated = {
    schema: 'research_os.questionnaire', schema_version: 1,
    questionnaire_id: questionnaireId, version: 1, code: 'SUPPORT_SURVEY',
    title: 'Encuesta de apoyo', primary_language: 'es-MX',
    items: [{
      item_id: itemId, question_id: questionId, question_version: 1,
      source_bank_id: bankId, source_bank_version: 1, code: 'Q_SUPPORT',
      definition_snapshot: {
        ...sourceQuestion,
        prompt: '¿Qué tanto apoyo siente durante el día?',
        options: sourceQuestion.options.map(option => ({ ...option, text: `Opción ${option.value}` })),
        definition_language: 'en-US'
      }
    }],
    translation_provenance: {
      schema: 'research_os.ai_translation_provenance', schema_version: 1,
      source_identity: { schema: 'research_os.questionnaire', questionnaire_id: questionnaireId, code: 'SUPPORT_SURVEY', version: 1 },
      source_primary_language: 'en-US', target_language: 'es-MX', source_sha256: 'c'.repeat(64),
      scoped_input: {
        translated_field_count: 7,
        translated_paths: [
          ['title'], ['items', 0, 'definition_snapshot', 'prompt'],
          ...[0, 1, 2, 3, 4].map(index => ['items', 0, 'definition_snapshot', 'options', index, 'text'])
        ]
      },
      human_disposition: {
        status: 'accepted', researcher_account_id: researcherId,
        decided_at: '2026-08-09T20:00:00.000Z',
        field_reviews: [
          ['title'], ['items', 0, 'definition_snapshot', 'prompt'],
          ...[0, 1, 2, 3, 4].map(index => ['items', 0, 'definition_snapshot', 'options', index, 'text'])
        ].map((path, index) => ({
          field_id: `T${index + 1}`, path, status: 'accepted', edited: false,
          reviewed_at: '2026-08-09T19:59:00.000Z'
        }))
      }
    }
  };
  try {
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: translated,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(saveBody.translation_data.items[0].definition_snapshot.definition_language, 'es-MX');
    assert.equal(saveBody.translation_data.items[0].definition_snapshot.translation_reference, null);
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

test('server rejects a target-language label when AI returned substantially unchanged source text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    assert.equal(call, 3);
    assert.match(url, /rpc\/load_question_definitions_for_translation$/);
    return jsonFetch({ [`${questionId}:1`]: sourceQuestion });
  });
  try {
    const untranslated = translationDocument();
    untranslated.title = 'Support';
    untranslated.questions.Q_SUPPORT = structuredClone(sourceQuestion);
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: untranslated,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 422);
    assert.match(res.payload.error, /substantially unchanged/i);
    assert.equal(res.payload.language_verification.status, 'rejected');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server rejects English text saved under a Spanish target language', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    assert.equal(call, 3);
    return jsonFetch({ [`${questionId}:1`]: sourceQuestion });
  });
  try {
    const wrongLanguage = translationDocument();
    wrongLanguage.title = 'Daily support';
    wrongLanguage.questions.Q_SUPPORT.prompt = 'How much support do you experience every day?';
    wrongLanguage.questions.Q_SUPPORT.options = sourceQuestion.options.map(option => ({
      ...option, text: `Choice number ${option.value}`
    }));
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/save', body: wrongLanguage,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 422);
    assert.match(res.payload.error, /Spanish language evidence/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pre-acceptance verification blocks the wrong actual language', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = researcherAccessThen(async () => {
    throw new Error('No database call is expected after account verification');
  });
  try {
    const source = {
      ...translationDocument(), primary_language: 'en-US',
      questions: { Q_SUPPORT: sourceQuestion }
    };
    delete source.translation_provenance;
    const translated = translationDocument();
    translated.questions.Q_SUPPORT.prompt = 'How much support do you experience every day?';
    translated.questions.Q_SUPPORT.options = sourceQuestion.options.map(option => ({
      ...option, text: `Choice number ${option.value}`
    }));
    delete translated.translation_provenance;
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/verify',
      body: { source_document: source, translated_document: translated },
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.payload.language_verification.target_language, 'es-MX');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translation batch progress is saved as an account-owned resumable draft', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = researcherAccessThen(async (url, options, call) => {
    assert.equal(call, 3);
    assert.match(url, /rpc\/save_question_translation_draft$/);
    rpcBody = JSON.parse(options.body);
    return jsonFetch({
      draft_id: '4fe6d4b3-acde-4e8f-a8a5-6b3ad9b06430',
      researcher_account_id: researcherId,
      status: 'in_progress', completed_field_count: 1, total_field_count: 2
    });
  });
  try {
    const res = response();
    await handler({
      method: 'POST', url: '/question-translations/draft',
      body: {
        source_schema: 'research_os.question_bank', source_entity_id: bankId,
        source_version: 1, source_sha256: 'b'.repeat(64),
        source_primary_language: 'en-US', target_language: 'es-MX',
        provider: 'groq', model: 'openai/gpt-oss-20b',
        prompt_version: 'canonical_questionnaire_translation_v2',
        translated_items: [{ id: 'T1', text: 'Apoyo', confidence: 0.9, notes: null }],
        completed_field_count: 1, total_field_count: 2,
        status: 'in_progress', last_error: null
      },
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(rpcBody.p_researcher_account_id, researcherId);
    assert.equal(rpcBody.p_draft.translated_items.length, 1);
    assert.equal(res.payload.draft.status, 'in_progress');
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
    assert.match(url, /rpc\/load_exact_question_translation_package$/);
    return jsonFetch({
      translation_package_id: translationPackageId,
      translation_version: 1,
      translated_document: { title: 'Apoyo' },
      translations: {}
    });
  });
  try {
    const res = response();
    await handler({
      method: 'GET',
      url: `/question-banks/${bankId}?version=1&lang=es-MX&translation_package_id=${translationPackageId}&translation_version=1`,
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
    if (call === 1) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    if (call === 3) {
      assert.match(url, /rpc\/list_question_banks_for_account$/);
      return jsonFetch([{
        bank_id: bankId, version: 1, code: 'SUPPORT', title: 'Support',
        status: 'active', primary_language: 'en-US', reuse_permission: 'attribution_permitted',
        owned_by_current_account: true, content_visible: true, content_visibility: 'metadata_only'
      }]);
    }
    assert.equal(call, 4);
    assert.match(url, /rpc\/list_question_translation_catalog$/);
    return jsonFetch({
      packages: [{
        translation_package_id: translationPackageId,
        source_schema: 'research_os.question_bank', source_entity_id: bankId,
        source_version: 1, target_language: 'es-MX', translation_version: 1,
        expected_question_count: 1, translated_question_count: 1,
        coverage_complete: true, verification_status: 'verified'
      }],
      bank_languages: [],
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
    assert.equal(res.payload.banks[0].available_languages[1].translation_package_id, translationPackageId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('catalog recovers the exact source language when an older list RPC omits it', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url) => {
    call += 1;
    if (call === 1) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    if (call === 3) {
      assert.match(url, /rpc\/list_question_banks_for_account$/);
      return jsonFetch([{
        bank_id: bankId, version: 1, code: 'SUPPORT', title: 'Support',
        status: 'draft', reuse_permission: 'attribution_permitted',
        owned_by_current_account: true, content_visible: true, content_visibility: 'metadata_only'
      }]);
    }
    assert.equal(call, 4);
    assert.match(url, /rpc\/list_question_translation_catalog$/);
    return jsonFetch({
      packages: [],
      bank_languages: [{
        source_entity_id: bankId, source_version: 1,
        language: 'ru-RU', is_source: true, coverage_complete: true,
        verification_status: 'source'
      }],
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
    assert.equal(res.payload.banks[0].primary_language, 'ru-RU');
    assert.equal(res.payload.banks[0].source_language, 'ru-RU');
    assert.equal(res.payload.banks[0].catalog_integrity, 'valid');
    assert.deepEqual(res.payload.banks[0].available_languages.map(row => row.language), ['ru-RU']);
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

test('content endpoints reject ambiguous loads without an exact entity version and language', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No database call is allowed for an ambiguous content request');
  };
  try {
    const bankResponse = response();
    await handler({
      method: 'GET', url: `/question-banks/${bankId}`,
      headers: { host: 'research-os.test' }
    }, bankResponse);
    assert.equal(bankResponse.statusCode, 400);
    assert.match(bankResponse.payload.error, /Exact question-bank version and supported language/);

    const questionnaireResponse = response();
    await handler({
      method: 'GET', url: `/questionnaires/${questionnaireId}?version=1`,
      headers: { host: 'research-os.test' }
    }, questionnaireResponse);
    assert.equal(questionnaireResponse.statusCode, 400);
    assert.match(questionnaireResponse.payload.error, /Exact questionnaire version and supported language/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an exact accepted questionnaire package loads translated snapshots without changing routing identity', async () => {
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
    if (call === 1) return jsonFetch([{
      session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da', account_id: researcherId,
      expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
    }]);
    if (call === 2) return jsonFetch([{
      account_id: researcherId, username: 'researcher', user_identifier: 'RESEARCHER-001',
      role: 'researcher', status: 'active', created_by_account_id: null
    }]);
    if (call === 3) {
      assert.match(url, /rpc\/load_questionnaire_package_for_account$/);
      return jsonFetch(sourceQuestionnaire);
    }
    if (call === 4) {
      assert.match(url, /rpc\/load_exact_question_translation_package$/);
      return jsonFetch({
        translation_package_id: translationPackageId,
        translation_version: 1,
        translated_document: { title: 'Encuesta de apoyo', description: 'Descripción traducida' },
        translations: {
          [`${questionId}:1`]: {
            translated_definition: {
              ...sourceQuestion,
              prompt: '¿Qué tanto apoyo siente?',
              options: sourceQuestion.options.map(option => ({ ...option, text: `Opción ${option.value}` }))
            },
            translation_reference: {
              translation_package_id: translationPackageId,
              translation_version: 1, package_translation_version: 1, target_language: 'es-MX'
            }
          }
        }
      });
    }
    throw new Error(`Unexpected fetch call ${call}: ${url}`);
  };
  try {
    const res = response();
    await handler({
      method: 'GET',
      url: `/questionnaires/${questionnaireId}?version=1&lang=es-MX&translation_package_id=${translationPackageId}&translation_version=1`,
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.questionnaire.primary_language, 'es-MX');
    assert.equal(res.payload.questionnaire.title, 'Encuesta de apoyo');
    assert.equal(res.payload.questionnaire.items[0].definition_snapshot.prompt, '¿Qué tanto apoyo siente?');
    assert.equal(res.payload.questionnaire.items[0].definition_snapshot.definition_language, 'es-MX');
    assert.equal(res.payload.questionnaire.translation_set.translation_package_id, translationPackageId);
    assert.equal(res.payload.questionnaire.items[0].item_id, itemId);
    assert.deepEqual(res.payload.questionnaire.routing, sourceQuestionnaire.routing);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translation migration and UI retain immutable source and provenance', async () => {
  const [migration, catalogMigration, integrityMigration, exactLoadingMigration, translator, constructor, assessment, vercel] = await Promise.all([
    fs.readFile(new URL('../supabase/question_translation_variants_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_translation_catalog_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_translation_integrity_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_translation_exact_loading_v3.sql', import.meta.url), 'utf8'),
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
  assert.match(translator, /registry_coverage|Cobertura/);
  assert.match(translator, /Load from database/);
  assert.match(translator, /Translate \/ Resume/);
  assert.match(translator, /question-translations\/draft/);
  assert.match(translator, /question-translations\/verify/);
  assert.match(translator, /researcher accepted/i);
  assert.match(translator, /Automated language check/);
  assert.match(translator, /field-by-field translation review|Revisión campo por campo/i);
  assert.match(catalogMigration, /list_question_translation_catalog/);
  assert.match(catalogMigration, /coverage_complete/);
  assert.match(catalogMigration, /having count\(distinct/);
  assert.match(integrityMigration, /question_translation_drafts/);
  assert.match(integrityMigration, /verification_status = 'verified'/);
  assert.match(integrityMigration, /require_verified_question_translation_package/);
  assert.match(exactLoadingMigration, /load_exact_question_translation_package/);
  assert.match(exactLoadingMigration, /translation_package_id = p_translation_package_id/);
  assert.match(constructor, /questionnaireLanguage/);
  assert.match(constructor, /id="bankLanguage"/);
  assert.match(constructor, /id="savedQuestionnaireLanguage"/);
  assert.match(constructor, /available_languages/);
  assert.match(constructor, /translation_package_id/);
  assert.match(constructor, /translation_version/);
  assert.match(translator, /definition_snapshot\.definition_language = targetLanguage/);
  assert.match(assessment, /question_translation_references/);
  assert.match(assessment, /questionnaire_primary_language/);
  assert.match(vercel, /"source": "\/question-translations"/);
  assert.match(vercel, /"source": "\/question-translations\/\(\.\*\)"/);
});

test('ordinary constructor catalogs keep one entity row and select its exact language separately', async () => {
  const constructor = await fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8');
  assert.match(constructor, /bankCatalog\.forEach\(b=>select\.add\(new Option\([^\n]*entityToken\(b\.bank_id,b\.version\)/);
  assert.match(constructor, /questionnaireCatalog\.forEach\(q=>select\.add\(new Option\([^\n]*entityToken\(q\.questionnaire_id,q\.version\)/);
  assert.doesNotMatch(constructor, /bankCatalog\.forEach\(b=>\(b\.available_languages/);
  assert.doesNotMatch(constructor, /questionnaireCatalog\.forEach\(q=>\(q\.available_languages/);
  assert.match(constructor, /const entity=selectedVariantValue\('bankSelect'\),variant=parsedToken\(document\.getElementById\('bankLanguage'\)\.value\)/);
  assert.match(constructor, /const entity=selectedVariantValue\('questionnaireSelect'\),variant=parsedToken\(document\.getElementById\('savedQuestionnaireLanguage'\)\.value\)/);
  assert.match(constructor, /const LANGUAGE_ORDER=\['es-MX','en-US','ru-RU'\]/);
});
