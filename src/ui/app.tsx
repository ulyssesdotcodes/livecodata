// The app shell: one Solid render tree for the whole layout. Every pane is
// created here from the pure-logic controllers main.ts builds and passes in
// (humble-object style — controllers hold signals and methods, components
// only render them). The two exceptions are the three.js and hydra panes,
// which are canvases drawn imperatively: this render creates the <canvas>
// elements (and hands them back via CanvasMounts), but their contents are
// driven outside Solid by initThree/initHydra.
//
// The playback controls need the playback engine, and the engine needs the
// scene/hydra APIs — which need the canvases this render creates. So the
// playback controller arrives as an accessor that main.ts fills in right
// after mountApp returns; the controls render as soon as it lands (still
// synchronously before anything is painted).

import { Show, type Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import { PlaybackControls, type PlaybackController } from './playback-controls.js'
import { EditorPane, type EditorController } from './editor.js'
import { TablePane, type TablePanelController } from './table-panel.js'
import { SessionBar, type SessionBarController } from './session-bar.js'
import { SessionSelector, type SessionSelectorController } from './session-selector.js'
import { RoomChip, type RoomChipController } from './room-chip.js'

export interface AppProps {
  editor: EditorController
  tablePanel: TablePanelController
  sessionBar: SessionBarController
  sessionSelector: SessionSelectorController
  roomChip: RoomChipController
  playback: Accessor<PlaybackController | null>
}

// The imperative islands the app render creates but does not draw into:
// main.ts feeds these to initThree/initHydra (three-canvas renders the 3D
// scene; hydra-canvas post-processes it, reading three-canvas as a texture,
// and is the visible output).
export interface CanvasMounts {
  canvasPane: HTMLElement
  threeCanvas: HTMLCanvasElement
  hydraCanvas: HTMLCanvasElement
}

function App(props: AppProps & { mounts: CanvasMounts }) {
  return (
    <>
      <div id="canvas-pane" ref={(el) => (props.mounts.canvasPane = el)}>
        <canvas id="three-canvas" ref={(el) => (props.mounts.threeCanvas = el)} />
        <canvas id="hydra-canvas" ref={(el) => (props.mounts.hydraCanvas = el)} />
        <div id="playback-controls">
          <Show when={props.playback()}>
            {(p) => <PlaybackControls vs={p().vs} engine={p().engine} tapControl={p().tapControl} />}
          </Show>
        </div>
      </div>
      <div id="side-panels">
        <EditorPane ctl={props.editor}>
          <SessionSelector ctl={props.sessionSelector}>
            <RoomChip ctl={props.roomChip} />
          </SessionSelector>
          <SessionBar ctl={props.sessionBar} />
        </EditorPane>
        <TablePane ctl={props.tablePanel} />
      </div>
    </>
  )
}

// Solid's render is synchronous, so the returned mounts are populated (and
// the full layout is in the DOM) by the time this returns.
export function mountApp(root: HTMLElement, props: AppProps): CanvasMounts {
  const mounts = {} as CanvasMounts
  render(() => <App {...props} mounts={mounts} />, root)
  return mounts
}
