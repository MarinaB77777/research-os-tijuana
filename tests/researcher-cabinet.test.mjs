import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('researcher cabinet renders registered catalogs and contains no simulated bank state', async () => {
  const [cabinet, api, questionnaireConstructor] = await Promise.all([
    fs.readFile(new URL('../survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8')
  ]);
  assert.match(cabinet, /requestJson\('\/question-banks'\)/);
  assert.match(cabinet, /requestJson\('\/questionnaires\?status=all'\)/);
  assert.match(cabinet, /importer\.html\?return=survey\.html/);
  assert.match(cabinet, /owned_by_current_account/);
  assert.match(cabinet, /CRM Sharks · Ray AI/);
  assert.doesNotMatch(cabinet, /Estrés y carga laboral \(Wave 1\)/);
  assert.doesNotMatch(cabinet, /uploadedBanks/);
  assert.doesNotMatch(cabinet, /toggleBank/);
  assert.doesNotMatch(cabinet, /JSON\.parse\(text\)/);
  assert.match(api, /owned_by_current_account: owned\.has\(bank\.bank_id\)/);
  assert.match(api, /owned_by_current_account: owned\.has\(questionnaire\.questionnaire_id\)/);
  assert.match(questionnaireConstructor, /params\.get\('bank'\)/);
  assert.match(questionnaireConstructor, /params\.get\('questionnaire'\)/);
});
