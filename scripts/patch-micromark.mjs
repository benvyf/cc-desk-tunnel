// Targeted micromark 4.0.3 patch. Provenance and MIT notice: ../patches/micromark-4.0.3.md.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const replacement = `function createResolver(extraResolver) {
  return resolveAllText;

  /** @type {Resolver} */
  function resolveAllText(events, context) {
    // Compact once: repeated splices shift the remaining events for every run.
    let read = 0;
    let write = 0;
    const length = events.length;

    while (read < length) {
      const event = events[read];
      if (event[1].type !== 'data') {
        events[write++] = event;
        read++;
        continue;
      }

      const enter = read;
      read += 2;
      while (read < length && events[read][1].type === 'data') read++;
      if (read !== enter + 2) event[1].end = events[read - 1][1].end;
      events[write++] = event;
      events[write++] = events[enter + 1];
    }

    events.length = write;
    return extraResolver ? extraResolver(events, context) : events;
  }
}

`;

export const micromarkSourceVariants = [
  {
    path: 'lib/initialize/text.js',
    originalSha256: '1c5682291dbb6cea7f95edeb6d50421238b91752c9e0fb9485bdde44628ce090',
    patchedSha256: '66bc6ee479252a246524169257553571053f972dd68b6a2078f78bfeaa269da0',
    original: `function createResolver(extraResolver) {
  return resolveAllText;

  /** @type {Resolver} */
  function resolveAllText(events, context) {
    let index = -1;
    /** @type {number | undefined} */
    let enter;

    // A rather boring computation (to merge adjacent \`data\` events) which
    // improves mm performance by 29%.
    while (++index <= events.length) {
      if (enter === undefined) {
        if (events[index] && events[index][1].type === "data") {
          enter = index;
          index++;
        }
      } else if (!events[index] || events[index][1].type !== "data") {
        // Don’t do anything if there is one data token.
        if (index !== enter + 2) {
          events[enter][1].end = events[index - 1][1].end;
          events.splice(enter + 2, index - enter - 2);
          index = enter + 2;
        }
        enter = undefined;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}

`,
    replacement,
  },
  {
    path: 'dev/lib/initialize/text.js',
    originalSha256: '42f71a37602a65811779e2ae2977bd968504e2b54b575c1458ebb7dd0ca4ff66',
    patchedSha256: 'eec12c6702987ad445320d76fcbae257ed1529c75872954d3244f43741886ba8',
    original: `function createResolver(extraResolver) {
  return resolveAllText

  /** @type {Resolver} */
  function resolveAllText(events, context) {
    let index = -1
    /** @type {number | undefined} */
    let enter

    // A rather boring computation (to merge adjacent \`data\` events) which
    // improves mm performance by 29%.
    while (++index <= events.length) {
      if (enter === undefined) {
        if (events[index] && events[index][1].type === types.data) {
          enter = index
          index++
        }
      } else if (!events[index] || events[index][1].type !== types.data) {
        // Don’t do anything if there is one data token.
        if (index !== enter + 2) {
          events[enter][1].end = events[index - 1][1].end
          events.splice(enter + 2, index - enter - 2)
          index = enter + 2
        }

        enter = undefined
      }
    }

    return extraResolver ? extraResolver(events, context) : events
  }
}

`,
    replacement,
  },
];

const sha256 = (source) => createHash('sha256').update(source).digest('hex');

/** Validate a complete known source before replacing only its data resolver. */
export function patchMicromarkSource(source, relativePath) {
  const variant = micromarkSourceVariants.find((item) => item.path === relativePath);
  if (!variant) throw new Error('Unsupported micromark patch path: ' + relativePath);
  const digest = sha256(source);
  if (digest === variant.patchedSha256) return source;
  if (digest !== variant.originalSha256) {
    throw new Error(
      'Unknown micromark 4.0.3 source: ' + relativePath + ' (SHA-256 ' + digest + ')',
    );
  }
  const result = source.replace(variant.original, variant.replacement);
  if (sha256(result) !== variant.patchedSha256) {
    throw new Error('micromark patch output mismatch: ' + relativePath);
  }
  return result;
}

/** Validate both export variants before writing either installed file. */
export function applyMicromarkPatch(
  packageDirectory = fileURLToPath(new URL('../node_modules/micromark/', import.meta.url)),
) {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  if (manifest.name !== 'micromark' || manifest.version !== '4.0.3') {
    throw new Error(
      'Unsupported micromark package ' +
        manifest.name +
        '@' +
        manifest.version +
        '; expected micromark@4.0.3',
    );
  }
  const changes = micromarkSourceVariants.map((variant) => {
    const path = join(packageDirectory, variant.path);
    const source = readFileSync(path, 'utf8');
    return { path, source, patched: patchMicromarkSource(source, variant.path) };
  });
  const changed = [];
  for (const change of changes) {
    if (change.source !== change.patched) {
      writeFileSync(change.path, change.patched);
      changed.push(change.path);
    }
  }
  return { version: '4.0.3', changed };
}
