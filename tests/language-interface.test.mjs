import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function readPage(path) {
  return fs.readFile(new URL(path, root), 'utf8');
}

test('every HTML page uses Spanish as the no-preference default and never displays Russian or UK flags', async () => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const pages = entries.filter(entry => entry.isFile() && entry.name.endsWith('.html')).map(entry => entry.name);
  assert.ok(pages.length > 0);
  for (const path of pages) {
    const html = await readPage(path);
    assert.match(html, /<html lang="es(?:-MX)?">/, `${path} must declare Spanish as its initial language`);
    assert.doesNotMatch(html, /🇷🇺/, `${path} must label Russian as RU without a flag`);
    assert.doesNotMatch(html, /🇬🇧/, `${path} must identify English as United States, not United Kingdom`);
    assert.doesNotMatch(html, /\|\|\s*['"]ru['"]|let\s+(?:currentLang|lang)\s*=\s*['"]ru['"]|\?\s*value\s*:\s*['"]ru['"]/, `${path} must not use Russian as a fallback`);
  }
});

test('language controls consistently order Spanish, English, then Russian', async () => {
  const selectors = {
  "index.html": [
    "onclick=\"setLang('es'",
    "onclick=\"setLang('en'",
    "onclick=\"setLang('ru'"
  ],
  "importer.html": [
    "onclick=\"setLanguage('es')",
    "onclick=\"setLanguage('en')",
    "onclick=\"setLanguage('ru')"
  ],
  "constructor_quest.html": [
    "<option value=\"es-MX\">",
    "<option value=\"en-US\">",
    "<option value=\"ru\">"
  ],
  "constructor_survey.html": [
    "<option value=\"es\">",
    "<option value=\"en\">",
    "<option value=\"ru\">"
  ],
  "constructor_study.html": [
    "data-lang=\"es\"",
    "data-lang=\"en\"",
    "data-lang=\"ru\""
  ],
  "constructor_parameter.html": [
    "<option value=\"es\">",
    "<option value=\"en\">",
    "<option value=\"ru\">"
  ],
  "parameter_registry.html": [
    "<option value=\"es\">",
    "<option value=\"en\">",
    "<option value=\"ru\">"
  ],
  "cabinet.html": [
    "data-lang=\"es\"",
    "data-lang=\"en\"",
    "data-lang=\"ru\""
  ],
  "settings.html": [
    "data-lang=\"es\"",
    "data-lang=\"en\"",
    "data-lang=\"ru\""
  ],
  "login.html": [
    "onclick=\"setLang('es')",
    "onclick=\"setLang('en')",
    "onclick=\"setLang('ru')"
  ],
  "register.html": [
    "onclick=\"setLang('es')",
    "onclick=\"setLang('en')",
    "onclick=\"setLang('ru')"
  ],
  "join-study.html": [
    "onclick=\"setLang('es')",
    "onclick=\"setLang('en')",
    "onclick=\"setLang('ru')"
  ],
  "translator.html": [
    "onclick=\"setLang('es'",
    "onclick=\"setLang('en'",
    "onclick=\"setLang('ru'"
  ],
  "analyzer.html": [
    "data-lang=\"es\"",
    "data-lang=\"en\"",
    "data-lang=\"ru\""
  ],
  "consent_registry.html": [
    "<option value=\"es\">",
    "<option value=\"en\">",
    "<option value=\"ru\">"
  ],
  "validator.html": [
    "id=\"lang-es\"",
    "id=\"lang-en\"",
    "id=\"lang-ru\""
  ],
  "data-analysis.html": [
    "data-lang=\"es\"",
    "data-lang=\"en\"",
    "data-lang=\"ru\""
  ],
  "survey.html": [
    "id=\"lang-es\"",
    "id=\"lang-en\"",
    "id=\"lang-ru\""
  ]
};
  for (const [path, markers] of Object.entries(selectors)) {
    const html = await readPage(path);
    const positions = markers.map(marker => html.indexOf(marker));
    assert.ok(positions.every(position => position >= 0), `${path} must expose all three language controls`);
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], `${path} must order ES, EN, RU`);
  }
});
