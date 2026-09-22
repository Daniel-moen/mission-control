import { createRoot } from 'react-dom/client';
import './app.css';
import { initToken } from './lib/store.js';
import App from './App.jsx';

// Read the stored / ?token= access token and open the socket before the first
// paint, so the shell renders with a real link state rather than flashing Gate.
initToken();

// No StrictMode: the store has module-level side effects and StrictMode
// double-invokes effects, which would double-fire the refcounted watch leases.
createRoot(document.getElementById('app')).render(<App />);
