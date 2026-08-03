import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const [importSource, page] = await Promise.all([
  fs.readFile(new URL('../question-bank-import.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../validator.html', import.meta.url), 'utf8')
]);
const inlineSource = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .find(source => source.includes('function validateQuestionnairePackage'));
const context = { crypto: webcrypto, console, Uint8Array, TextDecoder };
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(importSource, context);
vm.runInContext(inlineSource, context);
const validator = context.ResearchOsValidator;

const question = {
  question_id: '682a6069-65c2-42d3-9697-015f7b28104f', code: 'Q_1', version: 1,
  block: null, family: null, domain: null, parameter: null, type: 'single_select',
  prompt: 'Question?', options: [{ value: 0, text: 'No' }, { value: 1, text: 'Yes' }],
  scale: { id: 'dichotomous', psychometric_level: 'nominal', min: 0, max: 1, step: 1, unit: null, direction: null },
  score_direction: null, time: { tracking_mode: 'time_invariant', wave: null, lag: null }, status: 'draft'
};
const bank = {
  schema: 'research_os.question_bank', schema_version: 2,
  bank_id: '177ced8e-6b08-4df3-9d84-40735890640b', code: 'TEST_BANK', title: 'Test bank',
  version: 1, status: 'draft', primary_language: 'es-MX',
  global_time_reference: '2026-08-02T12:00:00.000Z', question_order: ['Q_1'], questions: { Q_1: question }
};
const itemId = 'ea5aa752-536e-44de-9097-63e81c411aa7';
const questionnaire = {
  schema: 'research_os.questionnaire', schema_version: 1,
  questionnaire_id: '2ed5f06b-bb82-4d39-bc1f-557f5b07cb71', code: 'TEST_QUESTIONNAIRE', title: 'Test questionnaire',
  version: 1, status: 'draft', primary_language: 'es-MX', global_time_reference: '2026-08-02T12:00:00.000Z',
  consent: { mode: 'standard', consent_id: '00000000-0000-4000-8000-000000000001', consent_version: 1 },
  completion_policy: { minimum_answered_items: 1, require_terminal_route: true }, start_item_id: itemId,
  items: [{
    item_id: itemId, position: 1, source_bank_id: bank.bank_id, source_bank_version: 1,
    source_bank_code: bank.code, question_id: question.question_id, question_version: 1,
    code: question.code, required: true,
    definition_snapshot: { prompt: question.prompt, type: question.type, scale: question.scale, options: question.options, domain: null, parameter: null, status: 'draft' }
  }],
  routing: { nodes: { [itemId]: { default_target: 'end', rules: [] } } }
};

test('validator accepts the native question bank v2 contract', () => {
  const result = validator.validateQuestionBankPackage(bank);
  assert.equal(result.errors.length, 0);
  assert.equal(result.nodeCount, 1);
});

test('validator accepts the native questionnaire v1 contract and its route graph', () => {
  const result = validator.validateQuestionnairePackage(questionnaire);
  assert.equal(result.errors.length, 0);
  assert.equal(result.nodeCount, 1);
});

test('validator rejects broken native scale and questionnaire route contracts', () => {
  const brokenBank = structuredClone(bank);
  brokenBank.questions.Q_1.scale.id = 'ordinal';
  assert.ok(validator.validateQuestionBankPackage(brokenBank).errors.length > 0);

  const brokenQuestionnaire = structuredClone(questionnaire);
  brokenQuestionnaire.routing.nodes[itemId].default_target = 'missing-item';
  assert.ok(validator.validateQuestionnairePackage(brokenQuestionnaire).errors.some(error => error.includes('Маршрут')));
});
