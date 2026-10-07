import { createRoot } from 'react-dom/client'
import Admin from './Admin'
import App from './App'
import './styles.css'

const isAdmin = location.pathname.replace(/\/$/, '') === '/admin'
createRoot(document.getElementById('root')!).render(isAdmin ? <Admin /> : <App />)
