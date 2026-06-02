import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerLicense } from '@syncfusion/ej2-base'
import './index.css'
import App from './App'

registerLicense('Ngo9BigBOggjHTQxAR8/V1JHaF1cXmhPYVJ0WmFZfVhgdV9CZFZTR2YuP1ZhSXxVdkBiWn9fdHBXQWlUV0R9XEE=')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
