import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [bankConstructor, questionnaireConstructor, parameterConstructor, translationSql] =
  await Promise.all([
    fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_parameter.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/question_translation_variants_v1.sql', import.meta.url), 'utf8')
  ]);

test('interface language and source-content language are explicit independent choices', () => {
  assert.match(bankConstructor, /id="langSelect"/);
  assert.match(bankConstructor, /id="contentLanguageSelect"/);
  assert.match(bankConstructor, /bankMetadata\.primary_language = value/);
  assert.match(bankConstructor, /interface_language: currentLang/);
  assert.match(bankConstructor, /primary_language: bankMetadata\.primary_language/);
  assert.match(bankConstructor, /const contentLocale = editorLocale\(\)/);
});

test('questionnaires and parameters retain their own source language without UI relabeling', () => {
  assert.match(questionnaireConstructor, /id="questionnaireLanguage"/);
  assert.match(questionnaireConstructor, /state\.primary_language=document\.getElementById\('questionnaireLanguage'\)\.value/);
  assert.match(parameterConstructor, /id="contentLanguage"/);
  assert.match(parameterConstructor, /primary_language:state\.primary_language/);
  assert.doesNotMatch(parameterConstructor, /computation:state\.computation,primary_language:'es-MX'/);
});

test('ES EN and RU remain variants of one bank identity rather than three bank entities', () => {
  assert.match(translationSql, /source_entity_id uuid/);
  assert.match(translationSql, /target_language text/);
  assert.match(translationSql, /translation_package_id uuid/);
  assert.doesNotMatch(bankConstructor, /bank_id_(?:es|en|ru)/i);
});
