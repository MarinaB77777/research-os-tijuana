-- Research OS exact translation-package loading v3.
-- Apply after question_translation_integrity_v2.sql.
-- A language variant is loaded from one immutable accepted package only;
-- question definitions and translated document metadata cannot be mixed
-- across different translation versions.

begin;

create index if not exists question_translation_variants_package_lookup
    on public.question_translation_variants(translation_package_id);

create or replace function public.load_exact_question_translation_package(
    p_researcher_account_id uuid,
    p_translation_package_id uuid,
    p_source_schema text,
    p_source_entity_id uuid,
    p_source_version integer,
    p_target_language text,
    p_translation_version integer
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'translation_package_id', tp.translation_package_id,
        'source_schema', tp.source_schema,
        'source_entity_id', tp.source_entity_id,
        'source_version', tp.source_version,
        'source_primary_language', tp.source_primary_language,
        'target_language', tp.target_language,
        'translation_version', tp.translation_version,
        'source_sha256', tp.source_sha256,
        'accepted_at', tp.accepted_at,
        'verification_status', tp.verification_status,
        'language_verification', tp.language_verification,
        'translated_document', tp.translated_document,
        'translations', coalesce((
            select jsonb_object_agg(
                qt.question_id::text || ':' || qt.question_version::text,
                jsonb_build_object(
                    'translated_definition', qt.translated_definition,
                    'translation_reference', jsonb_build_object(
                        'translation_package_id', tp.translation_package_id,
                        'translation_version', qt.translation_version,
                        'package_translation_version', tp.translation_version,
                        'source_primary_language', tp.source_primary_language,
                        'target_language', tp.target_language,
                        'source_sha256', tp.source_sha256,
                        'accepted_at', tp.accepted_at,
                        'human_disposition', 'accepted',
                        'verification_status', tp.verification_status,
                        'language_verification', tp.language_verification
                    )
                )
            )
              from public.question_translation_variants qt
             where qt.translation_package_id = tp.translation_package_id
               and qt.researcher_account_id = p_researcher_account_id
        ), '{}'::jsonb)
    )
      from public.question_translation_packages tp
     where tp.translation_package_id = p_translation_package_id
       and tp.researcher_account_id = p_researcher_account_id
       and tp.source_schema = p_source_schema
       and tp.source_entity_id = p_source_entity_id
       and tp.source_version = p_source_version
       and lower(tp.target_language) = lower(p_target_language)
       and tp.translation_version = p_translation_version
       and tp.verification_status = 'verified';
$$;

revoke all on function public.load_exact_question_translation_package(
    uuid, uuid, text, uuid, integer, text, integer
) from public, anon, authenticated;

grant execute on function public.load_exact_question_translation_package(
    uuid, uuid, text, uuid, integer, text, integer
) to service_role;

commit;
