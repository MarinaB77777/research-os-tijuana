import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [migration, api, bankConstructor, questionnaireConstructor, cabinet, catalog, translator] =
  await Promise.all([
    fs.readFile(new URL('../supabase/catalog_content_access_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../question_catalog.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../translator.html', import.meta.url), 'utf8')
  ]);

test('catalog discovery, content viewing, and bank reuse are independent contracts', () => {
  assert.match(migration, /content_visibility in \('metadata_only', 'content_visible'\)/);
  assert.match(migration, /qb\.status = 'active'/);
  assert.match(migration, /b\.content_visibility = 'content_visible'/);
  assert.match(migration, /reuse_policy,permission/);
  assert.match(migration, /list_question_banks_for_account/);
  assert.match(migration, /list_questionnaires_for_account/);
  assert.match(migration, /load_question_bank_package_for_account/);
  assert.match(migration, /load_questionnaire_package_for_account/);
});

test('authorship survives account closure through an immutable ownership snapshot', () => {
  assert.match(migration, /owner_identifier_snapshot text/);
  assert.match(migration, /insert into public\.research_os_entity_ownership[\s\S]*owner_identifier_snapshot/);
  assert.doesNotMatch(migration, /on delete cascade/i);
});

test('owners can change content viewing without changing a scientific version', () => {
  assert.match(api, /\/content-visibility/);
  assert.match(api, /set_owned_entity_content_visibility/);
  assert.match(api, /\['metadata_only', 'content_visible'\]\.includes\(contentVisibility\)/);
  assert.match(bankConstructor, /id="contentVisibilitySelect"/);
  assert.match(questionnaireConstructor, /id="contentVisibility"/);
  assert.match(bankConstructor, /reusePolicySelect/);
});

test('metadata-only entities stay visible but content consumers do not load them', () => {
  assert.match(cabinet, /owner_identifier/);
  assert.match(cabinet, /metadataOnly/);
  assert.match(cabinet, /bank\.content_visible/);
  assert.match(cabinet, /q\.content_visible/);
  assert.match(catalog, /filter\(entity=>entity\.content_visible\)/);
  assert.match(translator, /option\.disabled = !item\.content_visible/);
});
