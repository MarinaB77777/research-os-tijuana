/**
 * Research OS scientific statistics core.
 *
 * No analysis is declared successful merely because data were supplied.
 * Every method returns its sample accounting, estimand/test, distribution used,
 * effect size, assumptions that require human/design review, and limitations.
 */

const EPSILON = 1e-14;

function finiteNumbers(values) {
  return (values || []).map(Number).filter(Number.isFinite);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, center = mean(values)) {
  if (values.length < 2) return NaN;
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let z = value - 1;
  let series = 0.99999999999980993;
  coefficients.forEach((coefficient, index) => { series += coefficient / (z + index + 1); });
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 300;
  const fpMin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-14) return h;
  }
  throw new Error('Incomplete beta calculation did not converge');
}

function regularizedBeta(x, a, b) {
  if (!(a > 0 && b > 0) || x < 0 || x > 1) return NaN;
  if (x === 0 || x === 1) return x;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2)
    ? factor * betaContinuedFraction(a, b, x) / a
    : 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

function studentTCdf(t, degreesOfFreedom) {
  if (!(degreesOfFreedom > 0)) return NaN;
  if (!Number.isFinite(t)) return t < 0 ? 0 : 1;
  const beta = regularizedBeta(degreesOfFreedom / (degreesOfFreedom + t * t), degreesOfFreedom / 2, 0.5);
  return t >= 0 ? 1 - beta / 2 : beta / 2;
}

function fCdf(fStatistic, numeratorDf, denominatorDf) {
  if (!(numeratorDf > 0 && denominatorDf > 0) || fStatistic < 0) return NaN;
  if (!Number.isFinite(fStatistic)) return 1;
  const x = numeratorDf * fStatistic / (numeratorDf * fStatistic + denominatorDf);
  return regularizedBeta(x, numeratorDf / 2, denominatorDf / 2);
}

function regularizedGammaP(a, x) {
  if (!(a > 0) || x < 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    let ap = a;
    for (let iteration = 1; iteration <= 300; iteration += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  const fpMin = 1e-300;
  let b = x + 1 - a;
  let c = 1 / fpMin;
  let d = 1 / b;
  let h = d;
  for (let iteration = 1; iteration <= 300; iteration += 1) {
    const an = -iteration * (iteration - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = b + an / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function chiSquareSurvival(statistic, degreesOfFreedom) {
  return Math.max(0, 1 - regularizedGammaP(degreesOfFreedom / 2, statistic / 2));
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function inverseStudentT(probability, degreesOfFreedom) {
  if (!(probability > 0 && probability < 1)) return probability === 0 ? -Infinity : Infinity;
  let low = -100;
  let high = 100;
  for (let iteration = 0; iteration < 180; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function ranks(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array(values.length);
  const tieSizes = [];
  let start = 0;
  while (start < ordered.length) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) output[ordered[index].index] = averageRank;
    if (end - start > 1) tieSizes.push(end - start);
    start = end;
  }
  return { ranks: output, tieSizes };
}

function pearsonCoefficient(x, y) {
  const xMean = mean(x);
  const yMean = mean(y);
  let cross = 0;
  let xSquares = 0;
  let ySquares = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xCentered = x[index] - xMean;
    const yCentered = y[index] - yMean;
    cross += xCentered * yCentered;
    xSquares += xCentered * xCentered;
    ySquares += yCentered * yCentered;
  }
  return cross / Math.sqrt(xSquares * ySquares);
}

function descriptive(values) {
  const clean = finiteNumbers(values);
  if (!clean.length) throw new Error('At least one finite numeric observation is required');
  const center = mean(clean);
  return {
    method: 'descriptive_statistics',
    n: clean.length,
    excluded: (values || []).length - clean.length,
    mean: center,
    median: quantile(clean, 0.5),
    standard_deviation: clean.length > 1 ? Math.sqrt(variance(clean, center)) : null,
    minimum: Math.min(...clean),
    q1: quantile(clean, 0.25),
    q3: quantile(clean, 0.75),
    maximum: Math.max(...clean)
  };
}

function simpleLinearRegression(xValues, yValues, confidenceLevel = 0.95) {
  if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length !== yValues.length) {
    throw new Error('Simple linear regression requires two equally sized aligned arrays');
  }
  const x = [];
  const y = [];
  let excluded = 0;
  for (let index = 0; index < xValues.length; index += 1) {
    const predictor = Number(xValues[index]);
    const outcome = Number(yValues[index]);
    if (Number.isFinite(predictor) && Number.isFinite(outcome)) {
      x.push(predictor);
      y.push(outcome);
    } else excluded += 1;
  }
  if (x.length < 3) throw new Error('Simple linear regression requires at least three complete numeric pairs');
  const xMean = mean(x);
  const yMean = mean(y);
  const sxx = x.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (!(sxx > 0)) throw new Error('Simple linear regression is not estimable because the predictor has zero variance');
  const sxy = x.reduce((sum, value, index) => sum + (value - xMean) * (y[index] - yMean), 0);
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const residuals = y.map((value, index) => value - (intercept + slope * x[index]));
  const residualSumSquares = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const totalSumSquares = y.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  if (!(totalSumSquares > 0)) throw new Error('Simple linear regression is not estimable because the outcome has zero variance');
  const df = x.length - 2;
  const meanSquareError = residualSumSquares / df;
  const slopeStandardError = Math.sqrt(meanSquareError / sxx);
  if (!(slopeStandardError > 0)) throw new Error('Simple linear regression has zero residual variance; ordinary inference is not estimable');
  const statistic = slope / slopeStandardError;
  const pValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), df)));
  const critical = inverseStudentT(0.5 + confidenceLevel / 2, df);
  const rSquared = 1 - residualSumSquares / totalSumSquares;
  return {
    method: 'ordinary_least_squares_simple_linear_regression',
    distribution: 'Student t for the slope; equivalent F test with 1 numerator degree of freedom',
    n: x.length,
    excluded_pairs: excluded,
    intercept,
    slope,
    slope_standard_error: slopeStandardError,
    statistic,
    degrees_of_freedom: df,
    p_value_two_sided: pValue,
    confidence_level: confidenceLevel,
    confidence_interval: [slope - critical * slopeStandardError, slope + critical * slopeStandardError],
    f_statistic: statistic ** 2,
    f_degrees_of_freedom: [1, df],
    r_squared: rSquared,
    adjusted_r_squared: 1 - (1 - rSquared) * (x.length - 1) / df,
    root_mean_square_error: Math.sqrt(meanSquareError),
    assumptions: ['correct linear functional form', 'independent observations', 'mean-zero errors conditional on the predictor', 'homoscedastic errors for the reported conventional standard error', 'approximately normal errors for exact small-sample inference'],
    notes: ['An observational regression coefficient is an association and is not a causal effect without an appropriate design and identification argument.']
  };
}

function validateRepeatedMatrix(matrix, methodName) {
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.some(row => !Array.isArray(row))) {
    throw new Error(`${methodName} requires at least two complete participants`);
  }
  const conditions = matrix[0].length;
  if (conditions < 2 || matrix.some(row => row.length !== conditions)) {
    throw new Error(`${methodName} requires the same two or more timepoints for every participant`);
  }
  const numeric = matrix.map(row => row.map(Number));
  if (numeric.flat().some(value => !Number.isFinite(value))) {
    throw new Error(`${methodName} requires a complete finite numeric repeated-measures matrix`);
  }
  return numeric;
}

function repeatedMeasuresAnova(matrix) {
  const values = validateRepeatedMatrix(matrix, 'Repeated-measures ANOVA');
  const participants = values.length;
  const conditions = values[0].length;
  const flat = values.flat();
  const grandMean = mean(flat);
  const participantMeans = values.map(row => mean(row));
  const conditionMeans = values[0].map((_, column) => mean(values.map(row => row[column])));
  const totalSumSquares = flat.reduce((sum, value) => sum + (value - grandMean) ** 2, 0);
  const participantSumSquares = conditions * participantMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0);
  const conditionSumSquares = participants * conditionMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0);
  const errorSumSquares = totalSumSquares - participantSumSquares - conditionSumSquares;
  const conditionDf = conditions - 1;
  const errorDf = (participants - 1) * (conditions - 1);
  const conditionMeanSquare = conditionSumSquares / conditionDf;
  const errorMeanSquare = Math.max(0, errorSumSquares) / errorDf;
  if (!(errorMeanSquare > 0)) throw new Error('Repeated-measures ANOVA is not estimable because residual variance is zero');
  const statistic = conditionMeanSquare / errorMeanSquare;
  return {
    method: 'one_factor_repeated_measures_anova',
    distribution: 'F under the uncorrected sphericity model',
    participants,
    conditions,
    condition_means: conditionMeans,
    statistic,
    degrees_of_freedom: [conditionDf, errorDf],
    p_value: Math.max(0, 1 - fCdf(statistic, conditionDf, errorDf)),
    anova_table: {
      condition: { sum_of_squares: conditionSumSquares, df: conditionDf, mean_square: conditionMeanSquare },
      participants: { sum_of_squares: participantSumSquares, df: participants - 1 },
      error: { sum_of_squares: Math.max(0, errorSumSquares), df: errorDf, mean_square: errorMeanSquare },
      total: { sum_of_squares: totalSumSquares, df: participants * conditions - 1 }
    },
    effect_size: { name: 'partial eta squared', value: conditionSumSquares / (conditionSumSquares + Math.max(0, errorSumSquares)) },
    assumptions: ['the same participants are measured at every selected timepoint', 'independent participants', 'approximately normal within-participant errors', 'sphericity for the uncorrected F inference when more than two timepoints are selected'],
    notes: ['No sphericity correction is silently applied. With more than two timepoints, inspect sphericity or use the Friedman alternative when the parametric model is not justified.']
  };
}

function friedmanTest(matrix) {
  const values = validateRepeatedMatrix(matrix, 'Friedman test');
  const participants = values.length;
  const conditions = values[0].length;
  const rankSums = new Array(conditions).fill(0);
  let tieTerm = 0;
  values.forEach(row => {
    const ranked = ranks(row);
    ranked.ranks.forEach((rank, condition) => { rankSums[condition] += rank; });
    tieTerm += ranked.tieSizes.reduce((sum, size) => sum + size ** 3 - size, 0);
  });
  const uncorrected = 12 / (participants * conditions * (conditions + 1)) *
    rankSums.reduce((sum, value) => sum + value ** 2, 0) - 3 * participants * (conditions + 1);
  const tieCorrection = 1 - tieTerm / (participants * (conditions ** 3 - conditions));
  if (!(tieCorrection > 0)) throw new Error('Friedman test is not estimable because all repeated observations are tied');
  const statistic = uncorrected / tieCorrection;
  const df = conditions - 1;
  return {
    method: 'friedman_repeated_measures_rank_test',
    distribution: 'chi-square asymptotic reference distribution',
    participants,
    conditions,
    rank_sums: rankSums,
    statistic,
    degrees_of_freedom: df,
    p_value: chiSquareSurvival(statistic, df),
    ties_present: tieTerm > 0,
    tie_correction: tieCorrection,
    effect_size: { name: "Kendall's W", value: statistic / (participants * (conditions - 1)) },
    assumptions: ['the same participants are measured at every selected timepoint', 'independent participants', 'at least ordinal outcomes'],
    notes: ['The chi-square reference distribution is asymptotic; the result is labeled accordingly. A significant omnibus result does not identify which timepoints differ.']
  };
}

function welchTTest(firstValues, secondValues, confidenceLevel = 0.95) {
  const first = finiteNumbers(firstValues);
  const second = finiteNumbers(secondValues);
  if (first.length < 2 || second.length < 2) throw new Error('Welch t-test requires at least two observations in each independent group');
  const mean1 = mean(first);
  const mean2 = mean(second);
  const variance1 = variance(first, mean1);
  const variance2 = variance(second, mean2);
  const component1 = variance1 / first.length;
  const component2 = variance2 / second.length;
  const standardError = Math.sqrt(component1 + component2);
  if (!(standardError > 0)) throw new Error('Welch t-test is not estimable because both groups have zero variance');
  const statistic = (mean1 - mean2) / standardError;
  const df = (component1 + component2) ** 2 /
    (component1 ** 2 / (first.length - 1) + component2 ** 2 / (second.length - 1));
  const pValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), df)));
  const critical = inverseStudentT(0.5 + confidenceLevel / 2, df);
  const difference = mean1 - mean2;
  const pooledDf = first.length + second.length - 2;
  const pooledSd = Math.sqrt(((first.length - 1) * variance1 + (second.length - 1) * variance2) / pooledDf);
  const correction = 1 - 3 / (4 * pooledDf - 1);
  return {
    method: 'welch_independent_t_test',
    distribution: 'Student t with Welch-Satterthwaite degrees of freedom',
    n: [first.length, second.length],
    excluded: [(firstValues || []).length - first.length, (secondValues || []).length - second.length],
    means: [mean1, mean2],
    mean_difference: difference,
    standard_error: standardError,
    statistic,
    degrees_of_freedom: df,
    p_value_two_sided: pValue,
    confidence_level: confidenceLevel,
    confidence_interval: [difference - critical * standardError, difference + critical * standardError],
    effect_size: { name: 'Hedges g', value: pooledSd > 0 ? correction * difference / pooledSd : null },
    assumptions: ['independent observations', 'approximately normal sampling distribution within groups or adequate sample size'],
    notes: ['Welch form does not assume equal population variances.']
  };
}

function pairedTTest(firstValues, secondValues, confidenceLevel = 0.95) {
  if (!Array.isArray(firstValues) || !Array.isArray(secondValues) || firstValues.length !== secondValues.length) {
    throw new Error('Paired t-test requires two equally sized aligned arrays');
  }
  const differences = [];
  let excluded = 0;
  for (let index = 0; index < firstValues.length; index += 1) {
    const first = Number(firstValues[index]);
    const second = Number(secondValues[index]);
    if (Number.isFinite(first) && Number.isFinite(second)) differences.push(second - first);
    else excluded += 1;
  }
  if (differences.length < 2) throw new Error('Paired t-test requires at least two complete pairs');
  const differenceMean = mean(differences);
  const differenceSd = Math.sqrt(variance(differences, differenceMean));
  if (!(differenceSd > 0)) throw new Error('Paired t-test is not estimable because all paired differences are identical');
  const standardError = differenceSd / Math.sqrt(differences.length);
  const df = differences.length - 1;
  const statistic = differenceMean / standardError;
  const pValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), df)));
  const critical = inverseStudentT(0.5 + confidenceLevel / 2, df);
  return {
    method: 'paired_t_test',
    distribution: 'Student t',
    pairs: differences.length,
    excluded_pairs: excluded,
    mean_difference: differenceMean,
    standard_error: standardError,
    statistic,
    degrees_of_freedom: df,
    p_value_two_sided: pValue,
    confidence_level: confidenceLevel,
    confidence_interval: [differenceMean - critical * standardError, differenceMean + critical * standardError],
    effect_size: { name: 'Cohen dz', value: differenceMean / differenceSd },
    assumptions: ['paired observations are correctly aligned', 'paired differences are approximately normally distributed']
  };
}

function oneWayAnova(groupObject) {
  const entries = Object.entries(groupObject || {}).map(([name, values]) => [name, finiteNumbers(values)]);
  if (entries.length < 2 || entries.some(([, values]) => values.length === 0)) {
    throw new Error('One-way ANOVA requires at least two non-empty independent groups');
  }
  const totalN = entries.reduce((sum, [, values]) => sum + values.length, 0);
  const groups = entries.length;
  if (totalN <= groups) throw new Error('One-way ANOVA requires residual degrees of freedom greater than zero');
  const grandMean = entries.reduce((sum, [, values]) => sum + values.reduce((a, b) => a + b, 0), 0) / totalN;
  let ssBetween = 0;
  let ssWithin = 0;
  const summaries = {};
  entries.forEach(([name, values]) => {
    const groupMean = mean(values);
    ssBetween += values.length * (groupMean - grandMean) ** 2;
    ssWithin += values.reduce((sum, value) => sum + (value - groupMean) ** 2, 0);
    summaries[name] = descriptive(values);
  });
  const dfBetween = groups - 1;
  const dfWithin = totalN - groups;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  if (!(msWithin > 0)) throw new Error('One-way ANOVA is not estimable because within-group variance is zero');
  const statistic = msBetween / msWithin;
  const pValue = Math.max(0, 1 - fCdf(statistic, dfBetween, dfWithin));
  const ssTotal = ssBetween + ssWithin;
  return {
    method: 'one_way_anova',
    distribution: 'F',
    groups: summaries,
    total_n: totalN,
    statistic,
    degrees_of_freedom: [dfBetween, dfWithin],
    p_value: pValue,
    anova_table: {
      between: { sum_of_squares: ssBetween, df: dfBetween, mean_square: msBetween },
      within: { sum_of_squares: ssWithin, df: dfWithin, mean_square: msWithin },
      total: { sum_of_squares: ssTotal, df: totalN - 1 }
    },
    effect_sizes: {
      eta_squared: ssTotal > 0 ? ssBetween / ssTotal : null,
      omega_squared: ssTotal + msWithin > 0 ? Math.max(0, (ssBetween - dfBetween * msWithin) / (ssTotal + msWithin)) : null
    },
    assumptions: ['independent observations', 'approximately normal residuals within groups', 'homogeneity of population variances'],
    notes: ['A significant omnibus test identifies a group effect but not which groups differ. Prespecified contrasts or multiplicity-controlled post-hoc tests are required.']
  };
}

function pearsonCorrelation(xValues, yValues, confidenceLevel = 0.95) {
  if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length !== yValues.length) {
    throw new Error('Pearson correlation requires two equally sized aligned arrays');
  }
  const x = [];
  const y = [];
  let excluded = 0;
  for (let index = 0; index < xValues.length; index += 1) {
    const first = Number(xValues[index]);
    const second = Number(yValues[index]);
    if (Number.isFinite(first) && Number.isFinite(second)) { x.push(first); y.push(second); } else excluded += 1;
  }
  if (x.length < 3) throw new Error('Pearson correlation requires at least three complete numeric pairs');
  const r = pearsonCoefficient(x, y);
  if (!Number.isFinite(r)) throw new Error('Pearson correlation is not estimable because at least one variable has zero variance');
  const df = x.length - 2;
  const statistic = Math.abs(r) === 1 ? (r < 0 ? -Infinity : Infinity) : r * Math.sqrt(df / (1 - r * r));
  const pValue = Number.isFinite(statistic) ? Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), df))) : 0;
  let confidenceInterval = null;
  if (x.length > 3 && Math.abs(r) < 1) {
    const z = Math.atanh(r);
    const zCritical = 1.959963984540054;
    const margin = zCritical / Math.sqrt(x.length - 3);
    confidenceInterval = [Math.tanh(z - margin), Math.tanh(z + margin)];
  }
  return {
    method: 'pearson_correlation',
    distribution: 'Student t for H0: population correlation = 0',
    n: x.length,
    excluded_pairs: excluded,
    coefficient: r,
    statistic,
    degrees_of_freedom: df,
    p_value_two_sided: pValue,
    confidence_level: confidenceLevel,
    confidence_interval: confidenceInterval,
    confidence_interval_method: confidenceInterval ? 'Fisher z asymptotic interval' : null,
    effect_size: { name: 'r squared', value: r * r },
    assumptions: ['independent paired observations', 'linear relationship', 'no influential outliers', 'bivariate normality for exact small-sample inference']
  };
}

function permutationSpearmanPValue(xRanks, yRanks, observed) {
  const permuted = [...yRanks];
  let extreme = 0;
  let total = 0;
  function visit(start) {
    if (start === permuted.length) {
      total += 1;
      if (Math.abs(pearsonCoefficient(xRanks, permuted)) >= Math.abs(observed) - 1e-12) extreme += 1;
      return;
    }
    for (let index = start; index < permuted.length; index += 1) {
      [permuted[start], permuted[index]] = [permuted[index], permuted[start]];
      visit(start + 1);
      [permuted[start], permuted[index]] = [permuted[index], permuted[start]];
    }
  }
  visit(0);
  return extreme / total;
}

function spearmanCorrelation(xValues, yValues) {
  if (!Array.isArray(xValues) || !Array.isArray(yValues) || xValues.length !== yValues.length) {
    throw new Error('Spearman correlation requires two equally sized aligned arrays');
  }
  const x = [];
  const y = [];
  let excluded = 0;
  for (let index = 0; index < xValues.length; index += 1) {
    const first = Number(xValues[index]);
    const second = Number(yValues[index]);
    if (Number.isFinite(first) && Number.isFinite(second)) { x.push(first); y.push(second); } else excluded += 1;
  }
  if (x.length < 3) throw new Error('Spearman correlation requires at least three complete numeric pairs');
  const xRanked = ranks(x);
  const yRanked = ranks(y);
  const rho = pearsonCoefficient(xRanked.ranks, yRanked.ranks);
  if (!Number.isFinite(rho)) throw new Error('Spearman correlation is not estimable because at least one ranked variable has zero variance');
  const exact = x.length <= 9 && xRanked.tieSizes.length === 0 && yRanked.tieSizes.length === 0;
  const df = x.length - 2;
  const statistic = Math.abs(rho) === 1 ? (rho < 0 ? -Infinity : Infinity) : rho * Math.sqrt(df / (1 - rho * rho));
  const pValue = exact
    ? permutationSpearmanPValue(xRanked.ranks, yRanked.ranks, rho)
    : (Number.isFinite(statistic) ? Math.min(1, 2 * (1 - studentTCdf(Math.abs(statistic), df))) : 0);
  return {
    method: 'spearman_rank_correlation',
    n: x.length,
    excluded_pairs: excluded,
    coefficient: rho,
    statistic: exact ? null : statistic,
    degrees_of_freedom: exact ? null : df,
    p_value_two_sided: pValue,
    p_value_method: exact ? 'exact permutation distribution' : 'large-sample Student t approximation',
    ties_present: xRanked.tieSizes.length > 0 || yRanked.tieSizes.length > 0,
    assumptions: ['independent paired observations', 'monotonic association for interpretation']
  };
}

function logCombination(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function combinationCount(n, k) {
  return Math.round(Math.exp(logCombination(n, k)));
}

function mannWhitney(firstValues, secondValues) {
  const first = finiteNumbers(firstValues);
  const second = finiteNumbers(secondValues);
  if (!first.length || !second.length) throw new Error('Mann-Whitney U requires two non-empty independent groups');
  const combined = [...first, ...second];
  const ranked = ranks(combined);
  const rankSum1 = ranked.ranks.slice(0, first.length).reduce((a, b) => a + b, 0);
  const u1 = rankSum1 - first.length * (first.length + 1) / 2;
  const u2 = first.length * second.length - u1;
  const noTies = ranked.tieSizes.length === 0;
  const combinations = combinationCount(combined.length, first.length);
  let pValue;
  let pValueMethod;
  let z = null;
  if (noTies && combinations <= 200000) {
    const distribution = [];
    function choose(start, remaining, rankSum) {
      if (remaining === 0) {
        distribution.push(rankSum - first.length * (first.length + 1) / 2);
        return;
      }
      for (let index = start; index <= combined.length - remaining; index += 1) choose(index + 1, remaining - 1, rankSum + index + 1);
    }
    choose(0, first.length, 0);
    const lower = distribution.filter(value => value <= u1 + 1e-12).length / distribution.length;
    const upper = distribution.filter(value => value >= u1 - 1e-12).length / distribution.length;
    pValue = Math.min(1, 2 * Math.min(lower, upper));
    pValueMethod = 'exact permutation distribution';
  } else {
    const n1 = first.length;
    const n2 = second.length;
    const total = n1 + n2;
    const tieTerm = ranked.tieSizes.reduce((sum, size) => sum + size ** 3 - size, 0);
    const varianceU = n1 * n2 / 12 * ((total + 1) - tieTerm / (total * (total - 1)));
    if (!(varianceU > 0)) throw new Error('Mann-Whitney U is not estimable because all observations are tied');
    z = (Math.abs(u1 - n1 * n2 / 2) - 0.5) / Math.sqrt(varianceU);
    pValue = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
    pValueMethod = 'tie-corrected normal approximation with continuity correction';
  }
  return {
    method: 'mann_whitney_u',
    n: [first.length, second.length],
    excluded: [(firstValues || []).length - first.length, (secondValues || []).length - second.length],
    u: [u1, u2],
    statistic: Math.min(u1, u2),
    z,
    p_value_two_sided: pValue,
    p_value_method: pValueMethod,
    ties_present: !noTies,
    effect_size: { name: 'rank-biserial correlation', value: 2 * u1 / (first.length * second.length) - 1 },
    assumptions: ['independent observations', 'ordinal or continuous outcome', 'similar distribution shapes if interpreted as a location shift']
  };
}

function kruskalWallis(groupObject) {
  const entries = Object.entries(groupObject || {}).map(([name, values]) => [name, finiteNumbers(values)]);
  if (entries.length < 2 || entries.some(([, values]) => values.length === 0)) throw new Error('Kruskal-Wallis requires at least two non-empty independent groups');
  const combined = entries.flatMap(([, values]) => values);
  const ranked = ranks(combined);
  const total = combined.length;
  let offset = 0;
  let sum = 0;
  const rankSums = {};
  entries.forEach(([name, values]) => {
    const rankSum = ranked.ranks.slice(offset, offset + values.length).reduce((a, b) => a + b, 0);
    offset += values.length;
    rankSums[name] = rankSum;
    sum += rankSum ** 2 / values.length;
  });
  const uncorrected = 12 / (total * (total + 1)) * sum - 3 * (total + 1);
  const tieCorrection = 1 - ranked.tieSizes.reduce((acc, size) => acc + size ** 3 - size, 0) / (total ** 3 - total);
  if (!(tieCorrection > 0)) throw new Error('Kruskal-Wallis is not estimable because all observations are tied');
  const statistic = uncorrected / tieCorrection;
  const df = entries.length - 1;
  return {
    method: 'kruskal_wallis',
    distribution: 'chi-square asymptotic reference distribution',
    group_sizes: Object.fromEntries(entries.map(([name, values]) => [name, values.length])),
    rank_sums: rankSums,
    statistic,
    degrees_of_freedom: df,
    p_value: chiSquareSurvival(statistic, df),
    ties_present: ranked.tieSizes.length > 0,
    effect_size: { name: 'epsilon squared', value: Math.max(0, (statistic - entries.length + 1) / (total - entries.length)) },
    assumptions: ['independent observations', 'ordinal or continuous outcome', 'similar distribution shapes if interpreted as a location shift']
  };
}

function holmAdjustedPValues(pValues) {
  const ordered = pValues.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const adjusted = new Array(pValues.length);
  let runningMaximum = 0;
  ordered.forEach((entry, rank) => {
    runningMaximum = Math.max(runningMaximum, Math.min(1, entry.value * (ordered.length - rank)));
    adjusted[entry.index] = runningMaximum;
  });
  return adjusted;
}

function pairwiseWelchHolm(groupObject, confidenceLevel = 0.95) {
  const entries = Object.entries(groupObject || {}).map(([name, values]) => [name, finiteNumbers(values)]);
  if (entries.length < 2 || entries.some(([, values]) => values.length < 2)) {
    throw new Error('Pairwise Welch comparisons require at least two groups with two observations each');
  }
  const comparisons = [];
  for (let first = 0; first < entries.length; first += 1) {
    for (let second = first + 1; second < entries.length; second += 1) {
      const result = welchTTest(entries[first][1], entries[second][1], confidenceLevel);
      comparisons.push({ group_a: entries[first][0], group_b: entries[second][0], ...result });
    }
  }
  const adjusted = holmAdjustedPValues(comparisons.map(comparison => comparison.p_value_two_sided));
  comparisons.forEach((comparison, index) => { comparison.p_value_holm = adjusted[index]; });
  return {
    method: 'pairwise_welch_t_tests_with_holm_correction',
    family_size: comparisons.length,
    multiplicity_correction: 'Holm step-down family-wise error rate control',
    comparisons,
    assumptions: ['each pair contains independent observations', 'approximately normal sampling distributions within groups or adequate sample sizes'],
    notes: ['Welch comparisons do not assume equal population variances. The Holm-adjusted p-values belong to the complete reported comparison family.']
  };
}

function dunnHolm(groupObject) {
  const entries = Object.entries(groupObject || {}).map(([name, values]) => [name, finiteNumbers(values)]);
  if (entries.length < 2 || entries.some(([, values]) => values.length === 0)) {
    throw new Error('Dunn comparisons require at least two non-empty groups');
  }
  const combined = entries.flatMap(([, values]) => values);
  const ranked = ranks(combined);
  const total = combined.length;
  const tieTerm = ranked.tieSizes.reduce((sum, size) => sum + size ** 3 - size, 0);
  const baseVariance = total * (total + 1) / 12 - tieTerm / (12 * (total - 1));
  if (!(baseVariance > 0)) throw new Error('Dunn comparisons are not estimable because all observations are tied');
  let offset = 0;
  const summaries = entries.map(([name, values]) => {
    const meanRank = mean(ranked.ranks.slice(offset, offset + values.length));
    offset += values.length;
    return { name, n: values.length, mean_rank: meanRank };
  });
  const comparisons = [];
  for (let first = 0; first < summaries.length; first += 1) {
    for (let second = first + 1; second < summaries.length; second += 1) {
      const standardError = Math.sqrt(baseVariance * (1 / summaries[first].n + 1 / summaries[second].n));
      const z = (summaries[first].mean_rank - summaries[second].mean_rank) / standardError;
      comparisons.push({
        group_a: summaries[first].name,
        group_b: summaries[second].name,
        n: [summaries[first].n, summaries[second].n],
        mean_rank_difference: summaries[first].mean_rank - summaries[second].mean_rank,
        statistic: z,
        p_value_two_sided: Math.min(1, 2 * (1 - normalCdf(Math.abs(z))))
      });
    }
  }
  const adjusted = holmAdjustedPValues(comparisons.map(comparison => comparison.p_value_two_sided));
  comparisons.forEach((comparison, index) => { comparison.p_value_holm = adjusted[index]; });
  return {
    method: 'dunn_rank_comparisons_with_holm_correction',
    distribution: 'tie-corrected normal approximation',
    family_size: comparisons.length,
    multiplicity_correction: 'Holm step-down family-wise error rate control',
    ties_present: ranked.tieSizes.length > 0,
    comparisons,
    assumptions: ['independent observations', 'at least ordinal outcomes'],
    notes: ['These are rank comparisons with an asymptotic reference distribution. The Holm-adjusted p-values belong to the complete reported comparison family.']
  };
}

function fisherExact(table) {
  if (!Array.isArray(table) || table.length !== 2 || table.some(row => !Array.isArray(row) || row.length !== 2)) {
    throw new Error('Fisher exact test requires a 2×2 contingency table');
  }
  const values = table.flat().map(Number);
  if (values.some(value => !Number.isInteger(value) || value < 0)) throw new Error('Fisher exact counts must be non-negative integers');
  const [[a, b], [c, d]] = table.map(row => row.map(Number));
  const row1 = a + b;
  const row2 = c + d;
  const column1 = a + c;
  const total = row1 + row2;
  if (total === 0) throw new Error('Fisher exact table contains no observations');
  const minimumA = Math.max(0, column1 - row2);
  const maximumA = Math.min(row1, column1);
  const logDenominator = logCombination(total, row1);
  const probability = candidate => Math.exp(logCombination(column1, candidate) + logCombination(total - column1, row1 - candidate) - logDenominator);
  const observedProbability = probability(a);
  let pValue = 0;
  for (let candidate = minimumA; candidate <= maximumA; candidate += 1) {
    const candidateProbability = probability(candidate);
    if (candidateProbability <= observedProbability + 1e-12) pValue += candidateProbability;
  }
  return {
    method: 'fisher_exact_2x2',
    table: [[a, b], [c, d]],
    p_value_two_sided: Math.min(1, pValue),
    p_value_method: 'exact conditional hypergeometric distribution; probability-ordering two-sided definition',
    odds_ratio: b * c === 0 ? (a * d === 0 ? null : Infinity) : a * d / (b * c),
    assumptions: ['independent observations', 'fixed margins under the conditional null model']
  };
}

function chiSquareIndependence(table) {
  if (!Array.isArray(table) || table.length < 2 || table.some(row => !Array.isArray(row) || row.length !== table[0].length) || table[0].length < 2) {
    throw new Error('Chi-square independence test requires a rectangular table with at least 2 rows and 2 columns');
  }
  const observed = table.map(row => row.map(Number));
  if (observed.flat().some(value => !Number.isInteger(value) || value < 0)) throw new Error('Contingency-table counts must be non-negative integers');
  const rowTotals = observed.map(row => row.reduce((a, b) => a + b, 0));
  const columnTotals = observed[0].map((_, column) => observed.reduce((sum, row) => sum + row[column], 0));
  const total = rowTotals.reduce((a, b) => a + b, 0);
  if (total === 0 || rowTotals.some(value => value === 0) || columnTotals.some(value => value === 0)) throw new Error('Contingency table has an empty marginal row or column');
  const expected = observed.map((row, rowIndex) => row.map((_, columnIndex) => rowTotals[rowIndex] * columnTotals[columnIndex] / total));
  let statistic = 0;
  observed.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    statistic += (value - expected[rowIndex][columnIndex]) ** 2 / expected[rowIndex][columnIndex];
  }));
  const df = (observed.length - 1) * (observed[0].length - 1);
  const belowFive = expected.flat().filter(value => value < 5).length;
  return {
    method: 'pearson_chi_square_independence',
    distribution: 'chi-square asymptotic reference distribution',
    observed,
    expected,
    statistic,
    degrees_of_freedom: df,
    p_value: chiSquareSurvival(statistic, df),
    effect_size: { name: "Cramer's V", value: Math.sqrt(statistic / (total * Math.min(observed.length - 1, observed[0].length - 1))) },
    diagnostics: {
      expected_cells_below_5: belowFive,
      expected_cells_below_1: expected.flat().filter(value => value < 1).length,
      warning: belowFive / expected.flat().length > 0.2 ? 'More than 20% of expected cell counts are below 5; asymptotic inference may be unreliable.' : null
    },
    assumptions: ['independent observations', 'mutually exclusive categories', 'adequate expected cell counts for asymptotic inference']
  };
}

export const ScientificStats = Object.freeze({
  descriptive,
  simpleLinearRegression,
  welchTTest,
  pairedTTest,
  repeatedMeasuresAnova,
  friedmanTest,
  oneWayAnova,
  pearsonCorrelation,
  spearmanCorrelation,
  mannWhitney,
  kruskalWallis,
  pairwiseWelchHolm,
  dunnHolm,
  fisherExact,
  chiSquareIndependence,
  distributions: Object.freeze({ studentTCdf, fCdf, chiSquareSurvival })
});

export class ResearchStatsAnalyzer {
  analyze(method, payload) {
    const operation = ScientificStats[method];
    if (typeof operation !== 'function') throw new Error(`Unknown statistical method: ${method}`);
    return operation(...payload);
  }
}
