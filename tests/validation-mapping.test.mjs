import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const [html, promptSource, indexSource, surveySource] = await Promise.all([
  fs.readFile(new URL('../analyzer.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../prompts.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../survey.html', import.meta.url), 'utf8')
]);
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const analyzerSource = inlineScripts.at(-1)[1];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      checked: false,
      className: '',
      style: {},
      dataset: {},
      classList: {
        add() {},
        remove() {},
        toggle() {}
      }
    });
  }
  return elements.get(id);
}
const researcher = {
  role: 'researcher',
  token: 'researcher-session',
  account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329'
};
const context = vm.createContext({
  console,
  URL,
  Blob,
  crypto: { randomUUID },
  setTimeout,
  clearTimeout,
  localStorage: {
    getItem() { return 'es'; },
    setItem() {}
  },
  document: {
    documentElement: {},
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) { return element(id); },
    createElement() { return element(`created-${elements.size}`); }
  },
  window: {
    ResearchAuth: {
      readSession() { return researcher; },
      async requireRole() { return researcher; }
    }
  },
  ResearchAuth: {
    readSession() { return researcher; },
    async requireRole() { return researcher; }
  },
  QuestionBankImport: {},
  AIRouter: {
    getTaskConfig() {
      return { provider: 'groq', model: 'openai/gpt-oss-20b' };
    }
  },
  fetch: async () => {
    throw new Error('unexpected network call');
  }
});
vm.runInContext(promptSource, context);
vm.runInContext(analyzerSource, context);

function run(expression, values = {}) {
  Object.assign(context, values);
  return vm.runInContext(expression, context);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('mapping prompt prohibits item matching, invention, and protected-item reproduction', () => {
  assert.match(promptSource, /Do not map question to question/i);
  assert.match(promptSource, /Do not treat a similar response scale as construct coverage/i);
  assert.match(promptSource, /Never invent a DOI/i);
  assert.match(promptSource, /Never reproduce protected instrument items/i);
  assert.match(promptSource, /candidate identifier until independent metadata lookup succeeds/i);
  assert.match(promptSource, /researcher decision/i);
  assert.match(promptSource, /question_match/);
  assert.match(promptSource, /Question match and depth match are separate assessments/i);
});

test('navigation names the mapping, converter, and structure validator honestly in every language', () => {
  assert.match(indexSource, /Mapa de Cobertura y Validación/);
  assert.match(indexSource, /Validation Coverage Map/);
  assert.match(indexSource, /Карта Валидационного Покрытия/);
  assert.doesNotMatch(indexSource, /Validación pregunta por pregunta|Item-level validation|Повопросная валидация/);

  assert.match(surveySource, /Conversión de Cuestionarios/);
  assert.match(surveySource, /Questionnaire Conversion/);
  assert.match(surveySource, /Конвертация опросников/);
  assert.match(surveySource, /Validación de Estructura/);
  assert.match(surveySource, /Structure Validation/);
  assert.match(surveySource, /Валидация структуры/);
  assert.match(surveySource, /Mapa de Cobertura y Validación/);
  assert.match(surveySource, /Validation Coverage Map/);
  assert.match(surveySource, /Карта валидационного покрытия/);
  assert.doesNotMatch(surveySource, /Análisis Estadístico|Statistical Analysis|Статистический анализ/);
});

test('AI candidates can cover only exact researcher-defined subconstructs', () => {
  const raw = {
    method_name: 'Candidate Method',
    covered_subconstructs: ['Support', 'Invented construct', 'Trust', 'Support'],
    question_match: 'same_outcome_question',
    depth_match: 'comparable',
    primary_source: { doi: 'https://doi.org/10.1000/TEST.Scale' }
  };
  const normalized = plain(run(
    'normalizeCandidate(raw, ["Support", "Trust", "Help-seeking"])',
    { raw }
  ));
  assert.deepEqual(normalized.covered_subconstructs, ['Support', 'Trust']);
  assert.equal(normalized.question_match, 'same_outcome_question');
  assert.equal(normalized.primary_source.doi, '10.1000/test.scale');
  assert.equal(normalized.human_disposition.status, 'pending');
  assert.equal(normalized.source_verification.status, 'pending');
});

test('coverage is the union of approved subconstructs and never a question count', () => {
  const mappingValue = {
    mapping_tree: {
      expected_coverage: ['Support', 'Trust', 'Help-seeking'],
      validation_bundle: [
        {
          covered_subconstructs: ['Support', 'Trust'],
          human_disposition: { status: 'accepted' }
        },
        {
          covered_subconstructs: ['Trust', 'Help-seeking'],
          human_disposition: { status: 'pending' }
        }
      ]
    }
  };
  const result = run('mapping = mappingValue; coverage()', { mappingValue });
  assert.deepEqual(plain(result.expected), [
    { id: 'Support', label: 'Support' },
    { id: 'Trust', label: 'Trust' },
    { id: 'Help-seeking', label: 'Help-seeking' }
  ]);
  assert.deepEqual([...result.covered], ['Support', 'Trust']);
  assert.equal(result.percent, 67);
  assert.doesNotMatch(html, /count\s*\/\s*totalQuestionsCount/);
  assert.doesNotMatch(html, /is_standard_mapping|standard_methodology/);
});

test('standard-method search retains every recognized method while preserving exact access status', () => {
  assert.match(html, /id="methodAccessInput"/);
  assert.match(html, /type="hidden" value="include_all_recognized"/);
  assert.doesNotMatch(html, /<option value="include_licensed"/);
  assert.match(promptSource, /published, recognized standard\s+method/i);
  assert.match(promptSource, /Do not suppress a recognized\s+method merely because it is paid/i);
  assert.match(promptSource, /Never reproduce or link to unauthorized\s+copies/i);
  assert.match(promptSource, /Never convert\s+unknown into free, paid, safe, or unavailable/i);

  const targets = [{ node_id: 'node-1', label: 'Target' }];
  const freeCandidate = plain(run('normalizeCandidate(raw, targets)', {
    targets,
    raw: { method_name: 'Free method', method_access: {
      status: 'free', access_url: 'https://official.example/free', access_url_type: 'manual'
    } }
  }));
  const paidCandidate = plain(run('normalizeCandidate(raw, targets)', {
    targets,
    raw: { method_name: 'Paid method', method_access: {
      status: 'purchase_required', access_url: 'https://unauthorized.example/copy'
    } }
  }));
  const unknownCandidate = plain(run('normalizeCandidate(raw, targets)', {
    targets,
    raw: { method_name: 'Unknown access', method_access: { status: 'unknown' } }
  }));
  assert.equal(freeCandidate.method_access.status, 'free');
  assert.equal(freeCandidate.method_access.access_url, 'https://official.example/free');
  assert.equal(paidCandidate.method_access.status, 'purchase_required');
  assert.equal(paidCandidate.method_access.access_url, null);
  assert.equal(unknownCandidate.method_access.status, 'unknown');
  assert.equal(unknownCandidate.method_access.access_url, null);
  assert.equal(run('mappingSpec().standard_method_access_scope'), 'include_all_recognized');
});

test('bank loading uses the active interface language and results are grouped by deep research question', () => {
  assert.match(html, /interface_language:currentLang/);
  assert.doesNotMatch(html, /interface_language:lang\b/);
  assert.match(html, /function renderCoverageGroups\(\)/);
  assert.match(html, /node\.node_type==='deep_research_question'/);
  assert.match(html, /t\('includedQuestions'\)/);
  assert.match(html, /t\('proposedMethods'\)/);
});

test('bank questions stay in the local group tree but are not sent into candidate discovery', () => {
  const bank = {
    schema: 'research_os.question_bank',
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'AUTHOR_BANK',
    version: 1,
    question_order: ['Q_1'],
    questions: {
      Q_1: {
        code: 'Q_1',
        prompt: 'A protected or private authored question',
        question_id: '39744113-bf44-46ac-a3ac-3cc65f9fdd7c'
      }
    }
  };
  const spec = {
    bank_title: 'Author Bank',
    deep_research_question_groups: [{
      group_id: 'group-1',
      deep_research_question: 'What does perceived support allow us to understand?',
      question_codes: ['Q_1']
    }]
  };
  const tree = plain(run('sourceBank = bank; buildValidationTree(spec)', { bank, spec }));
  const targets = plain(run('validationTargets(tree)', { tree }));
  assert.equal(tree.children[0].children[0].definition, 'A protected or private authored question');
  assert.equal(tree.children[0].children[0].source_ref.included_in_candidate_discovery, false);
  assert.doesNotMatch(JSON.stringify(targets), /protected|private|Q_1/i);
});

test('universal validation tree groups every selected bank question under one deep research question', () => {
  const bank = {
    schema: 'research_os.question_bank',
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'GENERIC_BANK',
    version: 1,
    question_order: ['Q_1', 'Q_2'],
    questions: {
      Q_1: { code: 'Q_1', question_id: '39744113-bf44-46ac-a3ac-3cc65f9fdd7c', prompt: 'First authored question' },
      Q_2: { code: 'Q_2', question_id: '8c1be574-2d2c-4200-a47f-7bde9bb36eb3', prompt: 'Second authored question' }
    }
  };
  const spec = {
    bank_title: 'Generic Bank',
    deep_research_question_groups: [{
      group_id: 'group-1',
      deep_research_question: 'What does this pair of questions allow us to understand?',
      question_codes: ['Q_1', 'Q_2']
    }]
  };
  const tree = plain(run('sourceBank = bank; buildValidationTree(spec)', { bank, spec }));
  assert.equal(tree.node_type, 'validation_target');
  assert.equal(tree.children[0].node_type, 'deep_research_question');
  assert.deepEqual(
    tree.children[0].children.map(item => item.node_type),
    ['bank_question_reference', 'bank_question_reference']
  );
  assert.deepEqual(tree.children[0].source_ref.question_codes, ['Q_1', 'Q_2']);
  assert.equal(tree.children[0].source_ref.question_prompts_sent_to_ai, false);
  assert.doesNotMatch(JSON.stringify(tree), /health_model|StressBurden|TrajectoryRisk/i);
});

test('the same universal group contract accepts Health Model questions without a special schema', () => {
  const bank = {
    schema: 'research_os.question_bank',
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'HEALTH_MODEL',
    version: 1,
    question_order: ['K_1', 'K_2'],
    questions: {
      K_1: { code: 'K_1', question_id: '39744113-bf44-46ac-a3ac-3cc65f9fdd7c', prompt: 'Observed manifestation one', parameter: 'K_fact' },
      K_2: { code: 'K_2', question_id: '8c1be574-2d2c-4200-a47f-7bde9bb36eb3', prompt: 'Observed manifestation two', parameter: 'K_fact' }
    }
  };
  const spec = {
    bank_title: 'Health Model',
    deep_research_question_groups: [{
      group_id: 'group-k',
      deep_research_question: 'What do these manifestations jointly reveal about current burden?',
      question_codes: ['K_1', 'K_2']
    }]
  };
  const tree = plain(run('sourceBank = bank; buildValidationTree(spec)', { bank, spec }));
  const allNodes = [];
  (function collect(node) {
    allNodes.push(node);
    node.children.forEach(collect);
  }(tree));
  assert.deepEqual(
    allNodes.filter(node => node.node_type === 'bank_question_reference').map(node => node.label),
    ['K_1', 'K_2']
  );
  assert.equal(new Set(allNodes.map(node => Object.keys(node).sort().join('|'))).size, 1);
});

test('mapping is allowed only after every bank question belongs to a deep-question group', () => {
  const bank = {
    title: 'Observed process',
    question_order: ['D_1', 'D_2'],
    questions: {
      D_1: { code: 'D_1', prompt: 'First question' },
      D_2: { code: 'D_2', prompt: 'Second question' }
    }
  };
  const spec = {
    bank_title: 'Observed process',
    deep_research_question_groups: [{
      group_id: 'group-1',
      deep_research_question: 'What does this question reveal?',
      question_codes: ['D_1']
    }],
    target_population: 'Study population',
    language_and_cultural_context: 'es-MX'
  };
  assert.equal(run('sourceBank = bank; deepQuestionGroups = spec.deep_research_question_groups; completeSpec(spec)', { bank, spec }), false);
  spec.deep_research_question_groups.push({
    group_id: 'group-2',
    deep_research_question: 'What does the second question reveal?',
    question_codes: ['D_2']
  });
  assert.equal(run('deepQuestionGroups = spec.deep_research_question_groups; completeSpec(spec)', { spec }), true);
});

test('each validation node receives its own bundle, direct coverage, aggregate coverage, and depth assessment', () => {
  const bank = {
    title: 'Research bank',
    question_order: ['Q_1'],
    questions: { Q_1: { code: 'Q_1', prompt: 'Research question' } }
  };
  const spec = {
    bank_title: 'Research bank',
    deep_research_question_groups: [{
      group_id: 'group-1',
      deep_research_question: 'What does this question allow us to understand?',
      question_codes: ['Q_1']
    }]
  };
  const tree = run('sourceBank = bank; buildValidationTree(spec)', { bank, spec });
  const targetId = run('tree.children[0].node_id', { tree });
  const candidate = {
    candidate_id: randomUUID(),
    target_node_ids: [targetId],
    depth_match: 'comparable',
    human_disposition: { status: 'accepted' }
  };
  const mappingValue = {
    schema_version: 2,
    mapping_tree: tree,
    candidate_registry: [candidate]
  };
  run('mapping = mappingValue; refreshValidationTree()', { mappingValue });
  const target = plain(run('mapping.mapping_tree.children[0]'));
  const questionReference = plain(run('mapping.mapping_tree.children[0].children[0]'));
  const root = plain(run('mapping.mapping_tree'));
  assert.deepEqual(target.validation_bundle, [candidate.candidate_id]);
  assert.deepEqual(target.approved_methods, [candidate.candidate_id]);
  assert.equal(target.coverage.direct.percent, 100);
  assert.equal(target.coverage.aggregate.percent, 100);
  assert.equal(target.depth_assessment.by_candidate[candidate.candidate_id], 'comparable');
  assert.deepEqual(questionReference.coverage.aggregate.expected_node_ids, []);
  assert.deepEqual(root.validation_bundle, [candidate.candidate_id]);
  assert.equal(root.coverage.direct.percent, 0);
  assert.equal(root.coverage.aggregate.percent, 100);
});

test('AI-provided links are restricted to HTTP(S) and rendered text is escaped', () => {
  assert.equal(run('safeHttpUrl("javascript:alert(1)")'), null);
  assert.equal(run('safeHttpUrl("data:text/html,attack")'), null);
  assert.equal(run('safeHttpUrl("https://doi.org/10.1000/test")'), 'https://doi.org/10.1000/test');

  const candidate = {
    candidate_id: randomUUID(),
    method_name: '<img src=x onerror=alert(1)>',
    method_abbreviation: null,
    method_outcome: '<script>alert(1)</script>',
    evidence_type: 'questionnaire',
    covered_subconstructs: ['<b>Support</b>'],
    depth_match: 'partial',
    population_fit: { status: 'unknown' },
    language_cultural_fit: { status: 'unknown' },
    primary_source: {
      doi: null,
      claimed_title: '<svg onload=alert(1)>',
      claimed_url: 'javascript:alert(1)'
    },
    source_verification: { status: 'not_verified' },
    rights_and_access: { status: 'unknown', explanation: '<iframe>' },
    limitations: ['<object>'],
    human_disposition: { status: 'pending' }
  };
  const rendered = run('candidateCard(candidate, 0)', { candidate });
  assert.doesNotMatch(rendered, /<script>|<img|<svg|<iframe|<object|javascript:/i);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /&lt;script/);
});

test('a verified DOI still requires the researcher attestation before bundle approval', () => {
  const candidateId = randomUUID();
  const mappingValue = {
    status: 'candidate_mapping_only',
    mapping_tree: {
      expected_coverage: ['Support'],
      validation_bundle: [{
        candidate_id: candidateId,
        method_name: 'Candidate Method',
        method_abbreviation: null,
        method_outcome: 'Support outcome',
        evidence_type: 'questionnaire',
        covered_subconstructs: ['Support'],
        depth_match: 'comparable',
        population_fit: { status: 'supported' },
        language_cultural_fit: { status: 'supported' },
        primary_source: { doi: '10.1000/test.scale', claimed_title: null, claimed_url: null },
        source_verification: {
          status: 'bibliographic_metadata_verified',
          metadata: {
            title: 'Primary source',
            url: 'https://doi.org/10.1000/test.scale'
          }
        },
        rights_and_access: { status: 'unknown', explanation: null },
        limitations: [],
        human_disposition: {
          status: 'pending',
          researcher_account_id: null,
          decided_at: null
        }
      }],
      approved_methods: []
    },
    potentially_unique_constructs: []
  };
  elements.clear();
  run('mapping = mappingValue; decideCandidate(0)', { mappingValue });
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.status'),
    'pending'
  );

  for (const dimension of [
    'source_method_identity',
    'outcome_fit',
    'population_fit',
    'language_cultural_fit',
    'rights_and_access'
  ]) {
    run(`setReviewDimension(0, "${dimension}", true)`);
  }
  run('decideCandidate(0)');
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.status'),
    'pending'
  );
  run('setReviewDimension(0, "bundle_inclusion", true)');
  run('decideCandidate(0)');
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.status'),
    'accepted'
  );
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.researcher_account_id'),
    researcher.account_id
  );
  assert.equal(run('mapping.status'), 'researcher_reviewed_mapping_plan');
  assert.deepEqual(
    plain(run('mapping.mapping_tree.approved_methods')),
    [candidateId]
  );

  run('decideCandidate(0)');
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.status'),
    'revoked'
  );
  assert.equal(run('mapping.status'), 'candidate_mapping_only');
});

test('generated mapping is owner-bound and preserves complete AI and evidence provenance', async () => {
  context.AIRouter.sendRequest = async (_task, _prompt, scopedInput) => {
    assert.equal(scopedInput.bank_title, 'Social resources bank');
    assert.deepEqual(
      plain(scopedInput.validation_targets.map(item => item.label)),
      [
        'What does the selected group show about available social support?',
        'What does the selected question show about help-seeking?'
      ]
    );
    assert.equal(scopedInput.author_instrument, undefined);
    assert.equal(scopedInput.deep_research_question_groups, undefined);
    assert.doesNotMatch(JSON.stringify(scopedInput), /Private authored wording/i);
    const coveredIds = scopedInput.validation_targets
      .filter(item => item.label.includes('social support'))
      .map(item => item.node_id);
    return {
      candidates: [{
        method_name: 'Candidate Social Method',
        method_abbreviation: 'CSM',
        method_outcome: 'Perceived social support',
        evidence_type: 'questionnaire',
        target_node_ids: coveredIds,
        covered_subconstructs: ['What does the selected group show about available social support?'],
        question_match: 'partial_outcome_question',
        depth_match: 'partial',
        population_fit: { status: 'partial', explanation: 'Population review needed.' },
        language_cultural_fit: { status: 'unknown', explanation: 'No adaptation established.' },
        primary_source: {
          doi: '10.1000/social.method',
          title: 'Candidate source',
          authors: 'Researcher',
          year: 2020,
          url: 'https://doi.org/10.1000/social.method'
        },
        rights_and_access: { status: 'open', explanation: 'Open-use status still requires researcher verification.' },
        limitations: ['Does not cover help-seeking.'],
        rationale: 'Candidate outcome overlap.',
        ai_confidence: 0.7
      }],
      potentially_unique_constructs: [{
        subconstruct: 'What does the selected question show about help-seeking?',
        reason: 'No direct analogue established.',
        separate_validation_required: true
      }],
      search_limitations: ['Database search was not exhaustive.']
    };
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        verification: {
          status: 'bibliographic_metadata_verified',
          scope: 'DOI existence and deposited bibliographic metadata only',
          scientific_appropriateness: 'requires_researcher_review',
          rights_status: 'requires_researcher_review'
        },
        metadata: {
          doi: '10.1000/social.method',
          title: 'Candidate source',
          url: 'https://doi.org/10.1000/social.method'
        }
      };
    }
  });
  const bankValue = {
    schema: 'research_os.question_bank',
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'SOCIAL_RESOURCES',
    title: 'Social resources bank',
    version: 1,
    question_order: ['S_1', 'S_2', 'S_3'],
    questions: {
      S_1: { code: 'S_1', question_id: '39744113-bf44-46ac-a3ac-3cc65f9fdd7c', prompt: 'Private authored wording one' },
      S_2: { code: 'S_2', question_id: '8c1be574-2d2c-4200-a47f-7bde9bb36eb3', prompt: 'Private authored wording two' },
      S_3: { code: 'S_3', question_id: 'f06e9f89-3c56-4a02-8a9e-a233276289e1', prompt: 'Private authored wording three' }
    }
  };
  const groupValues = [{
    group_id: 'group-support',
    deep_research_question: 'What does the selected group show about available social support?',
    question_codes: ['S_1', 'S_2']
  }, {
    group_id: 'group-help',
    deep_research_question: 'What does the selected question show about help-seeking?',
    question_codes: ['S_3']
  }];
  run(`
    sourceBank = bankValue;
    deepQuestionGroups = groupValues;
    populationInput.value = "Adults under life load";
    cultureInput.value = "es-MX";
  `, { bankValue, groupValues });
  await run('runMapping()');

  const result = plain(run('mapping'));
  assert.equal(result.schema, 'research_os.validation_mapping');
  assert.equal(result.schema_version, 2);
  assert.equal(result.owner_account_id, researcher.account_id);
  assert.equal(result.status, 'candidate_mapping_only');
  assert.equal(result.mapping_tree.node_type, 'validation_target');
  assert.equal(result.mapping_tree.children[0].node_type, 'deep_research_question');
  assert.deepEqual(
    result.mapping_tree.children[0].children.map(item => item.node_type),
    ['bank_question_reference', 'bank_question_reference']
  );
  assert.equal(result.comparison_strategy.unit, 'deep_research_question_to_method_outcome');
  assert.equal(
    result.comparison_strategy.coverage_rule,
    'union_of_researcher_approved_deep_research_questions'
  );
  assert.equal(result.comparison_strategy.question_level_mapping, false);
  assert.equal(result.comparison_strategy.question_match_assessed_separately, true);
  assert.equal(result.author_instrument.code, 'SOCIAL_RESOURCES');
  assert.equal(result.candidate_registry[0].source_verification.status, 'bibliographic_metadata_verified');
  assert.equal(result.candidate_registry[0].human_disposition.status, 'pending');
  assert.deepEqual(
    Object.keys(result.candidate_registry[0].human_reviews),
    ['source_method_identity', 'outcome_fit', 'population_fit', 'language_cultural_fit', 'rights_and_access', 'bundle_inclusion']
  );
  assert.equal(result.ai_provenance.provider, 'groq');
  assert.equal(result.ai_provenance.model, 'openai/gpt-oss-20b');
  assert.equal(result.ai_provenance.prompt_version, 'deep_research_question_standard_methods_v6');
  assert.equal(result.candidate_registry[0].question_match, 'partial_outcome_question');
  assert.equal(result.context.standard_method_access_scope, 'include_all_recognized');
  assert.equal(result.ai_provenance.human_authority, false);
  assert.equal(result.potentially_unique_constructs[0].separate_validation_required, true);
  assert.equal(result.methodology_basis.length, 5);
  assert.match(JSON.stringify(result.methodology_basis), /source domain is an example, not a system boundary/i);
});

test('non-DOI evidence can enter the bundle only after manual authoritative-source review', () => {
  const candidateId = randomUUID();
  const mappingValue = {
    status: 'candidate_mapping_only',
    updated_at: null,
    mapping_tree: {
      expected_coverage: ['Objective indicator'],
      validation_bundle: [{
        candidate_id: candidateId,
        method_name: 'Objective indicator protocol',
        method_abbreviation: null,
        method_outcome: 'Objective outcome',
        evidence_type: 'objective_indicator',
        covered_subconstructs: ['Objective indicator'],
        depth_match: 'comparable',
        population_fit: { status: 'supported' },
        language_cultural_fit: { status: 'supported' },
        primary_source: { doi: null, claimed_title: null, claimed_url: null },
        source_verification: { status: 'not_verified' },
        rights_and_access: { status: 'unknown', explanation: null },
        limitations: [],
        human_disposition: {
          status: 'pending',
          researcher_account_id: null,
          decided_at: null
        }
      }],
      approved_methods: []
    },
    potentially_unique_constructs: []
  };
  elements.clear();
  element(`manual-${candidateId}`).value = 'javascript:alert(1)';
  run('mapping = mappingValue; registerManualSource(0)', { mappingValue });
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].source_verification.status'),
    'not_verified'
  );

  element(`manual-${candidateId}`).value = 'https://official.example/protocol';
  run('registerManualSource(0)');
  const verification = plain(run(
    'mapping.mapping_tree.validation_bundle[0].source_verification'
  ));
  assert.equal(verification.status, 'researcher_reviewed_authoritative_source');
  assert.equal(verification.researcher_account_id, researcher.account_id);
  assert.equal(verification.metadata.url, 'https://official.example/protocol');
  assert.match(verification.scope, /scientific appropriateness and rights remain separate/i);

  for (const dimension of [
    'source_method_identity',
    'outcome_fit',
    'population_fit',
    'language_cultural_fit',
    'rights_and_access',
    'bundle_inclusion'
  ]) {
    run(`setReviewDimension(0, "${dimension}", true)`);
  }
  run('decideCandidate(0)');
  assert.equal(
    run('mapping.mapping_tree.validation_bundle[0].human_disposition.status'),
    'accepted'
  );
});
