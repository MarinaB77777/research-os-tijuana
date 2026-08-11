import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('the research cycle uses one identity chain from registration through analysis', async () => {
  const [
    api,
    registration,
    studyContract,
    completionContract,
    analysisContract,
    registrationPage,
    joinPage,
    cabinet,
    assessment,
    analysisPage
  ] = await Promise.all([
    fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/public_account_registration_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/research_study_contract_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/collection_completion_contract_v2.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../supabase/statistical_analysis_contract_v1.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../register.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../join-study.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../cabinet.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../assessment.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../data-analysis.html', import.meta.url), 'utf8')
  ]);

  // Both scalable roles self-register, but only a respondent can join and answer.
  assert.match(registration, /p_role not in \('researcher', 'respondent'\)/);
  assert.match(registrationPage, /registerAccount/);
  assert.match(joinPage, /verify\('respondent'\)/);
  assert.match(api, /verifyAccess\(req, 'respondent'/);

  // Joining creates assigned measurements; it does not bypass consent or start a session.
  assert.match(studyContract, /join_study_by_invitation/);
  assert.match(studyContract, /research_participant_measurements/);
  assert.doesNotMatch(joinPage, /explicit_acceptance/);
  assert.match(cabinet, /\/respondent\/measurements\/\$\{encodeURIComponent\(selectedQuestionnaire\.participant_measurement_id\)\}\/consent/);
  assert.match(cabinet, /explicit_acceptance:true/);
  assert.match(studyContract, /p_explicit_acceptance is distinct from true/);
  assert.match(studyContract, /consent_acceptance_id/);

  // Collection writes the same study, group, timepoint, assignment, item and version identities.
  assert.match(assessment, /participant_measurement_id/);
  assert.match(assessment, /questionnaire_item_id/);
  assert.match(completionContract, /research_response_records/);
  assert.match(completionContract, /participant_measurement_id/);
  assert.match(completionContract, /questionnaire_item_id/);
  assert.match(completionContract, /status = 'completed'/);

  // Statistical analysis reads only those completed sessions, scoped to the owning researcher.
  assert.match(api, /analysisRecordsMatch = path\.match/);
  assert.match(api, /analysis\\\/studies/);
  assert.match(api, /load_researcher_analysis_records/);
  assert.match(analysisContract, /session\.status = 'completed'/);
  assert.match(analysisContract, /session\.researcher_account_id = p_researcher_account_id/);
  assert.match(analysisContract, /session\.study_id = p_study_id/);
  assert.match(analysisPage, /\/analysis\/studies\/\$\{encodeURIComponent\(study\.study_id\)\}\/records/);
});
