// Top-level pane layout — the skeleton that index.html used to carry, now a
// Solid component. Purely structural: renderApp hands the pane elements back
// to main.ts (the composition root), which wires each subsystem into its
// pane. Dynamic content inside the panes is rendered by the per-pane
// components (ui/editor.tsx, ui/table-panel.tsx, ui/playback-controls.tsx).

import { render } from 'solid-js/web'

export interface AppPanes {
  canvasPane: HTMLElement
  threeCanvas: HTMLCanvasElement
  hydraCanvas: HTMLCanvasElement
  playbackControls: HTMLElement
  editorPane: HTMLElement
  tablePane: HTMLElement
}

export function renderApp(root: HTMLElement): AppPanes {
  const panes = {} as AppPanes
  render(() => (
    <>
      <div id="canvas-pane" ref={(el) => { panes.canvasPane = el }}>
        {/* three-canvas renders the 3D scene; hydra-canvas post-processes it
            (it reads three-canvas as a texture) and is the visible output. */}
        <canvas id="three-canvas" ref={(el) => { panes.threeCanvas = el }} />
        <canvas id="hydra-canvas" ref={(el) => { panes.hydraCanvas = el }} />
        <div id="playback-controls" ref={(el) => { panes.playbackControls = el }} />
      </div>
      <div id="side-panels">
        <div id="editor-pane" ref={(el) => { panes.editorPane = el }} />
        <div id="table-pane" ref={(el) => { panes.tablePane = el }} />
      </div>
    </>
  ), root)
  return panes
}
