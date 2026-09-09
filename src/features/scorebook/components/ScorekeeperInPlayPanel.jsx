import FieldPlayBuilder from '../../../components/FieldPlayBuilder'
import BaserunnerField from '../../../components/BaserunnerField'
import { charactersHaveGoodChemistry } from '../../../utils/chemistryHighlights'
import { assembleErrorNotation } from '../../../utils/notation'
import {
  IN_PLAY_OUT_OPTIONS,
  hasAnyActiveRunners,
  isHomeRunResult,
} from '../../../utils/runnerAssignment'
import { canFinalizeInPlaySelection, effectiveErrorPositions } from '../domain/inPlay'
import { MiniRunnerDiamond } from './ScorebookPrimitives'
import { C } from './theme'

const IN_PLAY_HIT_OPTIONS = [
  { value: '1B', label: '1B' },
  { value: '2B', label: '2B' },
  { value: '3B', label: '3B' },
  { value: 'HR', label: 'HR' },
  { value: 'IPHR', label: 'IPHR' },
]
const IN_PLAY_RESULT_OPTIONS = [
  ...IN_PLAY_HIT_OPTIONS.map((option) => ({ ...option, resultType: 'hit', zone: 'green' })),
  ...IN_PLAY_OUT_OPTIONS.map((value) => ({ value, label: value, resultType: 'out', zone: 'red' })),
  { value: 'ROE', label: 'E', resultType: 'error', zone: 'blue' },
]
const BUDDY_JUMP_RESULTS = new Set(['FO', 'LO', 'SF'])
const TWO_OUT_DISABLED_RESULTS = new Set(['SF', 'SH'])
const TRAJECTORY_LABELS = {
  L: 'Line Drive',
  G: 'Ground Ball',
  F: 'Fly Ball',
  B: 'Fly Ball',
}
const ZONE_COLOR = { green: C.green, red: C.red, blue: C.blue }

function isOutcomeDisabledForOuts(result, outsInHalf = 0) {
  return outsInHalf >= 2 && TWO_OUT_DISABLED_RESULTS.has(result)
}

function isOutcomeDisabledForRunners(result, runners = {}) {
  return (result === 'SF' || result === 'SH' || result === 'DP') && !hasAnyActiveRunners(runners)
}

function buildInPlaySelectionSummary(state) {
  if (!state) return []
  const items = []
  if (state.resultType) items.push({ label: 'Play', value: state.resultType.toUpperCase() })
  if (state.result) items.push({ label: 'Result', value: state.result })
  if (state.trajectory) items.push({ label: 'Shape', value: `${state.trajectory} - ${TRAJECTORY_LABELS[state.trajectory] || state.trajectory}` })
  if (state.fielderChain?.length) {
    items.push({
      label: state.fielderChain.length > 1 ? 'Fielders' : 'Fielded By',
      value: state.fielderChain.join(' → '),
    })
  }
  return items
}

export default function ScorekeeperInPlayPanel({ visibility, play, actions, inPlayDetailsFooterRef }) {
  const { canEditScorebook, gameEndBanner, inPlayState, showOutsBanner } = visibility
  const {
    activeDefensiveFielders,
    buddyJumpAutoRobbedHr,
    buddyJumpEffectiveRobbedHr,
    charactersById,
    isStackedInPlayLayout,
    runnerPlacementPreview,
    runnerPlan,
    runners,
    selectionOutsInHalf,
    stadiumKey,
  } = play
  const {
    cancelInPlaySelection,
    finalizeInPlay,
    handleRunnerSetPosition,
    setInPlayState,
  } = actions

  return (
    <>
    {canEditScorebook && inPlayState && !showOutsBanner && !gameEndBanner && (
      <div style={{ background: 'rgba(15,23,42,0.98)', border: `1px solid ${C.border}`, borderRadius: 18, padding: 14, marginBottom: 10 }}>
        {buildInPlaySelectionSummary(inPlayState).length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {buildInPlaySelectionSummary(inPlayState).map((item) => (
              <div key={item.label} style={{ padding: '7px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}DD` }}>
                <span style={{ color: C.muted, fontSize: 10, fontWeight: 800, textTransform: 'uppercase' }}>{item.label}</span>
                <span style={{ marginLeft: 6, color: C.text, fontSize: 12, fontWeight: 700 }}>{item.value}</span>
              </div>
            ))}
          </div>
        )}
        {inPlayState.stage === 'result' && (
          <>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>Ball In Play — Result</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {IN_PLAY_RESULT_OPTIONS.map((option) => {
                const color = ZONE_COLOR[option.zone]
                const disabledForOuts = isOutcomeDisabledForOuts(option.value, selectionOutsInHalf)
                const disabledForRunners = isOutcomeDisabledForRunners(option.value, runners)
                const disabled = disabledForOuts || disabledForRunners
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={disabled}
                    title={disabled ? (disabledForOuts ? `${option.label} is not available with two outs.` : `${option.label} requires a runner on base.`) : undefined}
                    onClick={() => {
                      if (disabled) return
                      const nextState = {
                        ...inPlayState,
                        stage: 'details',
                        resultType: option.resultType,
                        result: option.value,
                        trajectory: option.value === 'GO' ? 'G' : option.value === 'LO' ? 'L' : option.value === 'FO' ? 'F' : null,
                        isBuddyJump: false,
                        robbedHrOverride: null,
                        fielderChain: [],
                        manualRunnerPositions: {},
                        errorMode: false,
                        errorFielderPositions: [],
                        nicePlay: false,
                      }
                      // A ball hit clean over the fence has no fielders to
                      // mark and nothing left to configure — confirm it
                      // immediately instead of landing on an empty details
                      // screen. An inside-the-park HR is a real fielded
                      // play (relay, missed catch, etc.), so it still goes
                      // through fielder selection like any other hit.
                      if (option.value === 'HR') {
                        finalizeInPlay(nextState)
                        return
                      }
                      setInPlayState(nextState)
                    }}
                    style={{
                      minHeight: 64,
                      borderRadius: 16,
                      border: `1px solid ${disabled ? `${C.border}99` : color}`,
                      background: disabled ? 'rgba(148,163,184,0.12)' : `${color}22`,
                      color: disabled ? C.muted : color,
                      fontWeight: 800,
                      fontSize: 15,
                      opacity: disabled ? 0.5 : 1,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <button type="button" onClick={cancelInPlaySelection} style={{ width: '100%', minHeight: 56, marginTop: 10, borderRadius: 14, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700, fontSize: 14 }}>BACK</button>
          </>
        )}
        {inPlayState.stage === 'details' && (
          <div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: !isHomeRunResult(inPlayState.result) && !isStackedInPlayLayout
                ? 'minmax(320px, 420px) minmax(320px, 640px) minmax(320px, 420px)'
                : '1fr',
              gap: 16,
              alignItems: 'flex-start',
              justifyContent: 'center',
            }}>
              {!isHomeRunResult(inPlayState.result) && !isStackedInPlayLayout ? (
                runnerPlacementPreview ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em' }}>Preview</div>
                    <MiniRunnerDiamond runners={runnerPlacementPreview} charactersById={charactersById} size={120} />
                  </div>
                ) : <div aria-hidden="true" />
              ) : null}
              <div style={{ minWidth: 0, width: '100%', maxWidth: 640, justifySelf: 'center' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setInPlayState((current) => ({ ...current, nicePlay: !current.nicePlay }))}
                      title="Marks the first fielder to touch the ball as having made a diving/great catch"
                      style={{
                        width: 108,
                        minHeight: 40,
                        padding: '0 12px',
                        borderRadius: 12,
                        border: `1px solid ${inPlayState.nicePlay ? C.accent : C.border}`,
                        background: inPlayState.nicePlay ? `${C.accent}33` : C.card,
                        color: inPlayState.nicePlay ? C.accent : C.muted,
                        fontWeight: 900,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {inPlayState.nicePlay ? 'NICE PLAY ON' : 'NICE PLAY'}
                    </button>
                    {BUDDY_JUMP_RESULTS.has(inPlayState.result) && (
                      <button
                        type="button"
                        onClick={() => setInPlayState((current) => ({
                          ...current,
                          isBuddyJump: !current.isBuddyJump,
                          robbedHrOverride: null,
                        }))}
                        title="Marks this catch as a Buddy Jump; tap the assisting fielder first, then the fielder who made the catch"
                        style={{
                          width: 108,
                          minHeight: 40,
                          padding: '0 12px',
                          borderRadius: 12,
                          border: `1px solid ${inPlayState.isBuddyJump ? C.accent : C.border}`,
                          background: inPlayState.isBuddyJump ? `${C.accent}33` : C.card,
                          color: inPlayState.isBuddyJump ? C.accent : C.muted,
                          fontWeight: 900,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {inPlayState.isBuddyJump ? 'BJ ON' : 'BJ'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setInPlayState((current) => ({ ...current, errorMode: !current.errorMode }))}
                      title="While on, tapping a fielder charges them with an error on this play — stays on across multiple taps"
                      style={{
                        width: 108,
                        minHeight: 40,
                        padding: '0 12px',
                        borderRadius: 12,
                        border: `1px solid ${inPlayState.errorMode ? C.red : C.border}`,
                        background: inPlayState.errorMode ? `${C.red}33` : C.card,
                        color: inPlayState.errorMode ? C.red : C.muted,
                        fontWeight: 900,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {inPlayState.errorMode ? 'ERROR ON' : 'ERROR'}
                    </button>
                    {inPlayState.isBuddyJump && (
                      <button
                        type="button"
                        onClick={() => setInPlayState((current) => ({ ...current, robbedHrOverride: !buddyJumpEffectiveRobbedHr }))}
                        title="Whether this Buddy Jump catch robbed a home run at the wall — auto-estimated from the catch spot, tap to correct if it's wrong"
                        style={{
                          width: 108,
                          minHeight: 40,
                          padding: '0 12px',
                          borderRadius: 12,
                          border: `1px solid ${buddyJumpEffectiveRobbedHr ? C.accent : C.border}`,
                          background: buddyJumpEffectiveRobbedHr ? `${C.accent}33` : C.card,
                          color: buddyJumpEffectiveRobbedHr ? C.accent : C.muted,
                          fontWeight: 900,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {buddyJumpEffectiveRobbedHr ? 'HR ROB ON' : 'HR ROB'}
                      </button>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FieldPlayBuilder
                      fieldersByPosition={activeDefensiveFielders}
                      fielderChain={inPlayState.fielderChain || []}
                      onToggleFielder={(position) => setInPlayState((current) => {
                        const chain = current.fielderChain || []
                        // The same fielder can appear more than once in the chain
                        // (e.g. a 3-4-3 double play), just never twice in a row —
                        // tapping whoever was just tapped is a no-op instead of a
                        // second consecutive touch. Removing a fielder is now a
                        // right-click (see onFielderContextMenu below), so a left
                        // tap always adds another touch rather than toggling one
                        // off.
                        if (chain[chain.length - 1] === position) return current
                        const nextChain = [...chain, position]
                        // Error mode stays on across multiple taps, so every
                        // fielder tapped while it's active gets stacked onto the
                        // same play's error credit rather than replacing whoever
                        // was tapped before them.
                        if (current.errorMode) {
                          const errors = current.errorFielderPositions || []
                          return { ...current, fielderChain: nextChain, errorFielderPositions: errors.includes(position) ? errors : [...errors, position] }
                        }
                        return { ...current, fielderChain: nextChain }
                      })}
                      onFielderContextMenu={(position) => setInPlayState((current) => {
                        const chain = current.fielderChain || []
                        const idx = chain.lastIndexOf(position)
                        if (idx === -1) return current
                        const nextChain = [...chain.slice(0, idx), ...chain.slice(idx + 1)]
                        const errors = (current.errorFielderPositions || []).filter((p) => p !== position)
                        return { ...current, fielderChain: nextChain, errorFielderPositions: errors }
                      })}
                      notation={inPlayState.fielderChain?.length
                        ? assembleErrorNotation(inPlayState.trajectory, inPlayState.fielderChain, effectiveErrorPositions(inPlayState))
                        : ''}
                      accent={C.accent}
                      label={inPlayState.isBuddyJump ? 'Tap Assist, Then The Catch' : inPlayState.result === 'IPHR' ? 'Who Touched The Ball? (Inside-The-Park HR)' : 'Who Touched The Ball?'}
                      stadiumKey={stadiumKey}
                    />
                    {inPlayState.isBuddyJump && (
                      <div style={{ marginTop: 8, fontSize: 11, color: C.muted, textAlign: 'center' }}>
                        Buddy Jump — 1st fielder tapped gets the assist, 2nd gets the putout. Both need good chemistry together.
                        {inPlayState.fielderChain?.length >= 2 && !canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders, charactersHaveGoodChemistry) && (
                          <div style={{ color: C.red, marginTop: 4, fontWeight: 700 }}>These two don't have chemistry together.</div>
                        )}
                        <div style={{ marginTop: 4 }}>
                          {inPlayState.robbedHrOverride == null
                            ? `HR ROB ${buddyJumpAutoRobbedHr ? 'auto-detected' : 'not detected'} from the catch spot — tap HR ROB to correct it.`
                            : `HR ROB set manually (${buddyJumpEffectiveRobbedHr ? 'on' : 'off'}).`}
                        </div>
                      </div>
                    )}
                    {Boolean(inPlayState.errorFielderPositions?.length) && (
                      <div style={{ marginTop: 8, fontSize: 11, color: C.red, textAlign: 'center', fontWeight: 700 }}>
                        E — {inPlayState.errorFielderPositions.map((position) => activeDefensiveFielders[position]?.character || 'fielder').join(', ')}
                      </div>
                    )}
                    {inPlayState.nicePlay && inPlayState.fielderChain?.[0] && (
                      <div style={{ marginTop: 8, fontSize: 11, color: C.accent, textAlign: 'center', fontWeight: 700 }}>
                        ★ Nice play by {activeDefensiveFielders[inPlayState.fielderChain[0]]?.character || 'fielder'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {!isHomeRunResult(inPlayState.result) && (
                <div style={{
                  minWidth: 0,
                  width: '100%',
                  maxWidth: isStackedInPlayLayout ? undefined : 420,
                  justifySelf: 'stretch',
                  marginTop: isStackedInPlayLayout ? 16 : 0,
                  paddingTop: isStackedInPlayLayout ? 16 : 0,
                  borderTop: isStackedInPlayLayout ? `1px solid ${C.border}` : 'none',
                }}>
                  <BaserunnerField
                    entries={runnerPlan}
                    charactersById={charactersById}
                    onSetPosition={handleRunnerSetPosition}
                    accent={C.accent}
                  />
                </div>
              )}
            </div>
            <div ref={inPlayDetailsFooterRef} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setInPlayState((current) => ({ ...current, stage: 'result', resultType: null, result: null, trajectory: null, fielderChain: [], manualRunnerPositions: {}, errorMode: false, errorFielderPositions: [], nicePlay: false, isBuddyJump: false, robbedHrOverride: null }))} style={{ flex: 1, minHeight: 56, borderRadius: 14, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700, fontSize: 14 }}>BACK</button>
              <button type="button" disabled={!canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders, charactersHaveGoodChemistry)} onClick={() => finalizeInPlay(inPlayState)} style={{ flex: 1, minHeight: 56, borderRadius: 14, border: `1px solid ${C.accent}`, background: `${C.accent}22`, color: C.accent, fontWeight: 800, fontSize: 15, opacity: !canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders, charactersHaveGoodChemistry) ? 0.5 : 1 }}>CONFIRM</button>
            </div>
          </div>
        )}
      </div>
    )}
    </>
  )
}
