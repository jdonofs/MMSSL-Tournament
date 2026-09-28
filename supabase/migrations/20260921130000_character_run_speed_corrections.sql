-- Dry Bones and Green Paratroopa hold a `run_speed` the game contradicts.
--
-- NOT YET APPLIED. This file is prepared for review; nothing in this change set
-- has run it against any database. Apply it deliberately, like every other
-- migration here, and re-run the audit afterwards.
--
-- ─── The evidence ──────────────────────────────────────────────────────────
--
-- Three independent sources agree, and only `public.characters` dissents:
--
--   1. THE GAME'S OWN CONSTANT. The fielder actor holds its top speed at
--      +0x0F0 (max_speed/15 per frame). Across 58 archived sessions Dry Bones
--      holds 7.792 u/s and Green Paratroopa 7.840 u/s, on every play, in every
--      session. These are constants, not measurements: they do not vary with
--      effort, park or opponent.
--
--   2. THE PUBLISHED FIELD-SPEED CURVE. Those two values are the curve rows for
--      run_speed 50 and 52 exactly (0.130 and 0.1308 u/frame at 59.94 fps).
--      The values the current column implies -- 40 and 64 -- are 7.732 and
--      8.064 u/s, and neither was ever observed for either character.
--
--   3. THE DATA-MINED TALENT PROFILE. src/data/characterTalentProfiles.json
--      gives `dry bones` runSpeed 50 and `green koopa paratroopa` runSpeed 52,
--      matching the game. Its sibling rows corroborate: Blue Dry Bones and
--      Dark Bones are both 50, and ordinary Paratroopa is 52.
--
-- Reproduce the whole comparison, read only, with
--   node scripts/audit_character_mechanics.mjs
-- under "characters matching neither row".
--
-- ─── What changes, and what does not ───────────────────────────────────────
--
-- MEASURED, NOT ASSUMED. An earlier version of this note said the correction
-- reaches only the verifier and the audit. That was incomplete. Reproduce the
-- whole inventory and the before/after, read only, with
--   node scripts/analyze_run_speed_correction_impact.mjs
--
-- THE CONSUMER THAT CAN CHANGE A STORED NUMBER.
-- scripts/recompute_advanced_metrics.mjs reads this column straight into
-- extraBaseFeatures as `runnerSpeed`, and `runner_speed` is one of the four
-- inputs of the ACTIVE extra-base decision model
-- (data/calibration/runner-decision-model-v1.json). A recompute therefore CAN
-- move expected_attempt_probability, and with it runner_run_value,
-- arm_run_value, and any WAR built on those.
--
-- On the data that exists on 2026-09-21 it moves none of them:
--
--   runner_opportunities rows                     17
--   ...scored by the fitted model                 13
--   ...with either corrected character as runner   0
--   rows whose modelled values change              0
--   runner/arm run value moved                     0.000000
--   downstream WAR                                 0, exactly: WAR sums these
--     two run values and divides by a positive runsPerWin.
--
-- Neither character has appeared as a baserunner in a tracked opportunity yet.
-- That is a fact about today's data and not about the model, and it will stop
-- being true the first time one of them runs the bases in a tracked game. The
-- same script reports the model's SENSITIVITY separately, from today's rows
-- with the runner swapped: Dry Bones 40 -> 50 moves P(send) by a mean +0.017
-- (range +0.000 to +0.045) and Green Paratroopa 64 -> 52 by a mean -0.021
-- (range -0.052 to -0.001). Those are what the correction WOULD be worth, not
-- what it is worth now.
--
-- NOTHING STORED CHANGES UNTIL A RECOMPUTE RUNS. The app reads the persisted
-- columns; applying this file alone moves no displayed number at all.
--
-- THE REPORTING CONSUMERS.
--   * scripts/verify_speed_against_attributes.mjs correlates measured speeds
--     against this column. Recomputed both ways over the local archive:
--       fielder sprint speed vs run_speed        0.9721 -> 0.9761
--       runner sprint speed  vs run_speed        0.8636 -> 0.8756
--       throw velocity       vs throwing_speed   0.8712 -> 0.8712 (unchanged,
--         and it must be: this file does not touch throwing_speed)
--     No gate flips; the thresholds are 0.8 / 0.6 / 0.8.
--   * scripts/audit_character_mechanics.mjs will report 55 of 55 characters
--     reproducing the curve instead of 53, and the two exception lines go away.
--
-- THE MODEL FIT ITSELF. scripts/calibrate_runner_decisions.mjs reads the same
-- column for its own fit over the local archive, where Dry Bones has 16 runner
-- windows and Green Paratroopa 22. Re-running it after this correction would
-- move the fitted ARTIFACT. It is not run by the recompute and applying this
-- file does not run it.
--
-- THE APP'S OWN DISPLAY. resolveCharacterRunSpeed() in
-- src/utils/characterAnalysis.js already prefers the talent profile, which
-- gives both characters the corrected value today, so the scouting report, the
-- derived ratings and the measured/expected top-speed comparison are already
-- built from 50 and 52. This removes the disagreement at the source rather
-- than changing those answers. A character with NO talent profile would newly
-- fall back to a corrected column; both of these have profiles, so that is nil.
--
-- ─── Verified locally ──────────────────────────────────────────────────────
--
-- tests/character-run-speed-migration.test.mjs applies THIS FILE to a fresh
-- PostgreSQL (PGlite, in process) and covers the apply, a repeat apply, the
-- refusal on an unexpected prior value, the duplicate-name guard, and the
-- rollback -- including that submitting the file as one multi-statement query
-- makes it a single implicit transaction, so a post-condition failure undoes
-- the corrections too. Apply it inside an explicit begin/commit anyway, as
-- every other migration here is applied, so the guarantee does not depend on
-- how the runner splits the file.
--
-- ─── Safety ────────────────────────────────────────────────────────────────
--
-- Each update names its target by NAME and checks the PRIOR value, so it
-- cannot touch a row that has already been corrected, cannot match a
-- similarly-named character (Blue Dry Bones, Dark Bones, Green Dry Bones and
-- ordinary Paratroopa are all distinct rows and all already correct), and
-- raises rather than silently doing nothing if the data is not what this file
-- was written against.

do $$
declare
  updated integer;
  corrections constant jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Dry Bones',        'from', 40, 'to', 50),
    jsonb_build_object('name', 'Green Paratroopa', 'from', 64, 'to', 52)
  );
  correction jsonb;
begin
  for correction in select * from jsonb_array_elements(corrections) loop
    update public.characters
       set run_speed = (correction->>'to')::integer
     where name = (correction->>'name')
       and run_speed = (correction->>'from')::integer;

    get diagnostics updated = row_count;

    if updated = 0 then
      -- Either already applied, or the row does not look the way this file
      -- expects. Both are reasons to stop and look rather than to continue.
      if exists (
        select 1 from public.characters
         where name = (correction->>'name')
           and run_speed = (correction->>'to')::integer
      ) then
        raise notice '% already holds run_speed %, nothing to do',
          correction->>'name', correction->>'to';
      else
        raise exception
          'refusing to correct %: expected run_speed % and found %',
          correction->>'name',
          correction->>'from',
          (select run_speed::text from public.characters where name = correction->>'name');
      end if;
    elsif updated > 1 then
      raise exception 'correction for % matched % rows; names must be unique here',
        correction->>'name', updated;
    else
      raise notice 'corrected % from % to %',
        correction->>'name', correction->>'from', correction->>'to';
    end if;
  end loop;
end $$;

-- Post-condition, in the migration rather than in a follow-up note: the two
-- rows now hold what the game holds, and their similarly-named siblings were
-- not touched.
do $$
begin
  if not exists (select 1 from public.characters where name = 'Dry Bones' and run_speed = 50)
     or not exists (select 1 from public.characters where name = 'Green Paratroopa' and run_speed = 52)
     or not exists (select 1 from public.characters where name = 'Paratroopa' and run_speed = 52)
     or not exists (select 1 from public.characters where name = 'Blue Dry Bones' and run_speed = 50)
  then
    raise exception 'post-condition failed: run_speed corrections did not land as expected';
  end if;
end $$;
