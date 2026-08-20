"""SAMIX desktop control sidecar (Phase 7).

A long-lived Python process that exposes Windows UI Automation to the agent core
over newline-delimited JSON on stdin/stdout. See `server.py` for the protocol and
`README.md` in the parent directory for why this is a sidecar at all.
"""

__all__ = ["PROTOCOL_VERSION"]

# Bumped on any breaking change to the op set or frame shape. The TypeScript
# client checks this during the handshake and degrades rather than guessing.
PROTOCOL_VERSION = 1
