// Plain-English descriptions for stat abbreviations that aren't self-explanatory from their
// name alone (BABIP, wOBA, etc.). Simple counting stats (H, HR, RBI, W, SV...) are intentionally
// left out — surfacing a tooltip for "HR" would just be noise. Keyed by the exact column label
// text as it's rendered in table headers across the app, so this list doubles as an inventory of
// every advanced stat header currently in use.
export const STAT_DESCRIPTIONS = {
  'Exp. WAR': 'Experimental combined value: position-player WAR plus pitching WAR using the FanGraphs framework. Missing inputs are neutral assumptions; inspect coverage.',
  'Position WAR': 'Batting, baserunning, fielding, position, league, and replacement runs divided by runs per win. Includes batting value earned by pitchers.',
  'Pitching WAR': 'FanGraphs-style pitching value from home runs, walks, hit batters, strikeouts, and infield flies, with replacement and league corrections.',
  'Legacy WAR': 'Older simplified batting/fielding estimate with fixed constants and no pitching component. Use Experimental WAR in Stats for the combined version.',
  'Bat Runs': 'Weighted batting runs above the competition average using published 2025 MLB weights and wOBA scale.',
  BsR: 'Experimental baserunning runs from extra-base opportunities and double-play avoidance. A dash means unmeasured.',
  'Fld Runs': 'Experimental fielding runs from tracked outs above average, arm outcomes, and attributed double plays.',
  'Pos Adj': 'FanGraphs positional run adjustment, prorated by recorded defensive innings at each position.',
  'Lg Adj': 'League correction that centers position-player runs above average at zero.',
  'Repl Runs': 'Position-player replacement credit allocated by plate appearances using the MLB replacement budget.',
  // Rate/slash stats
  AVG: 'Batting average: hits divided by at-bats.',
  OBP: 'On-base percentage: how often a batter reaches base via hit, walk, or hit-by-pitch.',
  SLG: 'Slugging percentage: total bases divided by at-bats.',
  OPS: 'On-base plus slugging: OBP + SLG combined into one number.',
  'OPS+': 'OPS adjusted to league average, where 100 is average and higher is better.',
  ISO: 'Isolated power: SLG minus AVG, measuring extra-base power on its own.',
  BABIP: 'Batting average on balls in play, excluding strikeouts and home runs.',
  'BABIP Allowed': 'Batting average allowed on balls in play, excluding strikeouts and home runs.',
  wOBA: 'Weighted on-base average: values every offensive outcome (walk, single, homer, etc.) by how much it actually contributes to scoring runs.',
  xwOBA: 'Expected wOBA based on quality of contact (exit velocity, launch angle) rather than actual results.',
  'wRC+': 'Weighted runs created, adjusted to league average, where 100 is average and higher is better.',
  RC: 'Runs Created: an estimate of how many runs a player generated with their offense.',
  'RC/3': 'Runs Created per 3-inning game (9 outs).',
  xBA: 'Expected batting average based on quality of contact rather than actual results.',
  xSLG: 'Expected slugging percentage based on quality of contact rather than actual results.',

  // Rate stats — plate discipline
  'K%': 'Strikeouts divided by plate appearances.',
  'BB%': 'Walks divided by plate appearances.',
  'BB/K': 'Walk-to-strikeout ratio.',
  'K/BB': 'Strikeout-to-walk ratio.',
  'XBH%': 'Extra-base hits (2B, 3B, HR) divided by hits.',
  'HR/PA': 'Home runs divided by plate appearances.',
  'P/PA': 'Average pitches seen per plate appearance.',
  'Whiff%': 'Percentage of swings that missed the ball entirely.',
  'Foul%': 'Percentage of pitches fouled off.',
  'KS%': 'Percentage of strikeouts that were swinging (as opposed to looking).',
  'KL%': 'Percentage of strikeouts that were looking (as opposed to swinging).',

  // Pitching rate stats
  'ERA/3': 'Earned Run Average per 3-inning game (9 outs).',
  FIP: 'Fielding Independent Pitching: estimates ERA using only outcomes a pitcher directly controls (K, BB, HR), scaled to the 3-inning environment.',
  'FIP-': 'FIP relative to league average, where lower than 100 is better.',
  'ERA-': 'ERA/3 relative to league average, where lower than 100 is better.',
  WHIP: 'Walks plus hits allowed, per inning pitched.',
  'K/3': 'Strikeouts per 3-inning game (9 outs).',
  'BB/3': 'Walks per 3-inning game (9 outs).',
  'H/3': 'Hits allowed per 3-inning game (9 outs).',
  'HR/3': 'Home runs allowed per 3-inning game (9 outs).',
  'Star Pitch %': 'Percentage of pitches thrown that were the pitcher\'s Star Pitch.',
  'Strike %': 'Percentage of pitches thrown for a strike.',
  '1st Str %': 'Percentage of plate appearances that started with a first-pitch strike.',
  'Avg Velo': 'Average measured pitch velocity across pitches with a complete tracked flight.',
  'Max Velo': 'Fastest measured pitch velocity across pitches with a complete tracked flight.',
  'Tracked %': 'Percentage of recorded pitches with a complete velocity and movement measurement.',
  'Allowed LD%': 'Percentage of batted balls allowed that were line drives.',
  'Allowed Pull%': 'Percentage of batted balls allowed that were pulled by the batter.',

  // Batted-ball / contact quality
  'LD%': 'Percentage of batted balls that were line drives.',
  'GB%': 'Percentage of batted balls that were ground balls.',
  'FB%': 'Percentage of batted balls that were fly balls.',
  'Pull%': 'Percentage of batted balls hit to the batter\'s pull side.',
  'Center%': 'Percentage of batted balls hit up the middle.',
  'Oppo%': 'Percentage of batted balls hit to the opposite field.',
  'Avg EV': 'Average exit velocity of batted balls.',
  'Max EV': 'Highest exit velocity recorded on a batted ball.',
  'Avg EV Allowed': 'Average exit velocity allowed on batted balls.',
  'Avg LA': 'Average launch angle of batted balls off the bat.',
  'Avg Dist': 'Average distance traveled on batted balls.',
  'Avg/Max Dist': 'Average and max distance traveled on batted balls.',
  'Avg Distance': 'Average distance traveled on batted balls.',
  Longest: 'Longest batted ball distance recorded.',
  'Barrel%': 'Percentage of batted balls hit with the ideal combination of exit velocity and launch angle for extra-base damage.',
  'Barrel% Allowed': 'Percentage of batted balls allowed that were "barreled" — the ideal combination of exit velocity and launch angle.',
  'Hard-Hit%': 'Percentage of batted balls hit at 95+ mph exit velocity.',
  'Hard-Hit% Allowed': 'Percentage of batted balls allowed hit at 95+ mph exit velocity.',
  'Hard-Hit% (Dist)': 'Percentage of batted balls classified as hard-hit based on distance.',
  'Hard-Hit% (EV)': 'Percentage of batted balls classified as hard-hit based on exit velocity.',
  'Sweet-Spot%': 'Percentage of batted balls hit with a launch angle in the optimal 8-32° range.',
  'Park-Adj Dist': 'Average batted-ball distance adjusted for the stadium(s) it was hit in.',
  'Power Index': 'A composite score blending exit velocity and distance into a single power rating.',
  'Spray Angle': 'Average horizontal angle of batted balls, showing pull/oppo tendency.',
  'Pull EV': 'Average exit velocity on batted balls pulled by the batter.',
  'Oppo EV': 'Average exit velocity on batted balls hit the opposite way.',
  'Pull SLG': 'Slugging percentage on batted balls pulled by the batter.',
  'Oppo SLG': 'Slugging percentage on batted balls hit the opposite way.',
  'GB BABIP': 'Batting average on balls in play that were ground balls.',
  'LD BABIP': 'Batting average on balls in play that were line drives.',
  'FB BABIP': 'Batting average on balls in play that were fly balls.',
  'LD wOBA': 'wOBA generated on line drives only.',
  'FB wOBA': 'wOBA generated on fly balls only.',
  BIP: 'Balls in play: batted balls that weren\'t a strikeout, walk, or home run.',

  // Fielding
  'FLD%': 'Fielding percentage: plays made cleanly (putouts + assists) divided by total chances.',
  'Fielding %': 'Fielding percentage: plays made cleanly (putouts + assists) divided by total chances.',
  BJ: 'Buddy Jumps: assisted catches made with help from a teammate.',
  NP: 'Nice Plays: standout defensive plays beyond a routine catch.',
  'NP%': 'Nice Plays divided by total fielding chances.',
  'Nice Play %': 'Nice Plays divided by total fielding chances.',
  'Range Factor': 'Putouts plus assists per game, a raw measure of defensive range.',
  DER: 'Defensive Efficiency Ratio: the share of fieldable balls in play on which the team recorded an out.',
  RngR: 'Range Runs: estimated runs saved (or cost) by a fielder\'s range compared to an average fielder at that position.',
  'Range Runs': 'Estimated runs saved (or cost) by a fielder\'s range compared to an average fielder at that position.',
  'Range+': 'Range Factor scaled to league average, where 100 is average and higher is better.',
  'Rng Conf': 'Range Confidence: how reliable the range rating is, based on sample size.',
  Confidence: 'How reliable this range rating is, based on sample size.',
  'Actual Outs': 'Outs actually recorded on balls hit into this fielder\'s zone.',
  'Expected Outs': 'Outs a league-average fielder would be expected to record on the same balls in play.',
  OAA: 'Outs Above Average: actual outs minus the outs an average fielder would be expected to make on the same tracked opportunities.',
  FRV: 'Fielding Run Value: estimated runs saved above average from range, throwing, and double-play conversion.',
  'Arm Strength': 'Average velocity of a fielder\'s hardest tracked throws, using a position-specific top-throw sample. Buddy Throws are excluded, because their speed comes from a chemistry pairing rather than from one arm.',
  'Max Throw': 'Fastest tracked throw by a single fielder.',
  'Max Buddy': 'Fastest tracked Buddy Throw started by this fielder — two chemistry-linked fielders combining, where the first bounces the ball to the second, who fires it in. They run roughly twice the speed of an ordinary throw, and the partner who actually releases the ball is not identifiable from the tracking capture, so they are kept out of Arm Strength.',
  'Arm Value': 'Estimated runs saved by holding or throwing out runners compared with the league expectation for the same opportunity.',
  Holds: 'Extra-base opportunities where a runner did not attempt the additional base.',
  'Runner Outs': 'Runners thrown out while attempting an additional base.',
  'DP Opp': 'Eligible ground-ball double-play opportunities with fewer than two outs and a runner on first.',
  'DP Added': 'Double plays completed above or below the league expectation for the same opportunity context.',
  Jump: 'Average distance covered in the first three seconds after tracked contact, including reaction, burst, and route components.',
  Depth: 'Average distance from home plate at pitch release on tracked balls in play.',
  Angle: 'Average horizontal positioning angle from straightaway center field at pitch release.',
  'Back-L OAA': 'Outs Above Average on tracked opportunities requiring movement back and left.',
  'Back OAA': 'Outs Above Average on tracked opportunities requiring movement straight back.',
  'Back-R OAA': 'Outs Above Average on tracked opportunities requiring movement back and right.',
  'In-L OAA': 'Outs Above Average on tracked opportunities requiring movement in and left.',
  'In OAA': 'Outs Above Average on tracked opportunities requiring movement straight in.',
  'In-R OAA': 'Outs Above Average on tracked opportunities requiring movement in and right.',

  // Baserunning / movement tracking
  'Sprint Speed': 'Average top running speed from the fastest two-thirds of tracked competitive runs, in feet per second.',
  Bolts: 'Tracked competitive runs reaching the league\'s elite sprint-speed threshold.',
  'Home-to-First': 'Elapsed time from contact to reaching first base.',
  '90-ft Split': 'Tracked or calibrated time to cover 90 feet.',
  'XBT Opp': 'Opportunities to take an extra base on a hit or tag-up play.',
  'XBT%': 'Percentage of extra-base opportunities in which the runner attempted the additional base.',
  'XBT Safe%': 'Percentage of attempted extra-base advances completed safely.',
  'XBT Outs': 'Outs made while attempting an additional base.',

  // WAR-family (career page)
  Rbat: 'Batting Runs: runs contributed above average through hitting.',
  Rbaser: 'Baserunning Runs: runs contributed above average through baserunning.',
  Rfield: 'Fielding Runs: runs contributed above average through defense.',
  Rpos: 'Positional adjustment: run value adjustment for the defensive difficulty of the position played.',
  RAA: 'Runs Above Average: total runs contributed above a league-average player.',
  WAA: 'Wins Above Average: RAA converted into a wins total.',
  RAR: 'Runs Above Replacement: total runs contributed above a bench-level replacement player.',
  WAR: 'Wins Above Replacement: RAR converted into a wins total — the standard all-in-one value stat.',

  // Star pitch / usage
  'Contact %': 'Percentage of Star Hit uses that resulted in contact.',
  'RBI/Use': 'Average RBI driven in per Star Hit use.',
  'RISP AVG': 'Batting average with runners in scoring position (2nd or 3rd base).',
  'Opp RISP AVG': 'Opponent batting average allowed with runners in scoring position.',

  // Park factors
  'Hard-Hit': 'How much this park inflates or deflates hard-hit ball rate vs. a neutral park (1.00 = neutral).',
  Barrel: 'How much this park inflates or deflates barrel rate vs. a neutral park (1.00 = neutral).',

  // Ratings
  OVR: 'Overall rating.',
  BAT: 'Batting rating.',
  PIT: 'Pitching rating.',
  FLD: 'Fielding rating.',
  SPD: 'Speed rating.',
}

// Normalizes trivial formatting differences (case, whitespace) so a label like "obp" or " OBP "
// still resolves, without silently matching unrelated short strings.
export function getStatDescription(label) {
  if (!label || typeof label !== 'string') return null
  const trimmed = label.trim()
  if (STAT_DESCRIPTIONS[trimmed]) return STAT_DESCRIPTIONS[trimmed]
  const upper = trimmed.toUpperCase()
  const match = Object.keys(STAT_DESCRIPTIONS).find((key) => key.toUpperCase() === upper)
  return match ? STAT_DESCRIPTIONS[match] : null
}
