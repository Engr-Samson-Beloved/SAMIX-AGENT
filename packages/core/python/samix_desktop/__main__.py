"""Entry point: `python -m samix_desktop`.

The ordering in `main()` is the whole reason this file exists separately from
`server.py`, and it is not cosmetic:

  1. DPI awareness, before anything imports `uiautomation`. That library declares
     awareness itself, at a weaker level, on import — and the first successful
     declaration is the one that sticks. Import it first and every coordinate
     this process reports is silently wrong on a secondary monitor with a
     different scale factor.
  2. COM, on the thread that will do the work. UI Automation is apartment-bound.
  3. Only then stdout is claimed and the protocol starts.

A failure in step 2 does not exit. It is reported through the handshake instead,
so the agent core can degrade to its PowerShell path and tell the user which one
it is on — an agent that refuses to start because a subsystem is missing has
turned a degraded feature into a broken product.
"""

from __future__ import annotations

import sys

from .winenv import ComInitError, init_com, set_dpi_awareness


def main(argv: list[str] | None = None) -> int:
    _ = argv
    if sys.platform != "win32":
        sys.stderr.write("samix_desktop: Windows only.\n")
        return 2

    dpi = set_dpi_awareness()  # MUST precede the uiautomation import (see above).

    try:
        com = init_com()
    except ComInitError as error:
        com = f"failed: {error}"

    # Imported here, after DPI awareness is declared.
    from .server import Server  # noqa: PLC0415

    return Server(dpi=dpi, com=com).run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
