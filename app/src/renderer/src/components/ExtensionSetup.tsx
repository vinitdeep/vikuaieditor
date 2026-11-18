import { Copy, FolderOpen } from 'lucide-react'
import { toast } from '@/state/app'
import { Button } from './ui'

const STEPS: { title: string; body: string }[] = [
  { title: 'Open the extension folder', body: 'The Viku extension comes with Viku. Keep this folder where it is.' },
  { title: 'Open your browser’s extensions page', body: 'Chrome: chrome://extensions · Edge: edge://extensions — then switch on Developer mode (top right).' },
  { title: 'Load unpacked', body: 'Click “Load unpacked” and choose the folder from step 1. Viku’s icon appears in the toolbar.' },
  { title: 'Sign in to Google in that browser', body: 'Open aistudio.google.com once and sign in with your own account. Viku connects by itself.' }
]

/**
 * One-time setup of the Viku browser extension (Chrome / Edge). Google blocks AI Studio inside other apps, so the
 * pictures are made in the church's own signed-in browser. Shared by the AI pictures drawer and the Sign-in window.
 */
export function ExtensionSetup({ port }: { port?: number }) {
  const copyAddress = (): void => {
    void navigator.clipboard.writeText('chrome://extensions').then(() => toast('success', 'Copied — paste it in Chrome’s address bar (Edge: edge://extensions)'))
  }
  return (
    <div className="ext-setup">
      <ol className="ext-steps">
        {STEPS.map((st, i) => (
          <li key={st.title}>
            <span className="ext-step-n num" aria-hidden>
              {i + 1}
            </span>
            <span className="ext-step-text">
              <span className="ext-step-title">{st.title}</span>
              <span className="small muted">{st.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="ext-actions">
        <Button variant="primary" icon={FolderOpen} onClick={() => void window.viku?.signin.revealExtension()}>
          Open extension folder
        </Button>
        <Button icon={Copy} onClick={copyAddress}>
          Copy chrome://extensions
        </Button>
      </div>
      <div className={`ext-wait small ${port === 0 ? 'bad' : ''}`} role="status">
        <span className="dot" aria-hidden />
        {port === 0 ? 'The extension link could not start — another program is using its port. Restart Viku.' : 'Waiting for the extension… it connects within a minute of being added.'}
      </div>
    </div>
  )
}
