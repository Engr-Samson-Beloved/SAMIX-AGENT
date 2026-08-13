# SAMIX AGENT — Local Autonomous Computer Agent
## Comprehensive Engineering Specification for Claude Code

> **Project type:** Local-first autonomous desktop AI agent
>
> **Primary platform:** Windows 10/11
>
> **Primary developer environment:** Windows laptop
>
> **Developer:** SamixTech
>
> **Implementation assistant:** Claude Code
>
> **Core idea:** A single local application that launches, immediately enters voice-listening mode, understands natural-language commands, plans the required actions, controls the computer, executes operations, verifies results, and reports completion.

---

# 1. PRODUCT VISION

Build a local AI computer agent that makes the user's Windows computer feel almost limitless.

The user should be able to launch one executable/application and immediately speak naturally:

- "Open Chrome."
- "Go to my Downloads folder."
- "Find the latest PDF."
- "Copy this file to Desktop."
- "Open WhatsApp."
- "Send this file to Charles."
- "Open VS Code and open my SkoolConnect project."
- "Create a folder called invoices."
- "Find the screenshot I took yesterday."
- "Open the project and run it."
- "Check why the build failed."
- "Search the web for the documentation."
- "Type this message into WhatsApp."
- "Move these files into the project folder."
- "Take a screenshot and show me what is wrong."

The agent must not behave like a chatbot that merely describes what the user should do.

It must behave like an **operator** that can actually perform actions on the local computer.

The central loop is:

```text
LISTEN
  ↓
UNDERSTAND
  ↓
PLAN
  ↓
SELECT TOOLS
  ↓
EXECUTE
  ↓
OBSERVE
  ↓
VERIFY
  ↓
RECOVER / RETRY IF NECESSARY
  ↓
REPORT
```

---

# 2. CORE PRODUCT REQUIREMENT

The application should behave like a local executable.

When launched:

```text
SAMIX AGENT.exe
        ↓
Initialize services
        ↓
Check microphone
        ↓
Initialize speech recognition
        ↓
Initialize AI model/API
        ↓
Initialize computer-control tools
        ↓
Enter LISTENING MODE
```

The user should not need to open a terminal.

The target UX is:

```text
[ SAMIX AGENT ]

● Listening...

User:
"Find the latest invoice and send it to Charles on WhatsApp."

Agent:
"Understood."

→ Searching files
→ Found invoice_2026_08_11.pdf
→ Opening WhatsApp
→ Finding Charles
→ Attaching file
→ Verifying recipient
→ Sending
→ Confirming delivery state

Agent:
"Done. I sent invoice_2026_08_11.pdf to Charles."
```

---

# 3. IMPORTANT DESIGN PRINCIPLE

Do NOT build the system as one giant AI prompt.

Build an **agent runtime with explicit tools**.

The LLM should reason and choose tools.

The application should execute those tools.

Architecture:

```text
                    USER
                     │
                     ▼
               MICROPHONE
                     │
                     ▼
             SPEECH-TO-TEXT
                     │
                     ▼
             AGENT ORCHESTRATOR
                     │
             ┌───────┴────────┐
             ▼                ▼
         PLANNER           MEMORY
             │
             ▼
        TOOL SELECTION
             │
   ┌─────────┼─────────────┐
   ▼         ▼             ▼
FILESYSTEM  WINDOWS      BROWSER
   │         │             │
   ▼         ▼             ▼
 WHATSAPP   UI/A11Y      PLAYWRIGHT
   │         │             │
   └─────────┼─────────────┘
             ▼
        OBSERVATION
             │
             ▼
        VERIFICATION
             │
       ┌─────┴─────┐
       ▼           ▼
   SUCCESS       RECOVERY
       │           │
       └─────┬─────┘
             ▼
           USER
```

---

# 4. RECOMMENDED TECHNOLOGY STACK

## 4.1 Desktop Application

### Primary choice

**Tauri 2.x**

Why:

- Lightweight compared with Electron
- Native Windows integration
- Small executable footprint
- Rust backend
- Web frontend
- Good system-tray support
- Good fit for a local utility that stays running
- Can expose controlled native commands to the frontend

Frontend:

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui where useful

Do NOT build a visually heavy application.

The UI should be minimal because voice is the primary interface.

---

# 5. CORE LANGUAGE STACK

Use:

```text
TypeScript
React
Node.js
Rust
Python
```

But do not use every language everywhere.

Recommended responsibility split:

### TypeScript

Use for:

- Agent orchestration
- Tool definitions
- LLM integration
- Application state
- Memory
- Frontend
- IPC contracts
- Browser automation orchestration
- Configuration
- Logging

### Rust / Tauri

Use for:

- Desktop shell
- Windows-native integration
- System tray
- Global hotkeys
- Native filesystem permissions
- Native process launching where appropriate
- Secure IPC
- Windows-specific capabilities

### Python

Use only where it provides a clear advantage:

- Speech recognition if using Python-based Whisper stack
- Computer vision
- PyAutoGUI where necessary
- pywinauto / Windows UI Automation helpers
- Specialized ML models

Prefer calling Python services through a controlled local interface rather than mixing Python throughout the entire application.

---

# 6. AI / LLM LAYER

The agent needs an LLM capable of:

- Tool/function calling
- Structured outputs
- Multi-step planning
- Context understanding
- Error recovery
- Reasoning over tool results
- Vision if enabled

The model provider must be abstracted.

Create:

```text
src/ai/
├── provider.ts
├── anthropic.ts
├── openai.ts
├── local.ts
├── types.ts
└── model-router.ts
```

Do not hard-code the entire application to one provider.

The system should support:

```text
Anthropic
OpenAI
Local models
Future providers
```

Claude can be the initial provider.

---

# 7. CLAUDE / ANTHROPIC INTEGRATION

The application should support Anthropic models through the official API/SDK.

The LLM receives:

```text
System instructions
+
Conversation context
+
Current computer state
+
Available tools
+
Previous tool results
```

The model returns either:

```text
normal response
```

or:

```text
tool call
```

Example conceptual tool call:

```json
{
  "tool": "filesystem.search",
  "arguments": {
    "query": "latest invoice PDF"
  }
}
```

The runtime executes the tool and sends the result back to the model.

Never allow the model to directly execute arbitrary native commands without passing through the tool permission layer.

---

# 8. SPEECH-TO-TEXT

The agent must support continuous voice interaction.

Recommended initial technology:

**Whisper / faster-whisper**

Possible architecture:

```text
Microphone
    ↓
Audio capture
    ↓
Voice activity detection
    ↓
Speech segment
    ↓
Whisper
    ↓
Text
    ↓
Agent
```

The system should support:

- Push-to-talk
- Always-listening mode
- Voice activity detection
- Silence detection
- Interruptions
- "Stop"
- "Cancel"
- "Wait"
- "Continue"

For MVP, push-to-talk or explicit listening mode is acceptable.

Target experience:

```text
Launch application
        ↓
Microphone activates
        ↓
Listening indicator appears
        ↓
User speaks
        ↓
Command executes
```

---

# 9. TEXT-TO-SPEECH

The agent should eventually respond verbally.

Support:

```text
Agent:
"Done. The file has been sent."
```

Recommended abstraction:

```text
src/voice/
├── speech-to-text/
├── text-to-speech/
├── audio/
├── vad/
└── voice-manager.ts
```

TTS provider should also be replaceable.

Possible providers:

- Windows native speech
- Edge TTS
- ElevenLabs
- OpenAI TTS
- Local TTS

Do not make TTS mandatory for the first MVP.

---

# 10. COMPUTER CONTROL ARCHITECTURE

The most important rule:

## Prefer structured APIs over visual clicking.

For example:

Bad:

```text
AI sees File Explorer
→ clicks This PC
→ clicks Documents
→ searches visually
```

Better:

```text
filesystem.list()
filesystem.search()
filesystem.copy()
```

Only use GUI automation when structured APIs are unavailable.

---

# 11. TOOL SYSTEM

Every computer capability must be represented as an explicit tool.

Create:

```text
src/tools/
├── filesystem/
├── process/
├── windows/
├── browser/
├── keyboard/
├── mouse/
├── screen/
├── clipboard/
├── whatsapp/
├── terminal/
├── vscode/
├── applications/
├── network/
└── index.ts
```

Every tool should define:

```text
name
description
input schema
permission level
execution function
validation
result schema
```

Example:

```typescript
interface AgentTool {
  name: string;
  description: string;
  permission: PermissionLevel;
  inputSchema: unknown;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

---

# 12. FILESYSTEM TOOLS

Implement:

```text
filesystem.listDirectory
filesystem.search
filesystem.read
filesystem.copy
filesystem.move
filesystem.rename
filesystem.delete
filesystem.createDirectory
filesystem.exists
filesystem.getMetadata
filesystem.open
filesystem.compress
filesystem.extract
```

Example:

```text
User:
"Find my latest PDF."

Agent:

filesystem.search({
  extension: ".pdf",
  sortBy: "modified",
  order: "desc",
  limit: 10
})
```

Result:

```json
{
  "files": [
    {
      "name": "invoice_2026_08_11.pdf",
      "path": "C:\\Users\\User\\Documents\\invoice_2026_08_11.pdf",
      "modified": "2026-08-11T18:20:00"
    }
  ]
}
```

---

# 13. WINDOWS PROCESS TOOLS

Implement controlled process management:

```text
process.list
process.find
process.launch
process.close
process.focus
process.isRunning
```

Examples:

```text
"Open Chrome."

→ process.launch("chrome")
```

```text
"Close WhatsApp."

→ process.find("WhatsApp")
→ process.close(...)
```

Never allow unrestricted process termination by default.

---

# 14. APPLICATION MANAGEMENT

Create an application registry.

Example:

```json
{
  "chrome": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "vscode": "...",
  "whatsapp": "...",
  "notepad": "..."
}
```

Allow discovery.

The agent should be able to say:

```text
"What applications are installed?"
```

and query the application registry.

---

# 15. WINDOWS UI AUTOMATION

Use Windows UI Automation / accessibility APIs where possible.

Potential technologies:

- Windows UI Automation
- pywinauto
- WinAppDriver-compatible concepts where appropriate
- PowerShell/native Windows APIs
- Tauri/Rust native bindings

The system should be able to inspect:

```text
Windows
Applications
Buttons
Text fields
Menus
Tabs
Tree views
Lists
Controls
```

Instead of relying exclusively on screen coordinates.

Example:

```text
find_control({
  application: "WhatsApp",
  role: "textbox",
  name: "Search"
})
```

Then:

```text
click_control()
type_text()
```

This is substantially more reliable than:

```text
click(532, 211)
```

---

# 16. MOUSE AND KEYBOARD AUTOMATION

Implement fallback tools:

```text
mouse.move
mouse.click
mouse.doubleClick
mouse.rightClick
mouse.scroll
keyboard.type
keyboard.press
keyboard.hotkey
keyboard.keyDown
keyboard.keyUp
```

These tools must have strict safety boundaries.

Do not allow the model to generate arbitrary low-level mouse/keyboard loops without limits.

Include:

```text
maximum action count
timeout
cancel support
```

---

# 17. SCREEN CAPTURE

Implement:

```text
screen.capture
screen.captureWindow
screen.getActiveWindow
screen.getResolution
```

Screenshots should be available to the vision model when necessary.

Example:

```text
User:
"Why isn't the application working?"

Agent:
1. Inspect active window
2. Capture screenshot
3. Send screenshot to vision model
4. Understand visible error
5. Take appropriate action
```

---

# 18. COMPUTER VISION

Vision is a fallback mechanism.

The agent should use vision when:

- UI accessibility information is unavailable
- An application exposes a canvas
- A website has unpredictable UI
- A visual state must be inspected
- The user explicitly asks what is on screen

Pipeline:

```text
Screenshot
    ↓
Resize / optimize
    ↓
Vision model
    ↓
UI interpretation
    ↓
Structured action
    ↓
Execution
```

Do not ask the vision model to directly execute actions.

It should return structured observations.

---

# 19. BROWSER AUTOMATION

Use:

**Playwright**

Implement:

```text
browser.launch
browser.close
browser.goto
browser.back
browser.forward
browser.refresh
browser.click
browser.type
browser.select
browser.press
browser.extractText
browser.screenshot
browser.find
browser.download
browser.upload
```

Browser automation should be DOM-first.

Only fall back to visual automation when necessary.

---

# 20. WHATSAPP AUTOMATION

The agent should support WhatsApp as an automation target.

Possible implementation:

```text
WhatsApp Desktop
```

or:

```text
WhatsApp Web + Playwright
```

The implementation must be modular because WhatsApp UI can change.

Potential tools:

```text
whatsapp.open
whatsapp.searchContact
whatsapp.openConversation
whatsapp.typeMessage
whatsapp.attachFile
whatsapp.send
whatsapp.verifyConversation
```

Example:

```text
User:
"Send invoice.pdf to Charles."

Agent:

1. Find invoice.pdf
2. Resolve "Charles"
3. Present ambiguity if multiple Charles contacts exist
4. Open WhatsApp
5. Open Charles conversation
6. Attach invoice.pdf
7. Verify recipient
8. Send
9. Verify send state
```

Do NOT automatically send sensitive files to an ambiguous contact.

---

# 21. CONTACT RESOLUTION

Natural language contact names need resolution.

Example:

```text
"Charles"
```

could correspond to:

```text
Charles
Charles Johnson
Charles - Work
Charles O.
```

Create:

```text
contact.resolve
```

The system should score possible matches.

If confidence is low:

```text
"I found three Charles contacts. Which one do you mean?"
```

Never guess when an external action is about to happen.

---

# 22. TERMINAL / SHELL TOOLS

The agent should eventually be able to work with:

```text
PowerShell
CMD
Git
npm
pnpm
yarn
Python
Node
Docker
```

But shell execution must be treated as **high risk**.

Implement:

```text
terminal.execute
terminal.getWorkingDirectory
terminal.listProcesses
```

The tool should have:

```text
command validation
timeout
output limit
working directory
environment isolation
approval policy
```

Never expose an unrestricted:

```text
exec(anything)
```

tool to the LLM.

---

# 23. DEVELOPER MODE

Because this agent is intended for a programmer, create a special developer capability.

Examples:

```text
"Open my SkoolConnect project."
"Run the tests."
"Check the build."
"Find where this error is coming from."
"Search the project for Supabase."
"Create a component for this."
"Run git status."
"Show me the last commit."
```

Potential tools:

```text
project.detect
project.open
code.search
code.read
code.edit
terminal.execute
git.status
git.diff
git.log
git.branch
```

Code modification should have confirmation policies depending on the action.

---

# 24. AGENT MEMORY

Implement local memory.

The agent should eventually remember:

```text
favorite applications
common folders
known contacts
project locations
preferred browser
common workflows
user preferences
previous tasks
```

Example:

```text
User:
"Open my main project."

Agent:
"What project do you mean?"

User:
"SkoolConnect."

Agent:
"Understood."

Memory:
SkoolConnect → C:\Users\...\SkoolConnectNG
```

Next time:

```text
"Open my main project."

→ SkoolConnectNG
```

Memory should be editable and deletable.

Do not store secrets in normal memory.

---

# 25. LOCAL MEMORY STORAGE

Use SQLite initially.

Recommended:

```text
SQLite
+
Drizzle ORM
```

Possible tables:

```text
users_preferences
projects
applications
contacts
memories
tasks
tool_executions
conversation_sessions
```

Do not use a cloud database for core local memory.

The computer agent should work even without a remote backend except where an external AI API is required.

---

# 26. OPTIONAL VECTOR MEMORY

Do not introduce vector databases immediately.

Only add semantic memory when needed.

Possible future technologies:

```text
SQLite + vector extension
LanceDB
Chroma
Qdrant local
```

First prove the system with structured memory.

---

# 27. AGENT ORCHESTRATOR

This is the heart of the application.

Create:

```text
src/agent/
├── agent.ts
├── planner.ts
├── executor.ts
├── verifier.ts
├── context.ts
├── state-machine.ts
├── permissions.ts
├── recovery.ts
└── task-manager.ts
```

Agent states:

```text
IDLE
LISTENING
TRANSCRIBING
UNDERSTANDING
PLANNING
AWAITING_CONFIRMATION
EXECUTING
OBSERVING
VERIFYING
RECOVERING
COMPLETED
FAILED
CANCELLED
```

---

# 28. TASK EXECUTION MODEL

Every user request becomes a task.

Example:

```json
{
  "id": "task_123",
  "instruction": "Send the latest invoice to Charles",
  "status": "planning",
  "steps": []
}
```

The planner generates a plan.

Example:

```text
1. Search for recent invoice files.
2. Select best candidate.
3. Resolve Charles.
4. Open WhatsApp.
5. Open conversation.
6. Attach file.
7. Verify recipient.
8. Send.
9. Verify.
```

The executor performs each step.

The verifier checks the result.

---

# 29. VERIFICATION IS MANDATORY

Never assume an action succeeded.

Bad:

```text
click Send
→ "Done."
```

Good:

```text
click Send
→ inspect UI
→ confirm message appears in conversation
→ confirm attachment/message state
→ report success
```

For filesystem:

```text
copy_file()
→ verify destination exists
→ verify file size/hash if appropriate
```

For process:

```text
launch()
→ verify process is running
```

For browser:

```text
navigate()
→ verify URL/title
```

For terminal:

```text
execute()
→ inspect exit code
→ inspect output
```

---

# 30. RECOVERY SYSTEM

The agent must recover from failures.

Example:

```text
Action:
Open WhatsApp

Result:
WhatsApp is not installed.

Recovery:
Search for WhatsApp Web/browser session.

If available:
Continue through browser.

Otherwise:
Tell user.
```

Another example:

```text
Click "Send"

Result:
Button not found.

Recovery:

1. Inspect current UI.
2. Search accessibility tree.
3. Take screenshot.
4. Re-plan.
5. Retry.

Maximum retries: 2–3.
```

Never loop indefinitely.

---

# 31. PERMISSION SYSTEM

Create explicit permission levels.

```text
READ
WRITE
EXTERNAL
DESTRUCTIVE
SYSTEM
```

Examples:

### READ

```text
List files
Read metadata
Take screenshot
Read clipboard
Inspect processes
```

### WRITE

```text
Copy
Move
Create
Rename
Edit
```

### EXTERNAL

```text
Send WhatsApp message
Send email
Upload file
Post online
```

### DESTRUCTIVE

```text
Delete
Uninstall
Overwrite
Terminate process
```

### SYSTEM

```text
Registry
Drivers
Security settings
Firewall
System configuration
```

---

# 32. CONFIRMATION POLICY

The agent should not ask for confirmation for every trivial operation.

Instead:

```text
LOW RISK
→ automatic

MEDIUM RISK
→ automatic if clearly reversible

HIGH RISK
→ confirmation

DESTRUCTIVE / EXTERNAL
→ confirmation unless explicitly configured otherwise
```

Examples:

```text
"Open Chrome."
→ execute

"Create folder."
→ execute

"Delete this folder."
→ confirm

"Send this file to Charles."
→ confirm unless trusted workflow is explicitly enabled

"Transfer money."
→ always confirm
```

---

# 33. USER INTERRUPT

The user must always be able to interrupt.

Commands:

```text
"Stop."
"Cancel."
"Abort."
"Wait."
```

Also provide a physical keyboard shortcut.

Example:

```text
CTRL + SHIFT + SPACE
```

for emergency stop.

Emergency stop should:

```text
stop current automation
release mouse/keyboard control
cancel pending tool execution
return agent to listening/idle
```

---

# 34. GLOBAL HOTKEY

The application should support a global shortcut.

Example:

```text
Ctrl + Shift + Space
```

Behavior:

```text
idle → listening
listening → cancel
executing → emergency stop
```

Make the shortcut configurable.

---

# 35. SYSTEM TRAY

The agent should live in the Windows system tray.

Tray states:

```text
Idle
Listening
Thinking
Executing
Needs Confirmation
Error
```

Right-click menu:

```text
Open Agent
Start Listening
Pause
Stop Current Task
Settings
Permissions
Logs
Memory
Exit
```

---

# 36. UI

Keep the UI minimal.

Main interface:

```text
┌────────────────────────────────────────┐
│ SAMIX AGENT                       ●     │
├────────────────────────────────────────┤
│                                        │
│            🎙                           │
│                                        │
│           Listening                    │
│                                        │
│  "Send the invoice to Charles."        │
│                                        │
├────────────────────────────────────────┤
│ Task                                   │
│                                        │
│ ✓ Searching files                      │
│ ✓ Found invoice.pdf                    │
│ ✓ Opening WhatsApp                     │
│ ● Waiting for confirmation             │
│                                        │
├────────────────────────────────────────┤
│ [ Stop ]                    [ Settings ]│
└────────────────────────────────────────┘
```

Do not turn this into a generic chatbot UI.

The application is an **agent console**, not a chat application.

---

# 37. OBSERVABILITY

Every tool execution must be logged.

Example:

```json
{
  "timestamp": "...",
  "taskId": "...",
  "tool": "filesystem.search",
  "input": "...",
  "result": "success",
  "durationMs": 124
}
```

Logs must support:

```text
debug
info
warn
error
audit
```

Sensitive values must be redacted.

Never log:

```text
API keys
passwords
tokens
private messages
full credentials
```

unless explicitly required and securely stored.

---

# 38. SECURITY

Security is critical because this application can control the user's computer.

Implement:

### Secret storage

Use:

```text
Windows Credential Manager
```

or a secure OS-level secret store.

Do not store API keys in:

```text
localStorage
plain JSON
SQLite plaintext
source code
```

`.env` may be used during development but should not be the production secret mechanism.

---

# 39. PATH SECURITY

The filesystem tool should prevent dangerous accidental access.

Examples of sensitive paths:

```text
Windows system directories
credential stores
browser profile secrets
SSH private keys
.env files
password databases
```

The system should have configurable policies.

---

# 40. COMMAND SECURITY

Never give the LLM unrestricted PowerShell.

Instead:

```text
terminal.execute
```

must pass through:

```text
CommandPolicy
    ↓
Parse command
    ↓
Check allowed executable
    ↓
Check arguments
    ↓
Check working directory
    ↓
Permission decision
    ↓
Execute
```

Dangerous commands should require confirmation.

Examples:

```text
Remove-Item -Recurse
Format-Volume
diskpart
reg delete
cipher
shutdown
```

must not execute silently.

---

# 41. NETWORK SECURITY

The agent may need network access for:

```text
LLM APIs
browser
web search
updates
external APIs
```

But network capabilities should be explicit.

Avoid creating an unnecessary local HTTP server exposed to the LAN.

If a local service is required:

```text
bind to 127.0.0.1
```

not:

```text
0.0.0.0
```

unless explicitly required.

---

# 42. LOCAL-FIRST ARCHITECTURE

The application should remain functional without a cloud backend.

Cloud dependencies should be limited to:

```text
LLM API
optional TTS
optional web services
optional external APIs
```

Local capabilities:

```text
filesystem
computer control
memory
screenshots
application discovery
task history
permissions
settings
```

should remain local.

---

# 43. OFFLINE MODE

Eventually support a fully local mode.

Potential local models:

```text
Llama-family models
Qwen-family models
Mistral-family models
Gemma-family models
```

Potential local inference runtimes:

```text
Ollama
llama.cpp
vLLM where appropriate
```

Speech:

```text
faster-whisper
```

This is a future phase, not a blocker for MVP.

---

# 44. CONFIGURATION

Use a configuration file such as:

```text
%APPDATA%/SamixAgent/config.json
```

Configuration:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "configured-model"
  },
  "voice": {
    "enabled": true,
    "provider": "whisper"
  },
  "automation": {
    "mode": "controlled"
  },
  "hotkey": "CTRL+SHIFT+SPACE",
  "tts": {
    "enabled": true
  }
}
```

Never commit credentials.

---

# 45. PROJECT STRUCTURE

Recommended project:

```text
samix-agent/
│
├── apps/
│   └── desktop/
│
├── src/
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── planner.ts
│   │   ├── executor.ts
│   │   ├── verifier.ts
│   │   ├── recovery.ts
│   │   ├── permissions.ts
│   │   ├── state-machine.ts
│   │   └── context.ts
│   │
│   ├── ai/
│   │   ├── provider.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── local.ts
│   │   └── router.ts
│   │
│   ├── voice/
│   │   ├── microphone.ts
│   │   ├── stt.ts
│   │   ├── tts.ts
│   │   └── vad.ts
│   │
│   ├── tools/
│   │   ├── filesystem/
│   │   ├── process/
│   │   ├── applications/
│   │   ├── windows/
│   │   ├── keyboard/
│   │   ├── mouse/
│   │   ├── screen/
│   │   ├── browser/
│   │   ├── whatsapp/
│   │   ├── terminal/
│   │   └── index.ts
│   │
│   ├── memory/
│   │   ├── database.ts
│   │   ├── memories.ts
│   │   └── projects.ts
│   │
│   ├── security/
│   │   ├── permissions.ts
│   │   ├── secrets.ts
│   │   └── command-policy.ts
│   │
│   ├── observability/
│   │   ├── logger.ts
│   │   └── audit.ts
│   │
│   └── shared/
│       ├── types.ts
│       ├── events.ts
│       └── constants.ts
│
├── src-tauri/
│   ├── src/
│   ├── capabilities/
│   └── tauri.conf.json
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── tools/
│   └── agent/
│
├── scripts/
├── docs/
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

Adapt this structure where necessary rather than blindly following it.

---

# 46. EVENT SYSTEM

Use an internal event bus.

Events:

```text
agent.started
agent.listening
agent.transcription.started
agent.transcription.completed
agent.thinking
agent.plan.created
tool.started
tool.completed
tool.failed
permission.required
confirmation.required
task.completed
task.failed
task.cancelled
agent.error
```

This allows the UI to update in real time.

---

# 47. STREAMING

The LLM response should stream where supported.

The user should see:

```text
Thinking...
```

and tool execution states immediately.

Do not wait until an entire long task completes before updating the UI.

---

# 48. TASK TIMELINE

Display execution history:

```text
Task: Send invoice to Charles

16:03:21  Listening
16:03:23  Transcribed
16:03:24  Planning
16:03:25  Searching files
16:03:26  Found invoice.pdf
16:03:27  Resolving contact
16:03:28  Charles Johnson selected
16:03:30  Opening WhatsApp
16:03:33  Attaching file
16:03:35  Awaiting confirmation
16:03:39  Sending
16:03:41  Verified
16:03:41  Completed
```

---

# 49. TOOL RESULT DESIGN

Every tool should return structured results.

Example:

```typescript
type ToolResult = {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  metadata?: {
    durationMs?: number;
  };
};
```

Do not return random strings from tools unless necessary.

Structured results make agent reasoning more reliable.

---

# 50. TOOL ERRORS

Use machine-readable errors:

```text
FILE_NOT_FOUND
PERMISSION_DENIED
APP_NOT_FOUND
WINDOW_NOT_FOUND
ELEMENT_NOT_FOUND
TIMEOUT
CONTACT_AMBIGUOUS
ACTION_BLOCKED
USER_CANCELLED
NETWORK_ERROR
VERIFICATION_FAILED
```

The planner can then recover intelligently.

---

# 51. NATURAL LANGUAGE UNDERSTANDING

The system must not require rigid commands.

All of these should mean approximately the same thing:

```text
"Open Chrome."

"Launch Chrome."

"Start my browser."

"Can you open Chrome for me?"
```

The LLM handles semantic interpretation.

The tools handle execution.

---

# 52. MULTI-STEP COMMANDS

Support compound commands.

Example:

> "Open my Downloads folder, find the latest PDF, rename it to invoice.pdf and move it to my Documents folder."

The planner should break this into:

```text
1. Identify Downloads
2. Search PDFs
3. Sort by modified date
4. Select latest
5. Rename
6. Move
7. Verify
```

---

# 53. CONTEXTUAL COMMANDS

The agent should understand context.

Example:

User:

> "Open WhatsApp."

Agent:

> "Done."

User:

> "Find Charles."

Agent:

> "I found Charles Johnson."

User:

> "Send him the PDF on my desktop."

The agent should resolve:

```text
him = Charles Johnson
the PDF = relevant PDF on Desktop
```

without forcing the user to repeat context.

---

# 54. SCREEN CONTEXT

Support commands like:

```text
"What is this error?"
"Click the button I am pointing at."
"Close this popup."
"Why is this red?"
"Open the menu on the left."
```

These require screenshot/vision/UI automation.

Implement later than filesystem and browser tools.

---

# 55. AGENT MODES

Implement:

```text
SAFE
CONTROLLED
AUTONOMOUS
DEVELOPER
```

### SAFE

Read-only.

### CONTROLLED

Normal automation with confirmation for external/destructive actions.

### AUTONOMOUS

Allows trusted workflows to run with fewer confirmations.

### DEVELOPER

Enables advanced coding and terminal tools.

Default:

```text
CONTROLLED
```

---

# 56. AUTONOMOUS WORKFLOW

Example:

```text
User:
"Every morning, prepare my development environment."

Possible workflow:

1. Open VS Code.
2. Open project.
3. Pull latest changes.
4. Install dependencies if needed.
5. Run tests.
6. Report failures.
```

Future feature.

Do not implement scheduled automation before the basic agent is reliable.

---

# 57. SCHEDULER

Future feature:

```text
scheduler.create
scheduler.delete
scheduler.list
```

Examples:

```text
"Every weekday at 8am, open my work apps."
```

Use Windows Task Scheduler or the local application scheduler.

---

# 58. CLIPBOARD

Implement:

```text
clipboard.read
clipboard.write
clipboard.clear
```

The agent should understand clipboard context.

Example:

```text
"Take what I copied and put it into Notepad."
```

---

# 59. DRAG AND DROP

Eventually support:

```text
drag(file, target)
```

But prefer structured operations.

Do not use drag-and-drop when:

```text
filesystem.move()
```

can achieve the same result.

---

# 60. DOWNLOAD MANAGEMENT

Browser tool should expose downloads.

Example:

```text
"Download the PDF and move it into my project folder."
```

Pipeline:

```text
browser.download
→ filesystem.waitForFile
→ filesystem.move
→ verify
```

---

# 61. APPLICATION CONTEXT

The agent should know:

```text
active application
active window
current URL
current directory
clipboard
selected text
```

This should become part of context.

Example:

```json
{
  "activeApplication": "Visual Studio Code",
  "activeWindow": "SkoolConnectNG",
  "currentDirectory": "C:\\Projects\\SkoolConnectNG"
}
```

---

# 62. CONTEXT WINDOW MANAGEMENT

Do not continuously send enormous histories to the LLM.

Use:

```text
recent conversation
current task
relevant memory
current state
tool results
```

Summarize old context.

Keep context cost controlled.

---

# 63. COST MANAGEMENT

If using cloud LLM APIs:

- Do not send screenshots unnecessarily.
- Do not send full files unnecessarily.
- Do not repeatedly send entire task histories.
- Cache stable information.
- Use cheaper models for simple classification where appropriate.
- Use stronger models for complex planning.

Possible model routing:

```text
simple command → fast model
complex task → powerful model
vision → vision-capable model
code reasoning → coding-capable model
```

---

# 64. FILE CONTENT HANDLING

The agent should eventually be able to understand:

```text
TXT
PDF
DOCX
XLSX
CSV
JSON
XML
YAML
MD
code files
```

Use specialized parsers rather than blindly sending binary files to the LLM.

Examples:

```text
PDF → text extraction
DOCX → python-docx
XLSX → openpyxl
CSV → parser
JSON → native parser
```

Only introduce this after basic automation works.

---

# 65. DOWNLOAD / INSTALLATION MANAGEMENT

Future capability:

```text
"Install Node.js."

"Download this application."

"Update VS Code."
```

These actions are dangerous.

Require confirmation.

The agent should never silently install arbitrary software.

---

# 66. UPDATE SYSTEM

The final application should support updates.

Potential:

```text
Tauri updater
```

The application can eventually check for:

```text
new version
```

and ask the user before installing.

---

# 67. CRASH RECOVERY

If the agent crashes during a task:

```text
restart
→ detect unfinished task
→ mark previous task as interrupted
→ do NOT blindly resume dangerous operations
```

For safe/reversible tasks, it may offer:

```text
"An interrupted task was found. Resume?"
```

---

# 68. TESTING STRATEGY

Do not test the agent only manually.

### Unit tests

Test:

```text
planner
permissions
tool schemas
filesystem
memory
command policy
contact resolution
```

### Integration tests

Test:

```text
LLM → tool → result → planner
```

### End-to-end tests

Test actual Windows operations.

Examples:

```text
Create temp directory
→ agent finds it
→ copies file
→ verifies copy
```

Never run destructive tests against real user data.

---

# 69. TEST SANDBOX

Create:

```text
tests/sandbox/
```

All automated filesystem tests should operate inside:

```text
C:\SamixAgentTestSandbox
```

or an equivalent temporary directory.

The test agent must never receive access to arbitrary production directories.

---

# 70. MVP PHASES

Do not attempt the complete vision in one implementation pass.

## PHASE 1 — Foundation

Build:

```text
Tauri
React
TypeScript
system tray
settings
logging
configuration
```

Success:

```text
Application launches as a Windows app.
```

---

## PHASE 2 — Voice

Implement:

```text
microphone
speech-to-text
listening state
voice activity
transcription
```

Success:

User says:

> "Hello."

UI displays:

```text
Hello
```

---

## PHASE 3 — LLM

Implement:

```text
Anthropic provider
tool calling
agent loop
streaming
```

Success:

User says:

> "What is the current date?"

Agent answers.

---

## PHASE 4 — Filesystem

Implement:

```text
list
search
copy
move
rename
create
metadata
```

Success:

> "Find my latest PDF and copy it to Desktop."

Agent performs it.

---

## PHASE 5 — Applications

Implement:

```text
application discovery
launch
focus
close
```

Success:

> "Open VS Code."

---

## PHASE 6 — Browser

Implement Playwright.

Success:

> "Open Chrome and search for Next.js."

---

## PHASE 7 — UI Automation

Implement:

```text
Windows UI Automation
screen capture
keyboard
mouse
```

Success:

> "Close this popup."

---

## PHASE 8 — WhatsApp

Implement:

```text
contact resolution
conversation navigation
file attachment
message sending
verification
```

Success:

> "Send this PDF to Charles."

---

## PHASE 9 — Memory

Implement:

```text
SQLite
projects
contacts
preferences
task history
```

---

## PHASE 10 — Developer Agent

Implement:

```text
terminal
Git
VS Code
code search
project management
build/test execution
```

---

## PHASE 11 — Vision

Implement:

```text
screenshot
vision model
UI interpretation
visual actions
```

---

## PHASE 12 — Advanced Autonomy

Implement:

```text
multi-step planning
recovery
long-running tasks
scheduling
workflows
local models
offline mode
```

---

# 71. FIRST DEMONSTRATION TARGET

Before adding advanced features, the project must demonstrate this exact workflow:

```text
User launches SAMIX Agent.

Agent automatically starts listening.

User says:

"Find the latest PDF in my Downloads folder,
copy it to my Desktop,
and tell me when you're done."

Agent:

1. Understands request.
2. Finds Downloads.
3. Searches PDFs.
4. Determines latest.
5. Copies the file.
6. Verifies destination.
7. Reports completion.

Voice response:

"Done. I copied invoice.pdf to your Desktop."
```

Then implement:

```text
"Open WhatsApp and send that file to Charles."
```

with confirmation before sending.

This becomes the first serious end-to-end milestone.

---

# 72. DEVELOPMENT RULES FOR CLAUDE CODE

Claude Code must follow these rules:

1. Do not generate the entire application blindly in one pass.
2. Build in tested increments.
3. Before adding a subsystem, inspect the existing architecture.
4. Keep interfaces modular.
5. Prefer native/structured APIs over GUI clicking.
6. Use GUI automation only when necessary.
7. Never give the LLM unrestricted shell access.
8. Never bypass the permission system.
9. Never hard-code secrets.
10. Write tests for important tools.
11. Use TypeScript strict mode.
12. Keep tool input/output strongly typed.
13. Handle Windows-specific paths correctly.
14. Support cancellation everywhere.
15. Add timeouts to external operations.
16. Never create infinite agent loops.
17. Every external/destructive operation requires a policy decision.
18. Every important operation should be verified.
19. Keep logs useful but redact secrets.
20. Do not introduce unnecessary dependencies.
21. Prefer small modules with clear responsibilities.
22. Document architectural decisions.
23. Keep the application responsive during automation.
24. Do not block the UI thread.
25. Never pretend an operation succeeded if it was not verified.

---

# 73. CODING STANDARD

Use:

```text
TypeScript strict mode
ESLint
Prettier
Vitest
Playwright
Zod
```

Where appropriate.

Use Zod for validating:

```text
tool inputs
configuration
LLM structured outputs
IPC payloads
```

Example:

```typescript
const CopyFileSchema = z.object({
  source: z.string(),
  destination: z.string(),
});
```

---

# 74. TYPES

Centralize shared types.

Example:

```typescript
type AgentState =
  | "idle"
  | "listening"
  | "thinking"
  | "planning"
  | "executing"
  | "verifying"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";
```

Avoid:

```typescript
any
```

unless genuinely unavoidable.

---

# 75. IPC

Tauri frontend/backend communication must be typed.

Do not expose arbitrary native commands.

Bad:

```text
runCommand(command: string)
```

Better:

```text
launchApplication(appId)
copyFile(source, destination)
getActiveWindow()
captureScreen()
```

Every IPC capability should be explicit.

---

# 76. UI RESPONSIVENESS

Automation must run outside the UI thread.

Long-running tasks must expose:

```text
progress
status
cancellation
errors
```

The UI should never freeze while the agent is working.

---

# 77. AGENT LOOP PSEUDOCODE

Conceptually:

```typescript
while (task.status !== "completed") {
  const context = await buildContext(task);

  const decision = await agent.plan(context);

  if (decision.requiresConfirmation) {
    await requestConfirmation(decision);
  }

  const result = await executeTool(decision.tool);

  task.addResult(result);

  if (!result.success) {
    const recovery = await agent.recover(result);

    if (!recovery) {
      task.fail();
      break;
    }
  }

  const verified = await verifier.check(task);

  if (verified) {
    task.complete();
  }
}
```

This is conceptual only.

Implement a robust state machine rather than an uncontrolled recursive loop.

---

# 78. AGENT TOOL LOOP

The fundamental runtime pattern:

```text
User Request
    ↓
LLM
    ↓
Tool Call
    ↓
Permission Check
    ↓
Tool Execution
    ↓
Tool Result
    ↓
LLM
    ↓
Another Tool Call
    ↓
...
    ↓
Verification
    ↓
Final Response
```

This is the core of the entire project.

---

# 79. EXAMPLE TASK

Input:

```text
"Go to my folder in This PC, copy this file and send it to Charles on WhatsApp."
```

Agent interpretation:

```text
Intent:
Transfer a file to a WhatsApp contact.

Required capabilities:
- filesystem navigation
- file identification
- file copy
- WhatsApp automation
- contact resolution
- external action confirmation
```

Plan:

```text
1. Determine referenced folder.
2. Determine referenced file.
3. Validate file exists.
4. Copy file if explicitly requested.
5. Resolve Charles.
6. If ambiguous, ask user.
7. Open WhatsApp.
8. Open Charles conversation.
9. Attach file.
10. Confirm recipient.
11. Ask confirmation before sending if required by policy.
12. Send.
13. Verify.
14. Report.
```

---

# 80. PRONOUN / REFERENCE RESOLUTION

Support:

```text
this file
that file
the previous file
the one I just downloaded
my project
my browser
him
her
there
here
that folder
```

Use current task context + computer state + memory.

Example:

```text
User:
"Open the PDF."

Agent:
Opens invoice.pdf.

User:
"Move it to Desktop."

"it" = invoice.pdf.
```

---

# 81. COMPUTER STATE SNAPSHOT

Before planning, optionally collect:

```text
active window
active application
clipboard metadata
current working directory
recently created files
recently modified files
open browser tabs
```

Do not collect everything on every command.

Use only relevant state.

---

# 82. PRIVACY PRINCIPLE

The agent should not continuously send the user's entire screen, files, microphone audio, or private data to the cloud.

Use minimal necessary context.

For example:

```text
User asks:
"Copy this file."

No screenshot is required.
```

For:

```text
"What's this error?"
```

A screenshot may be necessary.

---

# 83. VOICE PRIVACY

Audio should be processed locally when possible.

The microphone should clearly indicate:

```text
LISTENING
```

When recording.

Provide a global way to disable microphone access.

---

# 84. SETTINGS

Settings should include:

```text
AI Provider
AI Model
API Key / authentication
Microphone
Voice activation
TTS
Hotkey
Automation mode
Permissions
Trusted applications
Trusted folders
Memory
Logs
Privacy
Startup behavior
```

---

# 85. TRUSTED FOLDERS

Allow the user to define:

```text
Trusted folders
```

Example:

```text
C:\Users\User\Documents
C:\Users\User\Desktop
C:\Projects
```

The agent can operate more freely within trusted locations.

Outside trusted locations, request permission.

---

# 86. TRUSTED APPLICATIONS

Allow:

```text
VS Code
Chrome
WhatsApp
Terminal
Notepad
```

to be configured as trusted applications.

Do not automatically trust unknown applications.

---

# 87. STARTUP

Future option:

```text
Start SAMIX Agent with Windows
```

When enabled:

```text
Windows startup
→ agent launches minimized to tray
→ waits for hotkey or voice activation
```

Do not automatically enable this during development.

---

# 88. INSTALLER

Eventually produce:

```text
SAMIX-Agent-Setup.exe
```

Installer should:

```text
install application
create Start Menu shortcut
optionally create desktop shortcut
optionally enable startup
install required runtime dependencies
configure permissions
```

---

# 89. BUILD TARGET

The final application should produce:

```text
Windows executable
```

The user should be able to double-click it.

No terminal required.

---

# 90. PERFORMANCE

The application should remain lightweight when idle.

Target:

```text
low CPU while idle
low memory overhead
fast wake-up
minimal background activity
```

Do not continuously run expensive vision inference.

---

# 91. LATENCY TARGET

Target approximate experience:

```text
Wake/listening
< 500ms

Speech transcription
1–3 seconds depending on model

Simple command planning
< 2 seconds

Simple filesystem action
< 1 second

Browser/UI actions
depends on application/network
```

Do not sacrifice correctness purely for speed.

---

# 92. LOGGING EXAMPLE

```text
[16:04:01] INFO Agent started
[16:04:02] INFO Microphone initialized
[16:04:03] INFO Listening
[16:04:07] INFO User command received
[16:04:08] INFO Planning task
[16:04:09] INFO Tool: filesystem.search
[16:04:09] INFO Search completed
[16:04:10] INFO Tool: filesystem.copy
[16:04:10] INFO Copy verified
[16:04:10] INFO Task completed
```

---

# 93. FAILURE EXAMPLE

If the file does not exist:

```text
User:
"Send invoice.pdf to Charles."

Agent:
"I couldn't find invoice.pdf in the locations I searched. I haven't sent anything."
```

Never hallucinate success.

---

# 94. AMBIGUITY EXAMPLE

If there are multiple Charles contacts:

```text
"I found three contacts matching Charles:

1. Charles Johnson
2. Charles O.
3. Charles - Work

Which one should I use?"
```

The system must pause.

---

# 95. DESTRUCTIVE ACTION EXAMPLE

User:

```text
"Delete this folder."
```

Agent:

```text
"This will permanently delete 184 files from:
C:\Projects\old-project

Proceed?"
```

Then wait.

---

# 96. EXTENSIBILITY

The tool system must allow plugins.

Future tools:

```text
gmail
slack
discord
telegram
notion
github
figma
docker
aws
azure
vercel
supabase
```

Each integration should be a separate module.

The core agent should not know implementation details.

---

# 97. FUTURE MOBILE / REMOTE CONTROL

Do not implement initially.

Potential future architecture:

```text
Phone
  ↓
Secure connection
  ↓
SAMIX Agent on PC
  ↓
Computer
```

This would allow:

> "Turn on my PC and open my project."

But security requirements become much more serious.

---

# 98. FUTURE MULTI-AGENT ARCHITECTURE

Do not implement initially.

Possible future agents:

```text
Supervisor Agent
     │
 ┌───┼────┬─────┐
 ▼   ▼    ▼     ▼
File Browser Code  Web
Agent Agent Agent Agent
```

But the first version should use **one orchestrator with tools**.

Do not over-engineer.

---

# 99. WHAT NOT TO BUILD FIRST

Do NOT begin with:

```text
multi-agent swarm
vector database
full offline LLM
complex memory
facial recognition
wake-word training
remote control
mobile app
distributed architecture
cloud backend
```

First prove:

```text
voice → LLM → tools → computer → verification
```

---

# 100. FIRST BUILD COMMAND FOR CLAUDE CODE

Claude Code should first inspect the environment.

Determine:

```text
Node version
npm/pnpm availability
Rust
Cargo
Tauri prerequisites
Python
Git
PowerShell
Windows version
available microphones
```

Then create the project.

Do not start writing business logic until the environment is understood.

---

# 101. IMPLEMENTATION ORDER

Claude Code should follow this order:

```text
1. Environment inspection
2. Project initialization
3. Tauri desktop shell
4. React UI
5. Configuration system
6. Logging
7. Agent state machine
8. LLM provider abstraction
9. Anthropic integration
10. Tool registry
11. Filesystem tools
12. Process/application tools
13. Voice input
14. Agent loop
15. Verification
16. Permission system
17. Keyboard emergency stop
18. Browser automation
19. Windows UI Automation
20. WhatsApp
21. Memory
22. Developer tools
23. Vision
24. Packaging
25. Installer
```

---

# 102. DEFINITION OF DONE — MVP

The MVP is considered successful when:

### Launch

```text
Double-click executable
→ application starts
→ microphone becomes available
```

### Voice

```text
Speak naturally
→ reliable transcription
```

### AI

```text
Natural language
→ correct tool selection
```

### Files

```text
Find
Copy
Move
Rename
Create
Verify
```

### Applications

```text
Open
Focus
Close
```

### Safety

```text
Dangerous operations require confirmation.
```

### Verification

```text
Agent verifies successful operations.
```

### Cancellation

```text
User can stop any running task.
```

### UI

```text
User can see what the agent is doing.
```

---

# 103. DEFINITION OF DONE — ADVANCED VERSION

The advanced agent should eventually be capable of:

```text
Voice interaction
Natural language commands
Multi-step planning
Computer control
File management
Browser automation
WhatsApp automation
Application management
Terminal operations
Codebase interaction
Screen understanding
Vision
Memory
Context awareness
Error recovery
Permission management
Scheduled workflows
Local model support
Offline speech
System tray
Global hotkeys
Windows installer
Automatic updates
```

---

# 104. THE PRODUCT PHILOSOPHY

The product should feel like:

> "My computer understands what I want and does it."

Not:

> "I have a chatbot that tells me how to do things."

The user's mental model should be:

```text
I speak.
The computer acts.
The agent verifies.
```

---

# 105. NON-NEGOTIABLE ENGINEERING PRINCIPLES

### Principle 1 — Tools over magic

Give the AI explicit capabilities.

### Principle 2 — APIs over pixels

Use APIs whenever possible.

### Principle 3 — Verify everything important

Never assume success.

### Principle 4 — Fail safely

When uncertain, stop and ask.

### Principle 5 — Local-first

The user's computer remains the primary environment.

### Principle 6 — Modular

Any LLM provider or automation engine should be replaceable.

### Principle 7 — Observable

The user should know what the agent is doing.

### Principle 8 — Interruptible

The user remains in control.

### Principle 9 — Secure by default

Computer control is powerful and must be constrained.

### Principle 10 — Build progressively

A reliable five-tool agent is more valuable than a broken fifty-tool agent.

---

# 106. FINAL CLAUDE CODE INSTRUCTION

You are acting as the principal software engineer for this project.

Do not merely create a prototype that looks convincing.

Build the actual underlying system.

When implementing:

1. Inspect the existing repository before making changes.
2. Create a clear architecture.
3. Implement one subsystem at a time.
4. Test each subsystem.
5. Run lint/type checks.
6. Run relevant tests.
7. Fix errors before moving forward.
8. Keep security boundaries explicit.
9. Keep tools modular.
10. Never expose unrestricted system execution to the LLM.
11. Never claim an operation succeeded without verification.
12. Preserve existing working functionality when extending the system.
13. Prefer stable, maintained libraries.
14. Use official SDKs/APIs where available.
15. Keep Windows support as the primary target.
16. Explain major architectural decisions in code comments/docs.
17. Maintain a `TODO.md` for future capabilities.
18. Maintain `CHANGELOG.md`.
19. Maintain `README.md` with setup and development instructions.
20. At the end of each implementation phase, provide:
    - what was built
    - files changed
    - dependencies added
    - tests performed
    - known limitations
    - next recommended phase

Do not skip directly to advanced autonomous computer control.

Build the foundation first.

The first objective is:

```text
LAUNCH APP
    ↓
LISTEN
    ↓
UNDERSTAND VOICE
    ↓
CALL A TOOL
    ↓
PERFORM REAL WINDOWS ACTION
    ↓
VERIFY ACTION
    ↓
SPEAK/SHOW RESULT
```

Once that loop works reliably, expand the toolset.

---

# 107. END STATE

The ultimate goal is a Windows-native personal computer agent that can receive natural voice instructions and safely perform real operations across the user's computer.

The user should eventually be able to say:

> "Prepare everything I need for today's work."

And the agent should understand the user's environment, inspect the required context, open applications, prepare projects, retrieve files, perform routine operations, interact with websites and applications, recover from normal errors, and report exactly what it did.

The computer remains the execution environment.

The AI is the reasoning layer.

The tool system is the bridge.

The verification system is the safety net.

The user remains the authority.

**Build toward that architecture from the first line of code.**
