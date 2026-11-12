# Errors
- DEVICE_LOCKED: the screen is locked or off. Ask the user to unlock; do not retry in a loop.
- DEVICE_STOPPED: the owner pressed stop or touched the screen (took over); control is refused for 60 s. End the task and ask the user.
- DEVICE_HANDOFF_REQUIRED: only the owner may do this (payments); the phone handed the screen to them. Tell the user; do not retry or work around it.
- DEVICE_DENIED: the owner declined the step or the authorization. Do not retry the same thing; ask the user.
- DEVICE_NOT_ALLOWED: control is off on the phone, or the owner blocked that app.
- DEVICE_CAPABILITY_MISSING: Riffet's accessibility service is off; ask the user to turn it on.
- DEVICE_FAILED: the step could not run (ref no longer on screen, field not editable…); observe again and adjust.
- DEVICE_UNREACHABLE / DEVICE_TIMEOUT: the phone is not connected, or did not answer in time.