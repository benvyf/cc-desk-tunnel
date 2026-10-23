// Immutable /app preload: dependencies stay in the image; workspace protocol comes from this candidate.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const program = process.env.CC_MANAGED_PROGRAM_ROOT;
if (!program) throw new Error('Missing supervised program');
const prefix = pathToFileURL(resolve(program) + '/').href;
const dependencies = new URL('../../../__managed-dependencies__.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cc-desk-tunnel/protocol')
      return nextResolve(
        pathToFileURL(resolve(program, 'packages/protocol/src/index.ts')).href,
        context,
      );
    if (
      context.parentURL?.startsWith(prefix) &&
      !context.parentURL.includes('/node_modules/') &&
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.includes(':')
    )
      return nextResolve(specifier, { ...context, parentURL: dependencies });
    return nextResolve(specifier, context);
  },
});
