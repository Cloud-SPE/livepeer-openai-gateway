// Mount points: <portal-app> and <bridge-toast-stack> in index.html.
// Importing the app component pulls in all pages and the shared web components
// they depend on; tree-shaking keeps unused shared bits out of the bundle.

import './components/portal-app.js';
import '../shared/components/bridge-toast.js';
