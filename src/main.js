import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'
import { initTablePanel } from './table-panel.js'
import { initPlayback } from './playback.js'

const sceneAPI = initThree(document.getElementById('three-canvas'))
initEditor(document.getElementById('editor-pane'))
const tablePanel = initTablePanel(document.getElementById('table-pane'))
initPlayback(document.getElementById('playback-controls'), sceneAPI, tablePanel)
