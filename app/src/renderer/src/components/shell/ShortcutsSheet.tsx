import { Keyboard } from 'lucide-react'
import { useApp } from '@/state/app'
import { Modal } from './Shell'

type Row = [keys: string[][], label: string]

/** Every binding here is handled in lib/hotkeys.ts (or the timeline's Ctrl+wheel). Keep the two in sync. */
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Playback',
    rows: [
      [[['Space']], 'Play / pause'],
      [[['J'], ['K'], ['L']], 'Shuttle back · stop · forward (tap again for 2×, 4×)'],
      [[['←'], ['→']], 'Step one frame'],
      [[['Shift', '←'], ['Shift', '→']], 'Step one second'],
      [[['↑'], ['↓']], 'Previous / next edit'],
      [[['Home'], ['End']], 'Start / end'],
      [[['1'], ['2']], 'Reel 9:16 / Source 16:9 viewer']
    ]
  },
  {
    title: 'Tools & editing',
    rows: [
      [[['A']], 'Select tool'],
      [[['B']], 'Blade tool'],
      [[['T']], 'Trim tool'],
      [[['Ctrl', 'B']], 'Blade at the playhead'],
      [[['Del']], 'Ripple delete the selection'],
      [[['Ctrl', 'Z']], 'Undo'],
      [[['Ctrl', 'Y'], ['Ctrl', 'Shift', 'Z']], 'Redo'],
      [[['Ctrl', 'S']], 'Save now (autosave is on)'],
      [[['Ctrl', 'E']], 'Export…']
    ]
  },
  {
    title: 'Transcript',
    rows: [
      [[['I']], 'Mark in at the line under the source playhead'],
      [[['O']], 'Mark out — selects in → out'],
      [[['Shift', 'O']], 'Mark out and add to the selection'],
      [[['Esc']], 'Clear the in-point / selection']
    ]
  },
  {
    title: 'Timeline & view',
    rows: [
      [[['+'], ['−']], 'Zoom in / out (also Ctrl+= / Ctrl+−, Ctrl+wheel)'],
      [[['Shift', 'Z']], 'Zoom to fit'],
      [[['N']], 'Snapping on / off'],
      [[['S']], 'Skimming on / off'],
      [[['Shift', 'S']], 'Safe zones on / off'],
      [[['Ctrl', ',']], 'Settings'],
      [[['?']], 'This sheet']
    ]
  }
]

export function ShortcutsSheet() {
  const open = useApp((s) => s.shortcutsOpen)
  const set = useApp((s) => s.set)
  if (!open) return null
  return (
    <Modal title="Keyboard shortcuts" onClose={() => set({ shortcutsOpen: false })} width={940}>
      <div className="kb-intro small muted">
        <Keyboard size={14} aria-hidden /> Keys work anywhere in the editor except while typing in a field. Press <kbd className="kbd">?</kbd> to open this again.
      </div>
      <div className="kb-grid">
        {GROUPS.map((g) => (
          <section key={g.title} className="kb-group" aria-label={g.title}>
            <h3>{g.title}</h3>
            {g.rows.map(([keys, label]) => (
              <div key={label} className="kb-row">
                <span className="kb-keys">
                  {keys.map((combo, i) => (
                    <span key={i} className="kb-combo">
                      {i > 0 && <span className="kb-or">/</span>}
                      {combo.map((k, j) => (
                        <kbd key={j} className="kbd">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  ))}
                </span>
                <span className="kb-label">{label}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}
