# Experimental WAR v1

Open **Stats → Experimental WAR** (also available in Season Stats). The Players
and Characters controls switch aggregation; the scope selector selects a
tournament, season, or career. Select a name for coverage details. The older
character-page estimate is explicitly labeled **Legacy WAR**.

Model version: `sluggers-fwar-experimental-v1`. This implements the published
FanGraphs framework with explicit Sluggers input substitutions. It is not an
exact reproduction of official MLB fWAR: proprietary MLB tracking inputs and
Sluggers park/leverage calibration are unavailable.

## Equations

Position WAR = (batting + baserunning + fielding + position + league + replacement
runs) / runs per win. Batting uses unrounded wOBA relative to the competition.
Position adjustments use actual defensive innings, with nine innings per
defensive game. The league adjustment centers runs above average at zero.
Replacement credit allocates 570 wins per 2,430 completed games by PA. Runs per
win = 1.5 × league RA9 + 3. These are the published
[FanGraphs position-player equations](https://library.fangraphs.com/war/war-position-players/).

Pitching uses 13×HR + 3×(BB+HBP) − 2×(K+IFFB), an event-specific constant on the
RA9 scale, dynamic pitcher runs per win, separate starter/reliever replacement
rates, and an innings-weighted correction to 430 wins per 2,430 completed games.
Starter and relief appearances are calculated separately. Zero-out appearances
retain their negative event value without dividing by zero. See the
[FanGraphs pitching equations](https://library.fangraphs.com/war/calculating-war-pitchers/).

Total experimental WAR = position WAR + pitching WAR. Actual innings remain
actual innings; a three-inning outing is not projected to nine innings. The MLB
game-based replacement budget is retained, so game length is an explicit
unvalidated assumption when comparing these values with MLB seasons.

## Inputs and substitutions

- Batting weights are pinned to the published **2025 MLB** constants: BB .691,
  HBP .722, 1B .882, 2B 1.252, 3B 1.584, HR 2.037; wOBA scale 1.232.
  The league average itself comes from the selected competition. Source:
  [FanGraphs Guts](https://www.fangraphs.com/tools/guts).
- Park factors and relief entry leverage are neutral at 1.0. There is one
  comparison league per competition, with no separate AL/NL adjustment.
- Pitching innings and HR/BB/K/runs come from stints; HBP and infield flies come
  from matching PAs. Without an explicit infield-fly flag, an FO with fly/pop
  trajectory and an infield location is a proxy. This is not a complete IFFB
  detector. Starter roles use the first recorded opposing PA in a game.
- Position exposure comes from PA outs and fielding spans. Overlapping or
  missing occupants are not guessed. Old result-based out counts and spans
  recorded only by inning are approximations.
- Extra-base, double-play, and fielding opportunities are modeled within each
  competition using the existing Sluggers models. Extra-base runs proxy UBR;
  negative DP opportunity value proxies batting double-play avoidance; OAA is
  converted using current Baseball Savant Fielding Run Value rates: 0.90 runs
  per out for outfield range and 0.75 for infield range. These are not MLB's
  proprietary measurements.
  Only individually attributed DP defense is credited to a character.
- Under current no-steal rules, stolen-base value is structurally zero.
  Other missing components stay null in the breakdown and contribute neutral
  values to the provisional total. A partial record is not complete calibration.

## Attribution and exclusions

Season game IDs are namespaced independently from tournament IDs. Opportunities
must match a PA in the same source and game. Unowned calibration exhibitions,
unfinished games, games without batting or pitching data, and games missing
required player/character identities or pitching totals are excluded.

Each competition is calculated independently on player/character pairs, then
summed into both leaderboards. Human and character totals reconcile because they
share the same credited performances. They must not be added together. Human
totals describe team control, not human skill isolated from character strength.
Career totals add event values rather than repricing all history in one pool.

## Validation and operation

`npm run test:war` verifies formulas, replacement budgets, position exposure,
zero-out pitching, source isolation, missing-data gates, and aggregation.
`npm run audit:war` reads the database and writes the local report
`data/calibration/experimental-war.json`; it performs no gameplay writes.

The September 5 read-only audit initially includes 22 completed games and 568
PAs. Player and character totals both reconcile to 9.0534979424 wins. All rows
are partial. Desktop/mobile browser checks cover both Stats routes, identity
switching, scope changes, sorting, and coverage details. Additional independent
calibration and held-out predictive validation remain future work.
