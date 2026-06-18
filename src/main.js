import './style.css'
import { initThree } from './three-scene.js'
import { initEditor } from './editor.js'

initThree(document.getElementById('three-canvas'))
initEditor(document.getElementById('editor-pane'))
