'use strict';

// Development shim. Packaging replaces this file with the standalone pinned bundle.
const version = require('electron-updater/package.json').version;
if (version !== '6.8.10') throw new Error('Unsupported differential engine version');
const {
  GenericDifferentialDownloader,
} = require('electron-updater/out/differentialDownloader/GenericDifferentialDownloader');
const {
  computeOperations,
  OperationKind,
} = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
const { HttpExecutor, CancellationToken, CancellationError } = require('builder-util-runtime');
module.exports = {
  GenericDifferentialDownloader,
  computeOperations,
  OperationKind,
  HttpExecutor,
  CancellationToken,
  CancellationError,
  version,
};
