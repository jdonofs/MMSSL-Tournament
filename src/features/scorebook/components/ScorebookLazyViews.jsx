import { Suspense } from 'react'
import { C } from './theme'

export function AtBatEditorScorebookView({
  toolbar,
  tabs,
  selectedGame,
  isSeasonGame,
  editorRef,
  onDirtyChange,
  EditorComponent,
}) {
  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px' }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to edit its at-bats.</div>
        ) : (
          <Suspense fallback={<div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Loading editor…</div>}>
            <EditorComponent
              ref={editorRef}
              source={isSeasonGame ? 'season' : 'tournament'}
              gameId={selectedGame.id}
              embedded
              onDirtyChange={onDirtyChange}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

export function TrackerScorebookView({
  toolbar,
  tabs,
  selectedGame,
  TrackerComponent,
}) {
  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px' }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to watch its tracker feed.</div>
        ) : (
          <Suspense fallback={<div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Loading tracker feed…</div>}>
            <TrackerComponent embedded expectedGameId={selectedGame.id} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
