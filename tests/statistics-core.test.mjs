import assert from 'node:assert/strict';
import test from 'node:test';
import { ScientificStats } from '../analyticsCore.js';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('Welch independent t-test uses the Student t distribution with fractional df', () => {
  const result = ScientificStats.welchTTest(
    [12, 14, 15, 13, 16, 18],
    [10, 11, 9, 12, 13, 10, 8]
  );
  close(result.statistic, 3.8695652173913038);
  close(result.degrees_of_freedom, 9.552256637470219);
  close(result.p_value_two_sided, 0.003389213554986931, 1e-11);
  assert.match(result.distribution, /Student t/);
});

test('one-way ANOVA uses the exact F reference distribution and reports the ANOVA table', () => {
  const result = ScientificStats.oneWayAnova({
    a: [1, 2, 3],
    b: [2, 4, 6],
    c: [5, 6, 7]
  });
  close(result.statistic, 6);
  close(result.p_value, 0.03703703703703703, 1e-12);
  assert.deepEqual(result.degrees_of_freedom, [2, 6]);
  close(result.anova_table.between.sum_of_squares, 24);
});

test('Pearson and exact small-sample Spearman correlations are distinguished', () => {
  const pearson = ScientificStats.pearsonCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 7]);
  close(pearson.coefficient, 0.8241633836921339);
  close(pearson.p_value_two_sided, 0.08613863131395952, 1e-9);
  const spearman = ScientificStats.spearmanCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
  close(spearman.coefficient, 0.8);
  close(spearman.p_value_two_sided, 0.13333333333333333);
  assert.equal(spearman.p_value_method, 'exact permutation distribution');
});

test('Mann-Whitney uses its exact permutation distribution when feasible', () => {
  const result = ScientificStats.mannWhitney([1, 3, 5], [2, 4, 6]);
  close(result.u[0], 3);
  close(result.p_value_two_sided, 0.7);
  assert.equal(result.p_value_method, 'exact permutation distribution');
});

test('Kruskal-Wallis applies tie correction and chi-square inference', () => {
  const result = ScientificStats.kruskalWallis({
    a: [1, 2, 3],
    b: [2, 3, 4],
    c: [7, 8, 9]
  });
  close(result.statistic, 6.056497175141243);
  close(result.p_value, 0.0484003328812889, 1e-9);
  assert.equal(result.ties_present, true);
});

test('Fisher exact and Pearson chi-square match reference results', () => {
  const fisher = ScientificStats.fisherExact([[1, 9], [11, 3]]);
  close(fisher.odds_ratio, 0.030303030303030304);
  close(fisher.p_value_two_sided, 0.0027594561852200836, 1e-12);
  const chi = ScientificStats.chiSquareIndependence([[10, 20, 30], [6, 9, 17]]);
  close(chi.statistic, 0.27157465150403504);
  close(chi.p_value, 0.873028283380073, 1e-9);
  assert.equal(chi.degrees_of_freedom, 2);
});

test('paired t-test uses complete aligned pairs and Student t inference', () => {
  const result = ScientificStats.pairedTTest([1, 2, 3, 4, 5], [2, 2, 4, 5, 7]);
  close(result.statistic, 3.162277660168379);
  close(result.p_value_two_sided, 0.03410942316740963, 1e-10);
  assert.equal(result.degrees_of_freedom, 4);
});

test('simple OLS regression reports slope inference, interval, and model fit', () => {
  const result = ScientificStats.simpleLinearRegression(
    [1, 2, 3, 4, 5],
    [2, 3, 5, 4, 6]
  );
  close(result.slope, 0.9);
  close(result.statistic, 3.5762373640756184);
  close(result.p_value_two_sided, 0.03738607346849854, 1e-10);
  close(result.r_squared, 0.81);
  assert.deepEqual(result.f_degrees_of_freedom, [1, 3]);
  assert.match(result.distribution, /Student t/);
});

test('repeated-measures ANOVA separates participant and timepoint variation', () => {
  const result = ScientificStats.repeatedMeasuresAnova([
    [1, 2, 3],
    [2, 4, 6],
    [3, 4, 5],
    [4, 5, 7]
  ]);
  close(result.statistic, 30.33333333333326, 1e-10);
  close(result.p_value, 0.0007289999999999797, 1e-12);
  assert.deepEqual(result.degrees_of_freedom, [2, 6]);
  close(result.anova_table.participants.sum_of_squares, 17);
});

test('Friedman repeated-measures test reports tie correction and Kendall W', () => {
  const result = ScientificStats.friedmanTest([
    [1, 2, 3],
    [2, 4, 6],
    [3, 4, 5],
    [4, 5, 7]
  ]);
  close(result.statistic, 8);
  close(result.p_value, 0.01831563888873422, 1e-12);
  close(result.effect_size.value, 1);
  assert.equal(result.tie_correction, 1);
});

test('pairwise Welch and Dunn comparisons control the complete family with Holm', () => {
  const groups = {
    a: [1, 2, 3, 4],
    b: [3, 4, 5, 6],
    c: [8, 9, 10, 11]
  };
  const welch = ScientificStats.pairwiseWelchHolm(groups);
  const dunn = ScientificStats.dunnHolm(groups);
  assert.equal(welch.comparisons.length, 3);
  assert.equal(dunn.comparisons.length, 3);
  welch.comparisons.forEach(comparison => {
    assert.ok(comparison.p_value_holm >= comparison.p_value_two_sided);
    assert.ok(comparison.p_value_holm <= 1);
  });
  dunn.comparisons.forEach(comparison => {
    assert.ok(comparison.p_value_holm >= comparison.p_value_two_sided);
    assert.ok(comparison.p_value_holm <= 1);
  });
  assert.match(welch.multiplicity_correction, /Holm/);
  assert.match(dunn.distribution, /normal approximation/);
});

test('invalid or non-estimable inputs are blocked instead of returning null success', () => {
  assert.throws(() => ScientificStats.welchTTest([1], [2, 3]), /at least two/);
  assert.throws(() => ScientificStats.pearsonCorrelation([1, 1, 1], [1, 2, 3]), /zero variance/);
  assert.throws(() => ScientificStats.chiSquareIndependence([[0, 0], [1, 2]]), /empty marginal/);
  assert.throws(() => ScientificStats.simpleLinearRegression([1, 1, 1], [1, 2, 3]), /zero variance/);
  assert.throws(() => ScientificStats.repeatedMeasuresAnova([[1, 2], [3]]), /same two or more/);
});
