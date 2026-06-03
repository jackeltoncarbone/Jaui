/// <reference lib="webworker" />
// Jaui rendering worker entry for the demo. The <jaui> component is worker-only:
// it transfers an OffscreenCanvas here and forwards Canvas ops via postMessage.
// A consumer worker registers any Janvas renderer factories FIRST (none here yet
// — the Home is pure UI), then calls BootJauiWorker() once.
import { BootJauiWorker } from 'jaui';

BootJauiWorker();
