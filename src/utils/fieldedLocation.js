import { parseFielderChainFromNotation } from './notation'

// Results where the ball landed/wasn't caught cleanly — it was, by
// definition, retrieved from somewhere other than a fielder's glove at the
// exact marked spot.
const HIT_RESULTS = new Set(['1B', '2B', '3B', 'IPHR', 'ROE', 'FC'])

// Whether a fielded-location marker is worth showing/capturing for this PA,
// separate from hit_x/hit_y (where it was hit/first landed): grounders
// always (they roll), any hit that landed and was retrieved from elsewhere,
// or a bobbled/relayed catch (2+ fielders in the chain, excluding Buddy
// Jump — always exactly 2 fielders by design, not a bobble). A clean
// single-fielder catch on a fly/liner needs no second spot — it was caught
// right where it's already marked. Shared by At-Bat Data Entry (capture)
// and the at-bat detail page (display) so the rule can't drift between them.
export function shouldShowFieldedLocation(pa) {
  if (!pa) return false
  const fielderChain = parseFielderChainFromNotation(pa.hit_notation)
  return (
    pa.trajectory === 'G'
    || HIT_RESULTS.has(pa.result)
    || (fielderChain.length >= 2 && !pa.is_buddy_jump)
  )
}
