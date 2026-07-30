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
    depth_match: 'comparable',
    primary_source: { doi: 'https://doi.org/10.1000/TEST.Scale' }
  };
  const normalized = plain(run(
    'normalizeCandidate(raw, ["Support", "Trust", "Help-seeking"])',
    { raw }
  ));
  assert.deepEqual(normalized.covered_subconstructs, ['Support', 'Trust']);
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

test('standard-method search defaults to available methods and includes licensed methods only by opt-in', () => {
  assert.match(html, /id="methodAccessInput"/);
  assert.match(html, /<option value="open_only"/);
  assert.match(promptSource, /standard_method_access_scope is "open_only"/i);
  assert.match(promptSource, /Do not infer instrument rights from access to an article/i);

  const openCandidate = { rights_and_access: { status: 'open' } };
  const paidCandidate = { rights_and_access: { status: 'purchase_required' } };
  assert.equal(run('candidateAllowedByAccess(openCandidate, "open_only")', { openCandidate }), true);
  assert.equal(run('candidateAllowedByAccess(paidCandidate, "open_only")', { paidCandidate }), false);
  assert.equal(run('candidateAllowedByAccess(paidCandidate, "include_licensed")'), true);
});

test('author instrument prompts are not sent into outcome-level candidate discovery', () => {
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
        block: 'SOCIAL',
        family: 'RESOURCE',
        domain: 'social',
        parameter: null,
        source_context: { variables: ['c1', 'c2'] }
      }
    }
  };
  const groups = plain(run('sourceBank = bank; variableGroups()', { bank }));
  assert.deepEqual(groups, [{
    block: 'SOCIAL',
    family: 'RESOURCE',
    domain: 'social',
    parameter: null,
    codes: ['Q_1'],
    source_variables: ['c1', 'c2']
  }]);
  assert.doesNotMatch(JSON.stringify(groups), /protected|private|question/i);
});

test('universal validation tree preserves every level and bank variables without a Health Model schema', () => {
  const spec = {
    domain_or_construct: 'Any research object',
    research_question: 'What outcome is being studied?',
    conceptual_definition: 'A researcher-defined meaning.',
    expected_targets: [
      { label: 'Component A', definition: 'First component.' },
      { label: 'Component B', definition: null }
    ],
    expected_depth: 'Outcome, components, and variables'
  };
  const groups = [{
    block: 'BLOCK_A',
    family: 'FAMILY_A',
    domain: 'generic',
    parameter: 'Observed group',
    codes: ['Q_1'],
    source_variables: ['variable_1', 'variable_2']
  }];
  const tree = plain(run('buildValidationTree(spec, groups)', { spec, groups }));
  assert.equal(tree.node_type, 'validation_target');
  assert.equal(tree.children[0].node_type, 'research_outcome');
  assert.equal(tree.children[0].children[0].node_type, 'conceptual_definition');
  const children = tree.children[0].children[0].children;
  assert.deepEqual(children.map(item => item.node_type), [
    'child_construct',
    'child_construct',
    'variable_group'
  ]);
  assert.deepEqual(children[2].children.map(item => item.node_type), ['variable', 'variable']);
  assert.equal(children[2].source_ref.question_prompts_included, false);
  assert.doesNotMatch(JSON.stringify(tree), /health_model|StressBurden|TrajectoryRisk/i);
});

test('the same universal node contract accepts Health Model blocks and parameters unchanged', () => {
  const spec = {
    domain_or_construct: 'Health Model',
    research_question: 'How does current burden manifest?',
    conceptual_definition: 'Modeled burden compared with observed manifestation.',
    expected_targets: [
      { label: 'ModeledBurden', definition: 'A modeled state parameter.' },
      { label: 'BurdenManifestationDelta', definition: 'A model-to-observation delta.' }
    ],
    expected_depth: 'Model, parameter, mechanism, and observed variable'
  };
  const groups = [{
    block: 'K',
    family: 'MANIFESTATION',
    domain: 'psychological',
    parameter: 'K_fact',
    codes: ['K_1', 'K_2'],
    source_variables: ['k1', 'k2']
  }];
  const tree = plain(run('buildValidationTree(spec, groups)', { spec, groups }));
  const allNodes = [];
  (function collect(node) {
    allNodes.push(node);
    node.children.forEach(collect);
  }(tree));
  assert.ok(allNodes.some(node => node.node_type === 'child_construct' && node.label === 'ModeledBurden'));
  assert.ok(allNodes.some(node => node.node_type === 'variable_group' && node.label === 'K_fact'));
  assert.deepEqual(
    allNodes.filter(node => node.node_type === 'variable').map(node => node.label),
    ['k1', 'k2']
  );
  assert.equal(new Set(allNodes.map(node => Object.keys(node).sort().join('|'))).size, 1);
});

test('a bank variable group can be the validation target without inventing a child construct', () => {
  const spec = {
    domain_or_construct: 'Observed process',
    research_question: 'What does the group represent?',
    conceptual_definition: 'A group defined by the researcher bank.',
    expected_targets: [],
    expected_depth: 'Variable group',
    target_population: 'Study population',
    language_and_cultural_context: 'es-MX'
  };
  const groups = [{
    block: null,
    family: null,
    domain: 'decision',
    parameter: 'uncertainty_tolerance',
    codes: ['D_1'],
    source_variables: []
  }];
  assert.equal(run('completeSpec(spec, groups)', { spec, groups }), true);
  const tree = plain(run('buildValidationTree(spec, groups)', { spec, groups }));
  assert.equal(tree.children[0].children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].children[0].node_type, 'variable_group');
});

test('each validation node receives its own bundle, direct coverage, aggregate coverage, and depth assessment', () => {
  const spec = {
    domain_or_construct: 'Research object',
    research_question: 'Which outcome?',
    conceptual_definition: 'Defined outcome.',
    expected_targets: [{ label: 'Leaf construct', definition: 'Leaf meaning.' }],
    expected_depth: 'Deep'
  };
  const tree = run('buildValidationTree(spec, [])', { spec });
  const leafId = run('tree.children[0].children[0].children[0].node_id', { tree });
  const candidate = {
    candidate_id: randomUUID(),
    target_node_ids: [leafId],
    depth_match: 'comparable',
    human_disposition: { status: 'accepted' }
  };
  const mappingValue = {
    schema_version: 2,
    mapping_tree: tree,
    candidate_registry: [candidate]
  };
  run('mapping = mappingValue; refreshValidationTree()', { mappingValue });
  const leaf = plain(run('mapping.mapping_tree.children[0].children[0].children[0]'));
  const root = plain(run('mapping.mapping_tree'));
  assert.deepEqual(leaf.validation_bundle, [candidate.candidate_id]);
  assert.deepEqual(leaf.approved_methods, [candidate.candidate_id]);
  assert.equal(leaf.coverage.direct.percent, 100);
  assert.equal(leaf.coverage.aggregate.percent, 100);
  assert.equal(leaf.depth_assessment.by_candidate[candidate.candidate_id], 'comparable');
  assert.deepEqual(root.validation_bundle, [candidate.candidate_id]);
  assert.equal(root.coverage.direct.percent, 0);
  assert.ok(root.coverage.aggregate.percent > 0);
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
    assert.equal(scopedInput.domain_or_construct, 'Social resources');
    assert.deepEqual(
      plain(scopedInput.expected_subconstructs),
      ['Support', 'Trust', 'Help-seeking']
    );
    assert.equal(scopedInput.author_instrument, null);
    assert.equal(scopedInput.conceptual_definition, 'Resources available from trusted people.');
    const coveredIds = scopedInput.validation_targets
      .filter(item => ['Support', 'Trust'].includes(item.label))
      .map(item => item.node_id);
    return {
      candidates: [{
        method_name: 'Candidate Social Method',
        method_abbreviation: 'CSM',
        method_outcome: 'Perceived social support',
        evidence_type: 'questionnaire',
        target_node_ids: coveredIds,
        covered_subconstructs: ['Support', 'Trust'],
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
        subconstruct: 'Help-seeking',
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
  run(`
    sourceBank = null;
    domainInput.value = "Social resources";
    questionInput.value = "To what extent is a person supported under critical life load?";
    definitionInput.value = "Resources available from trusted people.";
    subconstructInput.value = "Support\\nTrust\\nHelp-seeking";
    depthInput.value = "Domain outcome and three subconstructs";
    populationInput.value = "Adults under life load";
    cultureInput.value = "es-MX";
  `);
  await run('runMapping()');

  const result = plain(run('mapping'));
  assert.equal(result.schema, 'research_os.validation_mapping');
  assert.equal(result.schema_version, 2);
  assert.equal(result.owner_account_id, researcher.account_id);
  assert.equal(result.status, 'candidate_mapping_only');
  assert.equal(result.mapping_tree.node_type, 'validation_target');
  assert.equal(result.mapping_tree.children[0].node_type, 'research_outcome');
  assert.equal(result.mapping_tree.children[0].children[0].node_type, 'conceptual_definition');
  assert.deepEqual(
    result.mapping_tree.children[0].children[0].children.map(item => item.node_type),
    ['child_construct', 'child_construct', 'child_construct']
  );
  assert.equal(result.comparison_strategy.unit, 'validation_node_to_method_outcome');
  assert.equal(
    result.comparison_strategy.coverage_rule,
    'union_of_researcher_approved_method_targets_by_node'
  );
  assert.equal(result.comparison_strategy.question_level_mapping, false);
  assert.equal(result.candidate_registry[0].source_verification.status, 'bibliographic_metadata_verified');
  assert.equal(result.candidate_registry[0].human_disposition.status, 'pending');
  assert.deepEqual(
    Object.keys(result.candidate_registry[0].human_reviews),
    ['source_method_identity', 'outcome_fit', 'population_fit', 'language_cultural_fit', 'rights_and_access', 'bundle_inclusion']
  );
  assert.equal(result.ai_provenance.provider, 'groq');
  assert.equal(result.ai_provenance.model, 'openai/gpt-oss-20b');
  assert.equal(result.ai_provenance.prompt_version, 'hierarchical_validation_mapping_v2');
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
