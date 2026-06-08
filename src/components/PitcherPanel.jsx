import CharacterPortrait from './CharacterPortrait'

export default function PitcherPanel({
  pitcherName,
  playerName,
  pitchNumber,
  gameLine,
}) {
  return (
    <div style={{ background: '#1E293B', borderRadius: 16, padding: 12, border: '1px solid #334155', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', border: '2px solid #EAB308' }}>
          <CharacterPortrait name={pitcherName} size={56} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{pitcherName || 'Select pitcher'}</div>
          <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{playerName || 'No pitcher set'}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: '#CBD5E1' }}>
            <span>IP {gameLine?.ip ?? '0.0'}</span>
            <span>H {gameLine?.h ?? 0}</span>
            <span>R {gameLine?.r ?? 0}</span>
            <span>ER {gameLine?.er ?? 0}</span>
            <span>BB {gameLine?.bb ?? 0}</span>
            <span>K {gameLine?.k ?? 0}</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, color: '#EAB308', fontSize: 12, fontWeight: 700 }}>Pitch #{pitchNumber}</div>
    </div>
  )
}
