/**
 * Jaui.Worker — default worker entry. Used by `SpawnJauiWorker()` for
 * consumers that don't ship their own custom worker (no Janvas renderers
 * to register).
 *
 * Show-studio (or any consumer with Janvas renderers) builds its own
 * worker entry that imports `BootJauiWorker` from `./Worker.Boot` after
 * registering renderer factories via `RegisterJanvasRenderer(...)`. The
 * Angular `<jaui>` component accepts a custom Worker via its `[worker]`
 * input so consumers can inject their bundle.
 */

import { BootJauiWorker } from './Worker.Boot';

BootJauiWorker();

export {};
