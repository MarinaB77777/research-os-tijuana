import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const pages = [
  'analyzer.html', 'assessment.html', 'cabinet.html', 'consent_registry.html',
  'constructor_parameter.html', 'constructor_quest.html', 'constructor_study.html',
  'constructor_survey.html', 'data-analysis.html', 'importer.html', 'join-study.html',
  'login.html', 'parameter_registry.html', 'question_catalog.html', 'register.html',
  'settings.html', 'survey.html', 'translator.html', 'validator.html'
];

const geminiPages = new Set([
  'analyzer.html', 'cabinet.html', 'consent_registry.html', 'constructor_parameter.html',
  'constructor_quest.html', 'login.html', 'parameter_registry.html', 'register.html',
  'settings.html', 'translator.html', 'validator.html'
]);

test('every non-hub page has a direct home control and the evidence-based project credit', async () => {
  for (const page of pages) {
    const html = await fs.readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(html, /href=["']index\.html(?:[?#][^"']*)?["']/, `${page} must link directly to the hub`);
    assert.match(html, /CRM Sharks\s*(?:&|&amp;)\s*Ray AI/, `${page} must credit CRM Sharks & Ray AI`);
    if (geminiPages.has(page)) assert.match(html, /(?:&|&amp;)\s*Gemini AI/, `${page} must retain Gemini AI credit`);
    else assert.doesNotMatch(html, /(?:&|&amp;)\s*Gemini AI/, `${page} must not add unsupported Gemini AI credit`);
  }
});

test('the hub identifies both AI collaborators unambiguously', async () => {
  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /CRM Sharks<\/strong>\s*&\s*<strong>Ray AI<\/strong>\s*&\s*<strong>Gemini AI<\/strong>/);
});
