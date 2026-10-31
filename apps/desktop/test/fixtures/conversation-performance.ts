import type { Page } from '@playwright/test';

export type BrowserPerformance = {
  inputFrameMs: Record<string, number[]>;
  longTasks: number[];
  listenerAdds: Record<string, number>;
  listenerRemoves: Record<string, number>;
};

// Test-only measurement, installed before React. Listener counts cover registrations on window/document,
// not React's delegated element listeners or ProxyClient subscriptions.
export async function installPerformanceProbe(page: Page) {
  await page.addInitScript(() => {
    const fresh = (): BrowserPerformance => ({
      inputFrameMs: {},
      longTasks: [],
      listenerAdds: {},
      listenerRemoves: {},
    });
    const probe = ((window as any).performanceProbe = {
      values: fresh(),
      reset() {
        this.values = fresh();
      },
    });
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (...args) {
      if (this === window || this === document) {
        const counts = probe.values.listenerAdds;
        counts[args[0]] = (counts[args[0]] ?? 0) + 1;
      }
      return add.apply(this, args);
    };
    EventTarget.prototype.removeEventListener = function (...args) {
      if (this === window || this === document) {
        const counts = probe.values.listenerRemoves;
        counts[args[0]] = (counts[args[0]] ?? 0) + 1;
      }
      return remove.apply(this, args);
    };
    document.addEventListener(
      'input',
      (event) => {
        const name = (event.target as HTMLElement)?.dataset.performanceInput;
        if (!name) return;
        const values = probe.values;
        requestAnimationFrame(() => {
          // Both clocks have this document's time origin. This estimates input-event to next-frame callback,
          // not pixel presentation latency and not the Playwright command round trip.
          const samples = ((values.inputFrameMs as Record<string, number[]>)[name] ??= []);
          samples.push(performance.now() - event.timeStamp);
        });
      },
      true,
    );
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        probe.values.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: 'longtask' });
    }
  });
}

export async function resetPerformanceProbe(page: Page) {
  await page.evaluate(() => (window as any).performanceProbe.reset());
}

export async function readPerformanceProbe(page: Page): Promise<BrowserPerformance> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return page.evaluate(() => (window as any).performanceProbe.values);
}

export function percentile(samples: number[], fraction: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
