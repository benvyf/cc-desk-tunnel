import { useEffect, useInsertionEffect, useLayoutEffect, useRef, useState } from 'react';
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

// For a panel that is not a floating surface (the preview column, a fold): true while it is being put away, for as
// long as the CSS time token says its exit lasts, so its content can stay rendered — and inert — until it is out of
// sight. With reduced motion the tokens are 0ms and this is never true for longer than a render.
export function useLeaving(shown: boolean, token = '--cds-dur-sheet') {
  const [leaving, setLeaving] = useState(false);
  const [was, setWas] = useState(shown);
  if (shown !== was) {
    setWas(shown);
    setLeaving(!shown);
  }
  useEffect(() => {
    if (!leaving) return;
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || 0;
    const timer = setTimeout(() => setLeaving(false), ms);
    return () => clearTimeout(timer);
  }, [leaving, token]);
  return leaving;
}

// The window's columns (.shell) glide when the app opens or closes the side column or the preview: `columns` names
// that state, and each change marks the shell with data-columns-gliding for the length of the slide (style.css).
// The mark goes on while React commits the new classes (an insertion effect runs before any layout effect, and so
// before a newly shown panel measures itself and makes the browser restyle), so that restyle already transitions
// the tracks. The window's own size moves them at once: a change that follows a resize (a narrow window folding the
// column away) is not marked, and a resize ends a slide. Opting in, rather than switching the slide off on
// `resize`, matters because the page can be restyled at its new size before that event comes.
export function useColumnsGliding(columns: string) {
  const last = useRef(columns);
  const resizedAt = useRef(-Infinity);
  useEffect(() => {
    const resized = () => {
      resizedAt.current = performance.now();
      document.querySelector('.shell')?.removeAttribute('data-columns-gliding');
    };
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  // Which change the mark belongs to: a later one takes it over.
  const generation = useRef(0);
  const marked = useRef<Element | null>(null);
  // Only the mark here: anything that reads styles would restyle the page in the middle of the commit.
  useInsertionEffect(() => {
    if (columns === last.current) return;
    last.current = columns;
    generation.current++;
    marked.current = null;
    const shell = document.querySelector('.shell');
    if (!shell) return;
    if (performance.now() - resizedAt.current < 400) {
      shell.removeAttribute('data-columns-gliding');
      return;
    }
    shell.setAttribute('data-columns-gliding', '');
    marked.current = shell;
  }, [columns]);
  // Unmarked as the tracks come to rest, in the same frame as the transition's end (a native preview puts its view in
  // place then and should not see a further change); the timer covers a change that does not move them.
  useEffect(() => {
    const shell = marked.current;
    if (!shell) return;
    const mine = generation.current;
    const done = () => {
      if (generation.current === mine) shell.removeAttribute('data-columns-gliding');
    };
    const ended = (event: Event) => {
      if (
        event.target === shell &&
        (event as TransitionEvent).propertyName === 'grid-template-columns'
      )
        done();
    };
    const ms =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cds-dur-sheet')) ||
      0;
    shell.addEventListener('transitionend', ended);
    const timer = setTimeout(done, ms + 100);
    return () => {
      shell.removeEventListener('transitionend', ended);
      clearTimeout(timer);
    };
  }, [columns]);
}
