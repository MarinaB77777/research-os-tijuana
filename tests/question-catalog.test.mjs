import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [catalog, questionEditor, questionnaireEditor, schema, api] = await Promise.all([
  fs.readFile(new URL('../question_catalog.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../supabase/research_configuration_contract_v1.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8')
]);

test('registered bank editor requests one exact version and language variant', () => {
  assert.match(questionEditor, /const requestedLanguage = params\.get\('lang'\)/);
  assert.match(questionEditor, /version: String\(Number\(version\)\),\s*lang: requestedLanguage/);
  assert.match(questionEditor, /translation_package_id/);
  assert.match(questionEditor, /translation_version/);
  assert.doesNotMatch(
    questionEditor,
    /`\/question-banks\/\$\{encodeURIComponent\(bankId\)\}\$\{version \?/
  );
});

test('database catalogs return source language and complete item counts', () => {
  assert.match(schema, /bank_id uuid, version integer, code text, title text, status text,\s*primary_language text, question_count bigint/);
  assert.match(schema, /questionnaire_id uuid, version integer, code text, title text, status text,\s*primary_language text, item_count bigint/);
  assert.match(schema, /drop function if exists public\.list_questionnaires\(text\);\s*create function public\.list_questionnaires/);
});

test('questionnaire snapshot retains the complete immutable scientific definition', () => {
  assert.match(schema, /qd\.definition - 'question_id' - 'version' - 'code'/);
  assert.match(schema, /'definition_language', coalesce\([\s\S]*qb\.primary_language/);
  assert.doesNotMatch(schema, /select jsonb_build_object\(\s*'prompt', qd\.definition/);
});

test('catalog loads banks, questionnaires, and every exact ES EN RU variant', () => {
  assert.match(catalog, /RC\.requestJson\('\/question-banks'\)/);
  assert.match(catalog, /RC\.requestJson\('\/questionnaires\?status=all'\)/);
  assert.match(catalog, /const LANGUAGES=\['es-MX','en-US','ru-RU'\]/);
  assert.match(catalog, /entityVariants\(entity\)/);
  assert.match(catalog, /translation_package_id/);
  assert.match(catalog, /translation_version/);
  assert.match(catalog, /mapLimit\(tasks,4,loadVariant\)/);
});

test('duplicate review distinguishes reuse, version history, and different UUIDs', () => {
  assert.match(catalog, /row\.identity_key=`\$\{row\.question_id\}:\$\{row\.question_version\}`/);
  assert.match(catalog, /const questionIds=new Set\(rows\.map\(r=>r\.question_id\)\)/);
  assert.match(catalog, /if\(questionIds\.size>1\)duplicateGroups\.set/);
  assert.match(catalog, /nada se elimina automáticamente/);
  assert.doesNotMatch(catalog, /method:\s*['"]DELETE['"]/);
});

test('both constructors expose the catalog without replacing their current interface', () => {
  assert.match(questionEditor, /href="question_catalog\.html"/);
  assert.match(questionnaireEditor, /href="question_catalog\.html"/);
  assert.match(questionEditor, /class="workspace"/);
  assert.match(questionnaireEditor, /class="layout"/);
});

test('researcher-only database audit checks every project table without reading rows', () => {
  assert.match(api, /const RESEARCH_OS_TABLE_CONTRACT = Object\.freeze\(\[/);
  for (const table of [
    'question_banks', 'question_definitions', 'question_bank_items',
    'questionnaires', 'questionnaire_items', 'questionnaire_routes',
    'question_translation_packages', 'question_translation_variants',
    'research_os_accounts', 'research_os_auth_sessions',
    'research_os_collection_sessions', 'consent_documents',
    'research_studies', 'research_participant_measurements'
  ]) assert.match(api, new RegExp(`'${table}'`));
  assert.match(api, /path === '\/database\/contract-audit'/);
  assert.match(api, /verifyResearcher\(req, supabaseUrl, supabaseAdminKey\)/);
  assert.match(api, /\?select=\*&limit=0/);
  assert.match(catalog, /RC\.requestJson\('\/database\/contract-audit'\)/);
});
