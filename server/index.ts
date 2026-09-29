import { app } from './app.js';
import { config } from './config.js';
import { initializeStore } from './store.js';

await initializeStore();
app.listen(config.port, '127.0.0.1', () => console.log(`SpendProof API listening on http://127.0.0.1:${config.port} (payment simulation only).`));
