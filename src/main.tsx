import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { initCloudBridge } from './cloudBridge.ts';

initCloudBridge();

const cloudRoot = document.getElementById('cloud-root');
if (cloudRoot) {
  createRoot(cloudRoot).render(<App />);
}
