# Steps (device_act)
- tap / long_press: {action, ref} or {action, x, y} (0–999). Prefer refs; coordinates only for what has no node.
- type: {action: "type", text, ref?, submit?}. Replaces the field's content (no ref: the focused field) and reads it back: verified match | mismatch | unknown. submit: true then presses the keyboard's enter / send key.
- swipe: {action, direction, ref?}: the finger's direction, inside ref or mid-screen. scroll: {action, direction, ref?}: where the content you want is (down = further down), in ref or the largest scrollable.
- back, home: the system buttons. wait_stable: {action, timeoutMs?}: until the screen is quiet for 500 ms (default 3000, max 10000); use after launching and after steps that load.
- Steps run in order; the first failure stops the batch: stoppedAt is its 0-based index, later steps did not run, and the tool result is an error starting with "CODE: message".
- Step result: {action, ok: true, effect, verified?, target?, category?, authorizedBy?} or {action, ok: false, code, message?}.
- effect: place_changed (another app or screen came to the front), done (the screen changed), small_change (at most 3 nodes changed, e.g. a filled field), no_effect (nothing changed: probably missed; observe, do not repeat blindly).
- observe: true adds the screen after the batch (a diff against the one before), saving a device_observe.
- category marks an irreversible step (send, delete, submit…); authorizedBy says why it ran: policy (the owner allows this app), owner (confirmed on the phone just now) or grant:<id>.