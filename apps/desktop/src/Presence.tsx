import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

// Retain a dismissed surface only for its visual exit. Input and accessibility end immediately.
// Waiting for CSS animations keeps timing in the stylesheet and also handles reduced motion.
export default function Presence({
  children,
  kind = 'popup',
}: {
  children: ReactElement | null | false | '' | undefined;
  kind?: 'popup' | 'dialog' | 'shade';
}) {
  const child = children || null;
  const [previous, setPrevious] = useState(child);
  const [retained, setRetained] = useState(child);
  const [generation, setGeneration] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  if (child !== previous) {
    setPrevious(child);
    if (child) {
      setRetained(child);
      if (!previous) setGeneration((value) => value + 1);
    }
  }
  const open = child !== null;
  useLayoutEffect(() => {
    // Modal dialogs escape inherited inertness in the top layer, so set it on the root as well.
    for (const element of ref.current?.children ?? []) {
      if (element instanceof HTMLElement) element.inert = !open;
      // Release the modal blocker and restore focus now; CSS retains the visual exit outside the top layer.
      if (!open && element instanceof HTMLDialogElement && element.open) element.close();
    }
    if (open || !retained) return;
    let cancelled = false;
    // Inspect roots only: a spinner inside a menu must not keep its parent alive forever.
    const animations = [...(ref.current?.children ?? [])].flatMap((element) =>
      element
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity),
    );
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRetained(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, retained]);
  return (
    retained && (
      <div
        key={generation}
        ref={ref}
        className="motion-presence"
        data-kind={kind}
        data-state={open ? 'enter' : 'exit'}
        inert={!open}
        aria-hidden={open ? undefined : true}
      >
        {retained}
      </div>
    )
  );
}
