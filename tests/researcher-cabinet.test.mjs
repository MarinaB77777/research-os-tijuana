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
  assert.match(cabinet, /CRM Sharks &amp; Ray AI/);
  for (const route of [
    'constructor_quest.html', 'constructor_survey.html', 'constructor_study.html',
    'constructor_parameter.html', 'parameter_registry.html', 'question_catalog.html',
    'consent_registry.html', 'importer.html', 'translator.html', 'validator.html',
    'analyzer.html', 'data-analysis.html', 'settings.html'
  ]) assert.match(cabinet, new RegExp(`href=["']${route.replace('.', '\\.')}`), `researcher cabinet must expose ${route}`);
  assert.doesNotMatch(cabinet, /Estrés y carga laboral \(Wave 1\)/);
  assert.doesNotMatch(cabinet, /uploadedBanks/);
  assert.doesNotMatch(cabinet, /toggleBank/);
  assert.doesNotMatch(cabinet, /JSON\.parse\(text\)/);
  assert.match(api, /list_question_banks_for_account/);
  assert.match(api, /list_questionnaires_for_account/);
  assert.match(api, /set_owned_entity_content_visibility/);
  assert.match(cabinet, /content_visible/);
  assert.match(cabinet, /metadataOnly/);
  assert.match(questionnaireConstructor, /params\.get\('bank'\)/);
  assert.match(questionnaireConstructor, /params\.get\('questionnaire'\)/);
});
