import { createRoot } from 'react-dom/client';
import './app.css';
import { initToken } from './lib/store.js';
import { initPush } from './lib/push.js';
import App from './App.jsx';
import { initViewportGap } from './lib/viewport.js';

// Read the stored / ?token= access token and open the socket before the first
// paint, so the shell renders with a real link state rather than flashing Gate.
initToken();
// Register /sw.js and, where notification permission was already granted,
// silently re-subscribe to Mia's pushes (a relay redeploy heals itself).
initPush();
// iPad Home Screen apps can get a viewport shorter than the screen — measure it.
initViewportGap();

// No StrictMode: the store has module-level side effects and StrictMode
// double-invokes effects, which would double-fire the refcounted watch leases.
createRoot(document.getElementById('app')).render(<App />);
