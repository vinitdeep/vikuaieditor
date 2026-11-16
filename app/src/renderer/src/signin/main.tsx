import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../fonts'
import '../styles/base.css'
import '../styles/app.css'
import '../styles/signin.css'
import { SignInApp } from './SignInApp'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <SignInApp />
  </StrictMode>
)
