import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'

const initialDoc = `// livecodata
// edit code here — threejs scene is on the left

function animate(mesh, t) {
  mesh.rotation.x = t * 0.0003
  mesh.rotation.y = t * 0.0005
}
`

export function initEditor(parent) {
  new EditorView({
    doc: initialDoc,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent,
  })
}
