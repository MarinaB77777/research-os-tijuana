import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [migration, api, constructor, joinPage, cabinet, dialogue, qualitative, index] = await Promise.all([
  fs.readFile(new URL('../supabase/advanced_research_modes_v1.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_study.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../join-study.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../cabinet.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../dialogue.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../qualitative.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../index.html', import.meta.url), 'utf8')
]);

test('experimental allocation is atomic, server-owned, concealed, and idempotent', () => {
  assert.match(migration, /create or replace function public\.allocate_experimental_group/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /enrollment_id uuid not null unique/);
  assert.match(migration, /algorithm_version text not null/);
  assert.match(migration, /protocol_snapshot jsonb not null/);
  assert.match(migration, /concealed_from_respondent/);
  assert.match(migration, /Existing study participation is not active/);
  assert.match(joinPage, /invitation\.randomized/);
  assert.doesNotMatch(joinPage, /name=["']group/);
});

test('all three requested randomization methods have complete protocols', () => {
  for (const method of ['simple_random', 'block_random', 'stratified_block_random']) {
    assert.match(api, new RegExp(method));
    assert.match(constructor, new RegExp(method));
    assert.match(migration, new RegExp(method));
  }
  assert.match(api, /Block size must equal the complete allocation-ratio cycle/);
  assert.match(api, /allowed_values/);
  assert.match(constructor, /group_ratios/);
  assert.match(constructor, /allocation_seed/);
});

test('scripted dialogue has deterministic validated routing and exact turn history', () => {
  assert.match(api, /researcher_scripted/);
  assert.match(api, /Scripted dialogue nodes and routing must form a complete valid graph/);
  assert.match(migration, /append_scripted_dialogue_response/);
  assert.match(migration, /Response does not match the scripted node contract/);
  assert.match(migration, /scripted_terminal_route/);
  assert.match(migration, /unique \(dialogue_session_id, ordinal\)/);
  assert.match(constructor, /rulesJson/);
});

test('AI-assisted dialogue pins one allowed model and records every AI decision', () => {
  assert.match(api, /adaptive_dialogue: Object\.freeze/);
  assert.match(api, /groq: new Set\(\['openai\/gpt-oss-20b'\]\)/);
  assert.match(api, /Ask exactly one neutral, non-leading probe at a time/);
  assert.match(api, /promptSha256/);
  assert.match(migration, /pending_processing_token/);
  assert.match(migration, /AI dialogue processing token is invalid or stale/);
  assert.match(migration, /server_limit_applied/);
  assert.match(migration, /v_completion_reason := 'max_turns'/);
  assert.match(migration, /decision_snapshot jsonb/);
  assert.match(migration, /external_processing_disclosure/);
  assert.doesNotMatch(dialogue, /api\.groq\.com|generativelanguage\.googleapis/);
});

test('every dialogue starts only with one-session authenticated consent', () => {
  assert.match(migration, /research_dialogue_consent_acceptances/);
  assert.match(migration, /acceptance_basis text not null check \(acceptance_basis = 'authenticated_checkbox'\)/);
  assert.match(migration, /dialogue_session_id uuid not null unique/);
  assert.match(migration, /Explicit consent acceptance is required/);
  assert.match(cabinet, /dialogue-measurements\/\$\{encodeURIComponent\(selectedDialogue\.dialogue_measurement_id\)\}\/start/);
  assert.match(cabinet, /explicit_acceptance:true/);
});

test('qualitative module preserves sources, exact excerpts, codebook, coding, memos, and triangulation', () => {
  for (const table of [
    'qualitative_projects', 'qualitative_sources', 'qualitative_segments',
    'qualitative_codes', 'qualitative_codings', 'qualitative_memos',
    'qualitative_triangulation_links'
  ]) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(api, /source\.content\.slice\(segment\.start_offset, segment\.end_offset\) !== segment\.exact_text_snapshot/);
  assert.match(api, /Coding records must reference an exact segment and code/);
  assert.match(api, /Triangulation links require qualitative and quantitative evidence plus a human rationale/);
  assert.match(qualitative, /double coding/i);
  assert.match(qualitative, /reflexive/);
  assert.match(qualitative, /not_established/);
  assert.match(index, /href="qualitative\.html"/);
});

test('active qualitative versions are immutable and records remain instead of being deleted', () => {
  assert.match(migration, /Active qualitative project versions are immutable/);
  assert.match(migration, /included_in_version boolean not null default true/);
  assert.doesNotMatch(migration, /delete from public\.qualitative_/i);
  assert.match(migration, /Qualitative project versions must be consecutive/);
  assert.match(qualitative, /function newVersion\(\)/);
});

test('double coding uses independent authenticated records and explicit collaborator roles', () => {
  assert.match(migration, /create table if not exists public\.qualitative_project_collaborators/);
  assert.match(migration, /role text not null check \(role in \('coder', 'reviewer'\)\)/);
  assert.match(migration, /unique \(qualitative_project_id, project_version, segment_id, code_id, coder_account_id\)/);
  assert.match(migration, /create or replace function public\.add_qualitative_coding_record/);
  assert.match(migration, /p_researcher_account_id,p_coding->>'interpretation'/);
  assert.match(api, /\/collaborators\$\/i/);
  assert.match(api, /add_qualitative_coding_record/);
  assert.match(qualitative, /accessRole='owner'/);
  assert.match(qualitative, /coder_identifier/);
  assert.match(qualitative, /revokeCollaborator/);
});

test('randomized enrollment cannot fall back to the legacy non-randomized service RPC', () => {
  assert.match(migration, /revoke execute on function public\.join_study_by_invitation\(uuid,uuid\) from service_role/);
  assert.match(api, /p_strata: req\.body\?\.strata \|\| \{\}/);
});
