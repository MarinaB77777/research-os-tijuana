/**
 * Research OS - Advanced Analytical Core (Longitudinal, Cross-Tab & Dynamic Cohorts)
 */

export class ResearchStatsAnalyzer {
    constructor() {
        this.modules = new Map();
        this._registerAdvancedModules();
    }

    register(name, computeFn) {
        this.modules.set(name, computeFn);
    }

    sanitize(val) {
        if (val === null || val === undefined || val === '') return null;
        const num = Number(val);
        return Number.isFinite(num) ? num : null;
    }

    mean(arr) {
        const values = arr.filter(Number.isFinite);
        if (!values.length) return null;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    stdDev(arr, meanVal) {
        const values = arr.filter(Number.isFinite);
        if (values.length <= 1) return null;
        const m = meanVal !== undefined && meanVal !== null ? meanVal : this.mean(values);
        const sumSq = values.reduce((acc, val) => acc + Math.pow(val - m, 2), 0);
        return Math.sqrt(sumSq / (values.length - 1));
    }

    analyze(dataset, config) {
        if (!Array.isArray(dataset) || dataset.length === 0) {
            throw new Error("Датасет пуст или невалиден.");
        }

        const results = {
            sampleSize: dataset.length,
            timestamp: new Date().toISOString(),
            computations: {}
        };

        for (const [name, computeFn] of this.modules.entries()) {
            try {
                results.computations[name] = computeFn(dataset, config, this);
            } catch (err) {
                results.computations[name] = { error: err.message };
            }
        }

        return results;
    }

    _registerAdvancedModules() {
        // 1. МОДУЛЬ: Кросс-табуляция (Зависимость Вопрос А от Вопроса Б)
        this.register('crossTabulation', (data, config) => {
            const { rowKey, colKey } = config;
            if (!rowKey || !colKey) return { status: 'skipped', reason: 'rowKey and colKey required' };

            const matrix = {};
            let totalCount = 0;
            let excludedMissing = 0;

            data.forEach(row => {
                if (row[rowKey] === undefined || row[rowKey] === null ||
                    row[colKey] === undefined || row[colKey] === null) {
                    excludedMissing++;
                    return;
                }
                const rVal = String(row[rowKey]);
                const cVal = String(row[colKey]);

                if (!matrix[rVal]) matrix[rVal] = {};
                matrix[rVal][cVal] = (matrix[rVal][cVal] || 0) + 1;
                totalCount++;
            });

            return {
                type: 'contingency_matrix',
                rowVariable: rowKey,
                colVariable: colKey,
                matrix: matrix,
                observations: totalCount,
                excludedMissing
            };
        });

        // 2. МОДУЛЬ: Лонгитюдный анализ / Изменения по участникам во времени
        this.register('longitudinalTracking', (data, config, core) => {
            const { participantIdKey, timestampKey, targetKey } = config;
            if (!participantIdKey || !timestampKey || !targetKey) {
                return { status: 'skipped', reason: 'participantIdKey, timestampKey, and targetKey required' };
            }

            const participantTimelines = {};

            data.forEach(row => {
                const id = row[participantIdKey];
                const time = row[timestampKey];
                const val = core.sanitize(row[targetKey]);
                const timeMs = new Date(time).getTime();

                if (id !== undefined && id !== null && Number.isFinite(timeMs) && val !== null) {
                    if (!participantTimelines[id]) participantTimelines[id] = [];
                    participantTimelines[id].push({ time: timeMs, val });
                }
            });

            const trajectories = {};
            let participantsTracked = 0;

            for (const [id, points] of Object.entries(participantTimelines)) {
                // Сортируем по времени для каждого участника
                points.sort((a, b) => a.time - b.time);
                
                if (points.length > 1) {
                    const initial = points[0].val;
                    const latest = points[points.length - 1].val;
                    trajectories[id] = {
                        steps: points.length,
                        initialValue: initial,
                        latestValue: latest,
                        delta: Number((latest - initial).toFixed(2)),
                        trend: latest > initial ? 'increasing' : (latest < initial ? 'decreasing' : 'stable')
                    };
                    participantsTracked++;
                }
            }

            return {
                type: 'longitudinal_summary',
                trackedParticipants: participantsTracked,
                trajectories: trajectories
            };
        });

        // 3. МОДУЛЬ: Динамическое формирование групп / Когортный срез
        this.register('dynamicCohortSplit', (data, config, core) => {
            const { splitKey, targetKey } = config;
            if (!splitKey || !targetKey) return { status: 'skipped', reason: 'splitKey and targetKey required' };

            const cohorts = {};
            let excludedMissing = 0;

            data.forEach(row => {
                const metricVal = core.sanitize(row[targetKey]);
                if (row[splitKey] === undefined || row[splitKey] === null || metricVal === null) {
                    excludedMissing++;
                    return;
                }
                const groupValue = String(row[splitKey]);

                if (!cohorts[groupValue]) cohorts[groupValue] = [];
                cohorts[groupValue].push(metricVal);
            });

            const summary = {};
            for (const [cohortName, values] of Object.entries(cohorts)) {
                const m = core.mean(values);
                const sd = core.stdDev(values, m);
                summary[cohortName] = {
                    size: values.length,
                    mean: m === null ? null : Number(m.toFixed(2)),
                    stdDev: sd === null ? null : Number(sd.toFixed(2))
                };
            }

            return {
                type: 'cohort_comparison',
                splitVariable: splitKey,
                cohorts: summary,
                excludedMissing
            };
        });
    }
}
