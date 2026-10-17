import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadConfig } from './config/config.js';
import { errorMessage } from './api/errors.js';
import { ErrorState } from './ui/states.js';
import './styles.css';

async function start(): Promise<void> {
  const element = document.getElementById('root');
  if (!element) return;
  const root = createRoot(element);

  try {
    const config = await loadConfig();
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <div className="centered">
        <ErrorState
          title="Could not load the app configuration"
          message={errorMessage(error)}
          onRetry={() => window.location.reload()}
        />
      </div>,
    );
  }
}

void start();
