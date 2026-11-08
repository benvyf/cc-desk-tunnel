// Build only the pinned reconstruction primitives, never the application updater.
import generic from 'electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js';
import planning from 'electron-updater/out/differentialDownloader/downloadPlanBuilder.js';
import executor from 'builder-util-runtime/out/httpExecutor.js';
import cancellation from 'builder-util-runtime/out/CancellationToken.js';
import manifest from 'electron-updater/package.json' with { type: 'json' };

export const version = manifest.version;
if (version !== '6.8.10') throw new Error('Unsupported differential engine version');
export const { GenericDifferentialDownloader } = generic;
export const { computeOperations, OperationKind } = planning;
export const { HttpExecutor } = executor;
export const { CancellationToken, CancellationError } = cancellation;
