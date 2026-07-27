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
        const num = Number(val);
        return (typeof num === 'number' && !isNaN(num)) ? num : 0;
    }

    mean(arr) {
        if (!arr.length) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    stdDev(arr, meanVal) {
        if (arr.length <= 1) return 0;
        const m = meanVal !== undefined ? meanVal : this.mean(arr);
        const sumSq = arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0);
        return Math.sqrt(sumSq / (arr.length - 1));
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

            data.forEach(row => {
                const rVal = row[rowKey] !== undefined ? String(row[rowKey]) : 'N/A';
                const cVal = row[colKey] !== undefined ? String(row[colKey]) : 'N/A';

                if (!matrix[rVal]) matrix[rVal] = {};
                matrix[rVal][cVal] = (matrix[rVal][cVal] || 0) + 1;
                totalCount++;
            });

            return {
                type: 'contingency_matrix',
                rowVariable: rowKey,
                colVariable: colKey,
                matrix: matrix,
                observations: totalCount
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

                if (id !== undefined && time !== undefined) {
                    if (!participantTimelines[id]) participantTimelines[id] = [];
                    participantTimelines[id].push({ time: new Date(time).getTime(), val });
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

            data.forEach(row => {
                const groupValue = row[splitKey] !== undefined ? String(row[splitKey]) : 'Undefined';
                const metricVal = core.sanitize(row[targetKey]);

                if (!cohorts[groupValue]) cohorts[groupValue] = [];
                cohorts[groupValue].push(metricVal);
            });

            const summary = {};
            for (const [cohortName, values] of Object.entries(cohorts)) {
                const m = core.mean(values);
                summary[cohortName] = {
                    size: values.length,
                    mean: Number(m.toFixed(2)),
                    stdDev: Number(core.stdDev(values, m).toFixed(2))
                };
            }

            return {
                type: 'cohort_comparison',
                splitVariable: splitKey,
                cohorts: summary
            };
        });
    }
}