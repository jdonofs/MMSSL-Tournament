# Peach Ice Garden tracking QA — 2026-09-02

## Capture health

- 72,617 frames over 1,384.847 seconds, zero missed frames.
- Position calibration confirmed `+0x004` from 8,950 possession locks; ball axes `x = +actor_x`,
  `z = -actor_z`. Live derivation confirmed at frame zero and withheld nothing.
- Fielder pointers never moved across the session.
- 94 plays emitted, 0 withheld; 5 immediate replay copies discarded; 107 pitches, 13 pitch-counter
  increments rejected as home-run replays.
- Live join tally at the last annotation: 90 joined, 0 pending, 0 ambiguous, 0 orphaned, 0
  mismatched. Zero warnings on all fifteen annotated plate appearances.
- The tracker .exe ended on a `KeyboardInterrupt` at the final-score screen — the operator's own
  stop, not a fault. Its final-score block printed "Mario Fireballs" for both teams.
- The archived-session replay reports one join mismatch at PA 17. It is a replay artifact, not a
  session fault: Blue Toad fouled off 0-0, swung through 0-1, and grounded out at 0-2, and the
  reconstructed log carries only the pitches the bat met, so the rebuilt at-bat cannot reach 0-2.
  The measured pitch stream has all three.

## Annotation review

| PA | Operator observation | QA result |
|---:|---|---|
| 4, 11, 22, 48, 58, 60 | Ball or throw broke a Freezie | No object signal; see the gimmick section |
| 9, 10, 23 | A buddy attack broke a Freezie | Buddy handoff is measured; the Freezie is not |
| 14, 26, 27, 68, 72 | A fielder was frozen by a Freezie | **All five are measured** — see below |
| 26 | Toadsworth bobbled after a freeze but the runner did not advance on it, so no error | Agreed and already scored that way |
| 38 | Koopa Troopa charged an error without touching the ball | **Confirmed defect**, below |

## Fixes established by this game

1. **A frozen fielder is measured, and stops corrupting the metrics.** `+0x240` on the fielder
   actor is captured, `play.freezes[]` and `frozen_frames` / `frozen_seconds` / `frozen_at_s`
   are emitted, and a frozen fielder's `reaction_s` and `route_efficiency` are withheld. The
   session's route-efficiency median moved from 0.959 to 0.971 and its reaction sample from
   570 to 552. Wario City re-derives byte-identical outside the new fields, with zero freezes.
2. **A bobble announced for a fielder who was not on the play is discarded.** See PA 38 below.
   Across this session's 19 bobble announcements the rule fires on four, all of them naming a
   fielder with no event and no approach on a play a different fielder demonstrably handled,
   and PA 38 is the only one that was charging an error.

## PA 38 — a false bobble charged an error

The tracker .exe announced `Koopa Troopa bobbled the ball!` and the play became `ROE` with
`L9-E9`, over the .exe's own closing line `Yellow Magikoopa recorded a double!`. The capture
contradicts it: the ball landed at (-49.3, -50.7) and was fielded at (-63.8, -59.6), and the only
fielding event on the play is Red Noki (LF) taking possession, `contact_source: possession_lock`,
confidence high. Koopa Troopa (RF) has no event of any kind.

The Wario City false-bobble rule does not reach this one. `trackerBobbleErrorVeto` filters
`play.fielding_events` down to the named fielder and returns null on an empty list, so a fielder
the capture places nowhere near the play is treated as *no evidence* rather than as evidence of
absence. Every Wario case had an event with `ball_contact: 'missed'` or `within_reach: false`.

The narrow extension, now in `trackerBobbleErrorVeto` as `not_on_the_play`: when the named
fielder has **no** fielding event and **no** catch approach, and the play has a confirmed
contact by a different fielder, the announcement is a false signal by the same argument as the
Wario five. Both halves matter. The confirmed contact by someone else is what makes this
evidence rather than silence — the capture is not failing to see the named fielder boot it, it
saw who handled the ball and it was somebody else — and the approach check keeps a fielder who
genuinely went after the ball and produced no event, which is exactly the failed attempt a
bobble might describe, from being cleared.

Koopa Troopa is no longer charged on PA 38; Red Noki, who actually handled the ball, still would
be. The play is a double again.

## Stadium gimmicks — the Freezie freeze is measurable

A fielder struct byte at **`+0x240`** is a Freezie freeze flag, with a frame countdown beside it:

| Offset | Behaviour |
|---|---|
| `+0x240` | 1 while frozen, 0 otherwise |
| `+0x20D` | counts 120 → 0 across the freeze, so the remaining freeze is readable on any frame |
| `+0x20F` | counts a further 60 frames after `+0x240` clears — the recovery animation |

A freeze is 120 frames, 2.000 s, then a 1 s recovery. It was found by mining every byte of the
748-byte fielder struct against the five labelled freezes and is not a fitted threshold.

**It fires only at Peach Ice Garden.** Six other sessions — Mario Stadium, Wario City, Luigi's
Mansion, DK Jungle, Bowser Jr. Playroom and Daisy Cruiser, 511,473 frames including labelled
manhole knockdowns, ghost attacks, flower gas, Chain Chomp hits and table stuns — produce zero
runs. The two Peach sessions produce 54. It is a Freezie, not a generic stun.

Within this session it fires 24 times: 19 inside a play window and 5 that are the replay copies
of three of those, which the derivation had already discarded as plays. All five labelled freezes
are among the 19. The other fourteen are on plays the operator did not annotate, and every one of
the 24 has the fielder immobile — 0.00 to 3.96 units of movement across two seconds against a
6.8 u/s session median — with `ball_was_hit` latched on every frame.

**It was corrupting the fielding metrics.** Route efficiency on the 18 frozen fielder-plays had
a median of 0.684 against 0.971 for the other 552. PA 72 read 0.2552 and PA 48 read 0.2218:
Toadsworth did not take a bad route, he was frozen on the way to the ball. This is the same class
of problem as game-glided motion — but unlike a glide it cannot be subtracted, because a freeze
adds no path length, it changes what the fielder was doing. Both numbers are therefore withheld
rather than adjusted, and `frozen_frames` says why.

### What is still missing, and why

The Freezie object itself is not in the captured region. Whatever froze a fielder is touching him
on the frame he freezes, so every 4-byte-aligned float triple in the 27,968-byte state block was
tested for proximity to the frozen fielder at all 24 onsets. No offset clears more than 10 of 24,
and those that come close are the ball echoed at a fielder holding it. The block holds the game
state and the thirteen actors; the stadium's own objects live outside it.

So of the four Peach day objectives, `freezie_player_freeze` is measured and
`freezie_ball_collision`, `freezie_break` and the near-miss control are not — a break has no
signal at all, and a ball-side deflection cannot be separated from the possession snaps that
dominate the 60 Hz ball track. The night objective, `snowflake_blackout`, is unattempted; this
was a day game.

**Detection is therefore not complete at Peach Ice Garden, and the completeness gate in
`docs/tracker-validation-console.md` stays closed.** What has changed is the reason: the barrier
is no longer "consequences cannot be attributed to a cause" but "the object table is outside the
capture window", which is an addressable problem. Widening the collector to a second region and
re-running the same adjacency search against these 24 known onsets is the test that would settle
it, and the same widening is what every other park's object identity needs.
