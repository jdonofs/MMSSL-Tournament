import { createElement, createRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import AtBatEditor from '../../../src/pages/AtBatEditor.jsx'
import '../../../src/styles/global.css'

let setTarget
let setMounted
const editorRef = createRef()

function Harness() {
  const seed = globalThis.__EDITOR_SEED__ || {}
  const [target, updateTarget] = useState(seed.target || { source: 'tournament', gameId: 1, paId: null })
  const [mounted, updateMounted] = useState(true)
  setTarget = updateTarget
  setMounted = updateMounted
  return mounted
    ? createElement(AtBatEditor, { ...target, embedded: true, ref: editorRef })
    : createElement('div', { 'data-testid': 'editor-unmounted' }, 'Unmounted')
}

const root = createRoot(document.getElementById('root'))
root.render(createElement(BrowserRouter, null, createElement(Harness)))

globalThis.__EDITOR_ACTIONS__ = {
  setTarget(target) { setTarget(target) },
  save() { return editorRef.current?.save?.() },
  discard() { return editorRef.current?.discard?.() },
  unmount() { setMounted(false) },
}
