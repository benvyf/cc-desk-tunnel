# User message controls implementation plan

Goal: show a compact time/copy/edit row beneath sent user messages, following the supplied Codex screenshot. Keep copying available during a run; expose editing only once the session is idle.

Design: retain the existing Conversation message footer and shared CopyButton. Display time, copy and edit in that order with 24px square controls and 12px muted time, aligned to the bubble's right edge. Keep user time/actions visible without hover. Delivery status remains quiet unless unsettled. Today's user timestamps show HH:mm; older messages retain their date context and all timestamps expose their full date/time on hover. Existing assistant footers keep their behavior. Editing reuses the established fork-before-message flow: draft text and attachments return to the composer, and the original conversation is preserved. Messages appended within an existing native run retain the backend's existing fork-point restriction.

- [x] Extend footer/browser tests for always-visible user controls, time/copy/edit order, running and stopped state transitions, both themes, narrow layout and keyboard copy. Verify the new visibility/order assertions fail before implementation.
- [x] Update Conversation.tsx and style.css for the user footer presentation; add compact timestamps to messageTime.ts without changing existing full date labels.
- [x] Preserve edit gating for every active run state and existing draft/attachment rehydration. Validate the real edit/resend path with app and attachment regressions.
- [x] Run relevant UI regressions, message-time unit checks, TypeScript, build, formatting and repository checks. Request independent review.
- [x] Inspect source and implementation screenshots together; record intentional theme/icon/date differences and passing QA in design-qa.md. Keep changes uncommitted until requested.

Review hardening:

- [x] Reproduce and fix missing composer focus after editing. Wait for the fork/history to load, focus once and place the caret at the end, including attachment-only drafts.
- [x] Reproduce a delayed fork response overriding subsequent navigation. Preserve text/files in the new session, but open/focus only when navigation has not changed; cover leaving and returning to the original session.
- [x] Reproduce stale compact dates after midnight. Refresh at local midnight and on window focus without polling idle conversations every second; clean up the timer/listener.
- [x] Verify failing regressions before fixes, then confirm the fixes and request a second read-only review.
- [x] Reproduce and fix delayed history loading stealing focus from conversation search. Preserve the user's current focused control and consume the pending focus request; verify normal editing still focuses and closing search never replays autofocus.
- [x] Extend midnight/window-resume coverage to running questions as well as finished questions.
