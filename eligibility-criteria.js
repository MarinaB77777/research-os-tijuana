/**
 * Versioned eligibility criteria for Research OS studies.
 * Criteria belong to the researcher-authored protocol and never make an
 * eligibility decision by themselves.
 */
(function (root) {
    'use strict';

    const TEXT = Object.freeze({
        consent: {
            type: 'inclusion', parameter: false,
            es: ['Consentimiento informado', 'La persona acepta voluntariamente la versión vigente del consentimiento informado.'],
            en: ['Informed consent', 'The person voluntarily accepts the current version of the informed consent.'],
            ru: ['Информированное согласие', 'Участник добровольно принимает действующую версию информированного согласия.']
        },
        age_range: {
            type: 'inclusion', parameter: true,
            es: ['Rango de edad', 'La persona se encuentra en el rango de edad: {value}.'],
            en: ['Age range', 'The person is within the following age range: {value}.'],
            ru: ['Возрастной диапазон', 'Участник входит в возрастной диапазон: {value}.']
        },
        target_population: {
            type: 'inclusion', parameter: true,
            es: ['Población objetivo', 'La persona pertenece a la población objetivo: {value}.'],
            en: ['Target population', 'The person belongs to the target population: {value}.'],
            ru: ['Целевая популяция', 'Участник относится к целевой популяции: {value}.']
        },
        geography: {
            type: 'inclusion', parameter: true,
            es: ['Ubicación o residencia', 'La persona cumple el requisito geográfico: {value}.'],
            en: ['Location or residence', 'The person meets the geographic requirement: {value}.'],
            ru: ['Место проживания или нахождения', 'Участник соответствует географическому условию: {value}.']
        },
        language: {
            type: 'inclusion', parameter: true,
            es: ['Idioma del protocolo', 'La persona puede comprender y responder el protocolo en: {value}.'],
            en: ['Protocol language', 'The person can understand and answer the protocol in: {value}.'],
            ru: ['Язык протокола', 'Участник может понимать протокол и отвечать на языке: {value}.']
        },
        availability: {
            type: 'inclusion', parameter: true,
            es: ['Disponibilidad', 'La persona puede completar el calendario de participación: {value}.'],
            en: ['Availability', 'The person can complete the participation schedule: {value}.'],
            ru: ['Доступность для участия', 'Участник может пройти предусмотренный график: {value}.']
        },
        access_requirement: {
            type: 'inclusion', parameter: true,
            es: ['Acceso necesario', 'La persona dispone del acceso necesario para el procedimiento: {value}.'],
            en: ['Required access', 'The person has the access required for the procedure: {value}.'],
            ru: ['Необходимый доступ', 'У участника есть доступ, необходимый для процедуры: {value}.']
        },
        prior_exposure: {
            type: 'exclusion', parameter: true,
            es: ['Exposición previa', 'La persona tuvo una exposición previa que puede invalidar la medición: {value}.'],
            en: ['Prior exposure', 'The person had prior exposure that may invalidate the measurement: {value}.'],
            ru: ['Предшествующее знакомство', 'Участник ранее сталкивался с материалом или воздействием, способным исказить измерение: {value}.']
        },
        concurrent_conflict: {
            type: 'exclusion', parameter: true,
            es: ['Intervención concurrente', 'La persona participa en una intervención concurrente incompatible: {value}.'],
            en: ['Concurrent intervention', 'The person is participating in an incompatible concurrent intervention: {value}.'],
            ru: ['Параллельное вмешательство', 'Участник одновременно проходит несовместимое вмешательство: {value}.']
        },
        protocol_contraindication: {
            type: 'exclusion', parameter: true,
            es: ['Contraindicación definida', 'Se aplica la contraindicación específica definida en el protocolo: {value}.'],
            en: ['Defined contraindication', 'The specific protocol-defined contraindication applies: {value}.'],
            ru: ['Заданное противопоказание', 'Применимо конкретное, заранее заданное протоколом противопоказание: {value}.']
        }
    });

    const id = () => {
        if (root.crypto?.randomUUID) return root.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
    };
    const locale = lang => ['es', 'en', 'ru'].includes(lang) ? lang : 'es';
    const clean = value => String(value || '').trim();

    function catalog(lang) {
        const selected = locale(lang);
        return Object.entries(TEXT).map(([templateId, item]) => ({
            template_id: templateId,
            type: item.type,
            requires_parameter: item.parameter,
            title: item[selected][0]
        }));
    }

    function fromTemplate(templateId, parameter, lang) {
        const template = TEXT[templateId];
        if (!template) throw new Error('Unknown eligibility template');
        const selected = locale(lang);
        const value = clean(parameter);
        if (template.parameter && !value) throw new Error('A study-specific value is required');
        const render = text => text.replaceAll('{value}', value);
        return {
            criterion_id: id(),
            type: template.type,
            source: 'standard_template',
            template_id: templateId,
            statement: render(template[selected][1]),
            rationale: '',
            researcher_disposition: 'accepted'
        };
    }

    function normalizeCriterion(value, fallbackType) {
        const type = value?.type === 'exclusion' ? 'exclusion' : (fallbackType === 'exclusion' ? 'exclusion' : 'inclusion');
        const statement = clean(typeof value === 'string' ? value : value?.statement);
        if (!statement) return null;
        return {
            criterion_id: clean(value?.criterion_id) || id(),
            type,
            source: ['standard_template', 'researcher', 'ai_proposal'].includes(value?.source) ? value.source : 'researcher',
            template_id: clean(value?.template_id) || null,
            statement,
            rationale: clean(value?.rationale),
            uncertainty: clean(value?.uncertainty) || null,
            warning: clean(value?.warning) || null,
            researcher_disposition: 'accepted'
        };
    }

    function normalizeDesign(design) {
        const next = design || {};
        const structured = Array.isArray(next.eligibility_criteria)
            ? next.eligibility_criteria.map(item => normalizeCriterion(item, item?.type)).filter(Boolean)
            : [];
        const seen = new Set(structured.map(item => `${item.type}\u0000${item.statement}`));
        for (const type of ['inclusion', 'exclusion']) {
            const field = `${type}_criteria`;
            for (const statement of Array.isArray(next[field]) ? next[field] : []) {
                const key = `${type}\u0000${clean(statement)}`;
                if (!seen.has(key)) {
                    const item = normalizeCriterion({ type, statement, source: 'researcher' }, type);
                    if (item) structured.push(item);
                    seen.add(key);
                }
            }
        }
        next.eligibility_criteria = structured;
        synchronizeLegacy(next);
        if (!Array.isArray(next.eligibility_ai_reviews)) next.eligibility_ai_reviews = [];
        return next;
    }

    function synchronizeLegacy(design) {
        const rows = Array.isArray(design.eligibility_criteria) ? design.eligibility_criteria : [];
        design.inclusion_criteria = rows.filter(item => item.type === 'inclusion').map(item => item.statement);
        design.exclusion_criteria = rows.filter(item => item.type === 'exclusion').map(item => item.statement);
        return design;
    }

    function replaceFromLines(design, type, statements) {
        const retained = (design.eligibility_criteria || []).filter(item => item.type !== type);
        const previous = (design.eligibility_criteria || []).filter(item => item.type === type);
        const used = new Set();
        const replacements = statements.map((statement, index) => {
            let previousIndex = previous.findIndex((item, candidateIndex) =>
                !used.has(candidateIndex) && item.statement === statement
            );
            if (previousIndex < 0 && previous[index] && !used.has(index)) previousIndex = index;
            if (previousIndex < 0) previousIndex = previous.findIndex((_, candidateIndex) => !used.has(candidateIndex));
            if (previousIndex >= 0) {
                used.add(previousIndex);
                const item = previous[previousIndex];
                if (item.statement !== statement) item.researcher_modified = true;
                item.statement = statement;
                return item;
            }
            return normalizeCriterion({ type, statement, source: 'researcher' }, type);
        }).filter(Boolean);
        design.eligibility_criteria = [...retained, ...replacements];
        return synchronizeLegacy(design);
    }

    function scopedContext(study) {
        const design = study.study_design || {};
        return {
            protocol_language: study.primary_language || 'es-MX',
            study_title: clean(study.title),
            study_description: clean(study.description),
            design_type: clean(design.design_type),
            objective: clean(design.objective),
            research_questions: Array.isArray(design.research_questions) ? design.research_questions : [],
            hypotheses: Array.isArray(design.hypotheses) ? design.hypotheses : [],
            target_sample_size: design.target_sample_size ?? null,
            timepoint_count: Array.isArray(study.timepoints) ? study.timepoints.length : 0,
            group_descriptions: Array.isArray(study.groups) ? study.groups.map(group => ({
                title: clean(group.title), description: clean(group.description)
            })) : [],
            existing_criteria: (design.eligibility_criteria || []).map(item => ({
                type: item.type, statement: item.statement
            }))
        };
    }

    function normalizeAiResult(result) {
        if (!result || !Array.isArray(result.criteria)) throw new Error('AI response has no criteria array');
        const criteria = result.criteria.slice(0, 30).map(raw => {
            const normalized = normalizeCriterion({
                ...raw,
                criterion_id: id(),
                source: 'ai_proposal',
                researcher_disposition: 'pending'
            }, raw?.type);
            if (!normalized || !['inclusion', 'exclusion'].includes(raw?.type)) return null;
            normalized.researcher_disposition = 'pending';
            return normalized;
        }).filter(Boolean);
        if (!criteria.length) throw new Error('AI response contains no valid criteria');
        return {
            criteria,
            overall_warnings: Array.isArray(result.overall_warnings)
                ? result.overall_warnings.map(clean).filter(Boolean).slice(0, 20)
                : []
        };
    }

    root.EligibilityCriteria = Object.freeze({
        catalog,
        fromTemplate,
        normalizeDesign,
        normalizeCriterion,
        replaceFromLines,
        scopedContext,
        normalizeAiResult,
        synchronizeLegacy
    });
})(globalThis);
