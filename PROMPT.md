# U2OS — Personal Digital Agent Platform

You are a senior software architect and implementation agent. Build a working application called **U2OS**.

U2OS is a persistent personal digital agent inspired by James Burke’s description of an “online digital you” in the *Connections 3* episode **“Feedback.”**

This is not intended to be another chatbot.

The core concept is:

> **Observe → remember → anticipate → act → observe outcome → learn.**

U2OS should behave like a persistent digital counterpart that understands the user's life, communications, schedule, projects, relationships, preferences, commitments, and routines; can proactively surface useful information; and can perform authorized actions on the user's behalf.

The system must remain user-controlled. Personal data and memory should be local-first wherever practical, integrations should be replaceable, and consequential actions must pass through an explicit policy/authorization layer.

---

# Product concept

Think of U2OS as:

> **The operating system for your digital self.**

The user should be able to talk naturally to their agent, but voice/chat is only one interface into the system.

The actual product consists of:

* identity
* memory
* event history
* relationships
* projects
* goals
* commitments
* tools
* permissions
* automation
* models
* generated user interfaces
* feedback from outcomes

The LLM is replaceable infrastructure.

**The agent is not the model.**

---

# High-level architecture

Implement the system around the following architecture:

```text
                        ┌───────────────────┐
                        │       User        │
                        │ voice / text / UI │
                        └─────────┬─────────┘
                                  │
                         ┌────────▼────────┐
                         │ Personal Agent  │
                         │  LLM / planner  │
                         └────────┬────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │        Policy Engine       │
                    │                           │
                    │ read freely               │
                    │ draft freely              │
                    │ ask before consequential  │
                    │ actions                   │
                    └─────────────┬─────────────┘
                                  │
        ┌─────────────────────────┼───────────────────────────┐
        │                         │                           │
 ┌──────▼──────┐          ┌───────▼────────┐         ┌────────▼───────┐
 │ Personal    │          │ Event / Task    │         │ Tool / Action │
 │ Memory      │          │ Engine          │         │ Layer         │
 │             │          │                 │         │               │
 │ people      │          │ timers          │         │ email         │
 │ preferences │          │ triggers        │         │ calendar      │
 │ history     │          │ recurring jobs  │         │ contacts      │
 │ projects    │          │ conditions      │         │ banking       │
 │ commitments │          │ follow-ups      │         │ shopping      │
 └──────┬──────┘          └───────┬────────┘         │ browser       │
        │                         │                  │ phone/SMS      │
        └─────────────┬───────────┘                  └───────┬────────┘
                      │                                      │
                ┌─────▼──────────────────────────────────────▼───┐
                │              Personal Event Log                │
                │                                               │
                │ email received / meeting / purchase / call /  │
                │ conversation / location / document / decision │
                └───────────────────────────────────────────────┘
```

The **event log is fundamental**.

Do not build the application around a chat transcript.

The application should instead consume events such as:

```text
email.received
email.sent
calendar.event_added
calendar.event_changed
calendar.event_approaching
task.created
task.completed
task.overdue
contact.birthday_approaching
message.received
document.created
document.changed
project.changed
commitment.made
purchase.completed
subscription.renewing
package.shipped
location.changed
agent.action.completed
agent.action.failed
user.feedback
```

Every event should be persisted.

The agent evaluates relevant events by effectively asking:

```text
Does the user need to know about this?

Does the user need to do something about this?

Can I take care of this myself?

Should I prepare something for the user to approve?

Does this change anything I know about the user?

Does this affect an existing person, project, task, goal,
commitment, preference, or future event?
```

---

# Technical philosophy

Prefer a simple, durable architecture.

Use:

* modern HTML
* CSS
* vanilla JavaScript
* Web Components
* ES modules
* browser standards
* REST where appropriate
* WebSocket or SSE for realtime updates
* SQLite initially
* JSON for portable structured data

Avoid:

* React unless absolutely necessary
* large frontend frameworks
* unnecessary transpilation
* unnecessary build systems
* needless external dependencies
* framework-specific abstractions when browser APIs suffice

The frontend should ideally run directly as standard browser modules with no compilation step.

A lightweight server implementation may use whichever backend language best suits the task, but keep clear boundaries between services.

Design interfaces so components can later be rewritten independently in Rust, Go, Python, PHP, etc.

---

# Core subsystems

Implement U2OS as a collection of loosely coupled services/modules.

## 1. Event Bus

Create a normalized internal event format.

Example:

```json
{
  "id": "evt_...",
  "type": "email.received",
  "timestamp": "2026-09-17T10:30:00-07:00",
  "source": "gmail",
  "actor": {
    "type": "person",
    "id": "person_123"
  },
  "subject": {
    "type": "message",
    "id": "msg_456"
  },
  "data": {},
  "metadata": {}
}
```

All integrations publish normalized events.

Consumers may subscribe to event types.

Support:

* realtime event delivery
* persisted history
* replay
* filters
* event correlation
* event provenance
* derived events

---

# 2. Personal Memory

Memory must be structured rather than simply dumping conversation transcripts into a vector database.

Support entities such as:

```text
Person
Organization
Project
Goal
Task
Commitment
Preference
Place
Document
Conversation
Event
Routine
Asset
Account
Topic
```

Relationships must be first-class.

Example:

```text
Chris
 ├── works_on → U2OS
 ├── knows → Sarah
 ├── promised → send proposal
 ├── prefers → morning meetings
 └── interested_in → voice AI
```

Every remembered fact should ideally include:

* value
* source
* timestamp
* confidence
* last confirmed
* provenance
* whether inferred or explicitly stated

Never silently turn weak inference into permanent fact.

Allow memory to be:

* inspected
* corrected
* deleted
* exported

---

# 3. Agent / Planner

Create a model abstraction so any suitable LLM can be used.

Example interface:

```javascript
agent.plan(context, objective)
agent.respond(context, message)
agent.evaluateEvent(event, context)
agent.summarize(items)
agent.extractEntities(content)
```

Support cloud and local models later.

The planner should return structured proposed actions rather than directly executing arbitrary commands.

Example:

```json
{
  "reasoning_summary": "The meeting conflicts with another appointment.",
  "actions": [
    {
      "tool": "calendar.reschedule",
      "arguments": {
        "event_id": "abc",
        "new_time": "..."
      }
    }
  ]
}
```

The planner proposes.

The policy engine authorizes.

The tool layer executes.

---

# 4. Policy Engine

This is mandatory.

No LLM may directly bypass it.

Implement autonomy levels:

```text
LEVEL 0 — Observe
Inform the user.

LEVEL 1 — Recommend
Suggest an action.

LEVEL 2 — Prepare
Draft or prepare the action.

LEVEL 3 — Confirm
Action requires explicit confirmation.

LEVEL 4 — Delegated autonomy
Act automatically within configured limits.

LEVEL 5 — Domain autonomy
Manage an explicitly delegated domain.
```

Policies should support per-domain configuration.

Example:

```yaml
email:
  read: always
  draft: always

  send:
    friends: autonomous
    business: confirm
    legal: never

calendar:
  create: autonomous

  reschedule:
    personal: autonomous
    interviews: confirm

payments:
  under_50: confirm
  over_50: never
```

The system must maintain an audit log of:

```text
who requested an action
what requested it
what model proposed it
which policy evaluated it
whether approval was required
who approved it
what tool executed it
the result
```

---

# 5. Tool / Action Layer

Create a generic tool interface.

Example:

```javascript
class Tool {
    get schema() {}
    async execute(args, context) {}
}
```

Initial tools should include mock/demo versions of:

```text
email.search
email.read
email.draft
email.send

calendar.list
calendar.create
calendar.reschedule

contacts.search

tasks.list
tasks.create
tasks.complete

web.search

notifications.send
```

Design connectors so Gmail, Google Calendar, Google Contacts, Microsoft, etc. can later plug in without changing the agent.

Do not hardwire provider-specific logic into the planner.

---

# 6. Voice / Presence Layer

The agent should support natural full-duplex voice interaction.

However:

**Do not send all detected speech directly to the LLM.**

Implement this pipeline:

```text
                   microphone
                       │
              ┌────────▼────────┐
              │ echo cancellation│
              │ noise reduction  │
              │ VAD              │
              └────────┬─────────┘
                       │
              ┌────────▼────────┐
              │  diarization    │
              │                 │
              │ speaker 0       │
              │ speaker 1       │
              │ speaker 2       │
              └────────┬─────────┘
                       │
              ┌────────▼─────────────┐
              │ speaker verification │
              │                      │
              │ speaker 0 = owner    │
              │ speaker 1 = unknown  │
              │ speaker 2 = TV       │
              └────────┬─────────────┘
                       │
                authorization
                       │
             ┌─────────▼──────────┐
             │ speech recognition │
             │       + agent      │
             └─────────┬──────────┘
                       │
                  tool actions
```

Use browser/WebRTC functionality where useful:

```javascript
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
});
```

Support integration with STT systems such as Deepgram.

Diarization answers:

> Which speaker said this?

Speaker verification answers:

> Is this the owner?

Do not confuse those two concepts.

Maintain metadata like:

```json
{
  "text": "Move my meeting to Friday",
  "speaker": {
    "cluster": 0,
    "identity": "owner",
    "similarity": 0.96
  },
  "authorized": true
}
```

Speech from other people may still be retained as conversational context when appropriate, but **must not automatically carry authority to execute commands.**

---

# 7. Voice Enrollment / Speaker Authentication

Create a setup workflow allowing the owner to enroll their voice.

Generate a speaker embedding from several spoken samples.

Conceptually:

```text
voice enrollment
      ↓
speaker embedding
      ↓
stored owner voiceprint
```

For incoming speech:

```text
speech
  ↓
embedding
  ↓
similarity comparison
  ↓
speaker identity/confidence
```

Support different confidence thresholds for different operations.

Example:

```text
voice confidence >= 0.70
normal conversation

voice confidence >= 0.85
messages / calendar / home automation

voice confidence >= 0.95
private personal information

financial / legal / destructive actions
require another confirmation mechanism
```

Voice identity is one signal, not absolute authentication.

---

# 8. Prevent the Agent From Hearing Itself

Implement acoustic echo cancellation.

Because U2OS generated its own TTS output, keep the outgoing audio reference available to the echo cancellation layer.

Support interruption/barge-in.

Desired interaction:

```text
U2OS:
"You have a meeting today at—"

User:
"Hang on."

U2OS immediately stops speaking and listens.
```

Do not simply disable the microphone whenever TTS plays unless used as an initial fallback.

---

# 9. Task / Trigger Engine

The agent must operate when the user is not actively talking to it.

Support:

```text
one-time timers
recurring schedules
event triggers
condition watches
follow-ups
delayed actions
event-driven rules
```

Example:

```text
WHEN email.received
IF sender == recruiter
THEN notify owner prominently
```

Or:

```text
WHEN calendar.event_approaching
AT 60 minutes before event
GENERATE briefing
```

Or:

```text
WHEN commitment.made
IF no task exists
CREATE task
```

---

# 10. Dynamic Dashboard System

The UI must not be limited to predefined static dashboards.

The agent should be able to generate **contextual dashboard layouts dynamically**.

Examples:

Morning:

```text
Today's schedule
important email
tasks
weather
reminders
people to follow up with
projects needing attention
```

Before a meeting:

```text
person profile
previous correspondence
recent documents
meeting agenda
open commitments
relevant notes
suggested talking points
```

Travel:

```text
flight
weather
hotel
map
calendar
documents
packing reminders
local contacts
```

Project work:

```text
current status
Git activity
tasks
documents
decisions
blockers
next actions
```

Do not allow the LLM to directly generate arbitrary executable HTML/JavaScript.

Instead create a safe component schema.

For example:

```json
{
  "title": "Morning Briefing",
  "layout": "dashboard",
  "components": [
    {
      "type": "schedule",
      "source": "calendar.today"
    },
    {
      "type": "task-list",
      "source": "tasks.priority"
    },
    {
      "type": "email-summary",
      "source": "email.important"
    }
  ]
}
```

The frontend renders this using trusted Web Components.

Create components such as:

```text
<u2-dashboard>
<u2-card>
<u2-schedule>
<u2-email-summary>
<u2-task-list>
<u2-person>
<u2-project>
<u2-timeline>
<u2-photo-grid>
<u2-document>
<u2-map>
<u2-chart>
<u2-alert>
<u2-approval>
<u2-conversation>
<u2-agent-status>
```

The LLM can compose interfaces from these primitives.

This gives U2OS the ability to effectively invent the right UI for the current problem without executing model-generated frontend code.

---

# 11. Primary Interface

Build a polished responsive application.

Desktop layout:

```text
┌──────────────┬───────────────────────────────────┬─────────────────┐
│              │                                   │                 │
│ Navigation   │       Dynamic Workspace           │ Agent           │
│              │                                   │ Conversation    │
│ Home         │ generated dashboards              │                 │
│ Briefing     │ cards                             │ voice status    │
│ Memory       │ documents                         │ transcript      │
│ Mail         │ images                            │ suggestions     │
│ Calendar     │ people                            │ approvals       │
│ Tasks        │ projects                          │                 │
│ Projects     │ timelines                         │                 │
│ Dashboards   │                                   │                 │
│              │                                   │                 │
└──────────────┴───────────────────────────────────┴─────────────────┘
```

The interface should feel like an operating environment rather than a SaaS admin dashboard.

Use dark and light themes.

Voice status must always be visually clear:

```text
idle
listening
owner speaking
other speaker
thinking
acting
speaking
waiting for approval
```

The UI should make it obvious **who the system believes is speaking**.

Example:

```text
● Chris — 96%
○ Unknown speaker
```

---

# 12. Morning Briefing

Make this a flagship workflow.

The goal is not to bombard the user with information.

The purpose is to reduce information load.

Generate something like:

```text
Good morning.

There are four things worth your attention.

1. Your 10:00 meeting moved to 10:30.

2. A recruiter responded last night. They want to schedule
   another conversation. I've found three openings in your calendar.

3. Project X has two new issues. One appears reproducible and
   I've prepared a proposed fix.

4. Your insurance renews Friday and increased by $184.
   I've flagged it for review.

Everything else can wait.
```

The agent should emphasize:

```text
important
unexpected
actionable
time-sensitive
related to commitments
```

rather than merely summarizing everything it can find.

---

# 13. Approval UI

Actions requiring confirmation should produce a consistent approval component.

Example:

```text
┌───────────────────────────────────────────┐
│ U2OS wants to send an email               │
│                                           │
│ To: Jane Smith                            │
│ Subject: Meeting Friday                   │
│                                           │
│ [Preview]                                 │
│                                           │
│ Reason: You asked me to reschedule.       │
│                                           │
│      [Cancel]          [Approve]           │
└───────────────────────────────────────────┘
```

Approval should display:

* intended action
* affected resource
* reason
* model/tool requesting it
* policy that caused confirmation
* consequences when relevant

---

# 14. Agent Activity

Create a visible activity stream.

Example:

```text
10:31 Read calendar
10:31 Detected scheduling conflict
10:31 Checked Sarah's availability
10:32 Prepared alternative times
10:32 Waiting for your approval
```

The system should never feel like it is mysteriously doing things behind the user's back.

---

# 15. Burke Demo Acceptance Test

Use James Burke's fictional agent as an explicit milestone.

The prototype should eventually demonstrate equivalents of:

```text
give morning briefing

remember birthdays and anniversaries

schedule meetings

coordinate calendars

handle reminders

surface account/budget anomalies

research relevant information

prepare documents

understand personal preferences

learn from behavior and feedback
```

For potentially dangerous integrations such as banking, initially implement simulations/mocks rather than real financial transactions.

The architecture should nonetheless support those domains later through the policy system.

---

# 16. Local-first data

Store the user's core identity and personal model locally wherever practical.

Suggested structure:

```text
~/.u2os/

    config/
    identity/
    memory/
    people/
    projects/
    preferences/
    commitments/
    events/
    credentials/
    policies/
    cache/
```

The implementation may instead use SQLite internally, but preserve this logical organization.

Cloud services may hold source data such as Gmail or Google Calendar.

The **relationship model connecting everything together belongs to the user.**

---

# 17. Security

Treat security as architecture, not cleanup.

Implement:

* encrypted credentials
* least-privilege connectors
* explicit scopes
* action audit logs
* policy enforcement outside the LLM
* clear approval boundaries
* no arbitrary model-generated shell commands
* no direct model access to secrets
* provenance for memory
* deletion/export controls
* rate limits for actions
* confirmation for destructive operations

Assume model output may sometimes be wrong or maliciously influenced.

Never rely on prompts alone as a security boundary.

---

# 18. Development strategy

Build incrementally.

Do not try to implement every integration at once.

## Phase 1 — Core platform

Implement:

```text
event bus
SQLite persistence
event log
basic entity/memory store
tool registry
policy engine
LLM abstraction
agent conversation
basic UI shell
```

Use mocked integrations.

Acceptance test:

```text
User speaks/types request
→ agent creates structured action
→ policy engine evaluates
→ approval UI appears if required
→ mock tool executes
→ event is logged
→ UI updates
```

---

## Phase 2 — Dynamic UI

Implement:

```text
dashboard schema
Web Component renderer
dynamic dashboard generation
morning briefing
approval cards
agent activity feed
```

Acceptance test:

The agent can examine current context and create a useful dashboard from trusted UI components.

---

## Phase 3 — Real integrations

Add:

```text
Google Calendar
Gmail
Google Contacts
task system
web search
notifications
```

Normalize all provider events into the U2OS event model.

---

## Phase 4 — Voice

Implement:

```text
microphone input
VAD
STT
TTS
full-duplex interaction
barge-in
echo cancellation
speaker diarization
speaker identity metadata
```

---

## Phase 5 — Speaker verification

Implement:

```text
voice enrollment
speaker embeddings
identity confidence
owner-only command authorization
speaker-aware transcripts
```

Test with:

```text
owner
second person
television
music
agent's own TTS
```

The owner's commands should work.

Other voices should not gain owner authority.

---

## Phase 6 — Proactive agent

Implement event-driven reasoning.

Examples:

```text
new email
upcoming meeting
overdue commitment
calendar conflict
project activity
birthday
renewal
important message
```

The agent should determine whether to:

```text
ignore
remember
notify
recommend
prepare
request approval
act
```

---

## Phase 7 — Feedback loop

After actions occur, record outcomes.

Examples:

```text
suggestion accepted
suggestion rejected
email edited before sending
meeting recommendation ignored
task postponed
dashboard card dismissed
notification marked useful
```

Use feedback to improve future prioritization and behavior.

Do not automatically modify security or authorization policies based on learned behavior.

---

# Repository organization

Use a structure similar to:

```text
u2os/

    server/
        api/
        agent/
        events/
        memory/
        policy/
        tools/
        integrations/
        voice/

    public/
        index.html

        components/
            u2-app.js
            u2-dashboard.js
            u2-card.js
            u2-agent.js
            u2-approval.js
            u2-schedule.js
            u2-task-list.js
            u2-person.js
            u2-timeline.js

        services/
            api.js
            events.js
            audio.js

        styles/
            base.css
            themes.css

    data/

    tests/

    docs/
        architecture.md
        events.md
        tools.md
        policies.md
        dashboards.md
        voice.md

    README.md
```

Adapt this where necessary, but preserve clear module boundaries.

---

# Engineering requirements

Write understandable production-quality code.

Prefer:

```text
small modules
explicit interfaces
documented schemas
standard protocols
testable components
few dependencies
progressive enhancement
```

Avoid giant files and monolithic controllers.

Every major subsystem should have unit tests.

Every external integration should have a mock provider.

Provide useful logging.

Add seed/demo data so the application is interesting immediately after starting it.

---

# Demo persona

Create realistic demo data demonstrating:

```text
calendar events
email
projects
tasks
people
birthdays
commitments
photos
documents
agent activity
pending approvals
```

The initial UI should look alive rather than empty.

---

# Important product principles

Always follow these principles.

### 1. Reduce cognitive load

Do not create another notification firehose.

The agent should decide what is worth interrupting the user about.

### 2. Ask for outcomes, not workflows

The user should be able to say:

```text
"Handle scheduling with Sarah."
```

rather than manually navigating three applications.

### 3. Maintain user agency

The system may recommend and prepare aggressively.

Consequential actions must honor user-configured authority levels.

### 4. Models are replaceable

Do not let model-provider APIs become the architecture.

### 5. UI is generated from trusted primitives

The LLM may compose interfaces.

It may not execute arbitrary generated frontend code.

### 6. Memory has provenance

The system should know why it believes something.

### 7. Voice identity is context and authorization

A microphone hearing a sentence does not mean the owner said it.

### 8. Everything produces events

Events are the connective tissue of U2OS.

---

# First implementation task

Start by inspecting the repository if one already exists.

Then create:

1. `docs/architecture.md`
2. the application skeleton
3. the event model
4. SQLite schema
5. the event bus
6. tool registry
7. policy engine
8. mock tools
9. basic agent abstraction
10. Web Component application shell
11. dynamic dashboard schema
12. realistic demo data

Build an end-to-end vertical slice before adding more integrations.

The first working scenario should be:

```text
User:
"Move my 2 PM meeting with Sarah to tomorrow afternoon."

             ↓

Agent identifies intent.

             ↓

Agent queries mock calendar tool.

             ↓

Agent proposes calendar.reschedule.

             ↓

Policy engine determines confirmation is required.

             ↓

UI displays proposed action.

             ↓

User approves.

             ↓

Calendar tool performs the action.

             ↓

calendar.event_changed event is emitted.

             ↓

Event log records the entire sequence.

             ↓

Dashboard immediately updates.

             ↓

Agent confirms completion.
```

Once this works cleanly, proceed through the phases above.

Do not fake completed functionality.

If a component is mocked, label it clearly.

At the end of each phase:

* run tests
* fix failures
* update documentation
* commit the completed phase
* summarize architectural decisions
* identify technical debt before continuing

The objective is not to produce a flashy AI demo.

The objective is to create the foundation for a **persistent, trustworthy, proactive digital self** that can eventually implement and exceed James Burke's 1997 vision of the personal electronic agent.

# 19. Deployment Architecture

U2OS is fundamentally a **persistent local service**, not a desktop application.

Do not architect the core application around Electron, Tauri, a browser tab, or any single operating system.

The primary runtime should be a long-running U2OS server/daemon:

```text
                         Internet
                            │
                 External APIs / Services
                            │
                            ▼
                 ┌────────────────────┐
                 │       U2OS         │
                 │                    │
                 │ Agent / Events     │
                 │ Memory / Policies  │
                 │ Automations        │
                 │ Local AI Models    │
                 │ Connectors         │
                 │                    │
                 │ SQLite / Data      │
                 └─────────┬──────────┘
                           │
                     Local network
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
 Desktop Browser       Phone / PWA       Voice Satellite
        │                  │                  │
        └────────────── u2os.local ───────────┘
```

The U2OS server should continue operating when:

* no browser is open
* the user's laptop sleeps
* the user is not actively interacting with it
* scheduled tasks execute
* external events arrive
* automations trigger

The browser UI is a **client of U2OS**, not U2OS itself.

---

# 20. Headless Operation

The core server must support completely headless operation.

It should be possible to install U2OS on:

```text
Linux server
Raspberry Pi
mini PC
NAS
home server
Mac
Windows PC
Docker host
future U2OS hardware appliance
```

The application must not assume the machine running U2OS has:

* a display
* keyboard
* microphone
* speakers
* desktop environment

Input/output devices may be remote clients.

---

# 21. Supported Deployment Targets

Design toward these installation targets:

```text
Docker / Docker Compose
Linux + systemd
macOS + launchd
Windows Service
NAS / home server
Raspberry Pi / ARM Linux
preconfigured U2OS appliance
```

Do not require different application implementations for each platform.

Platform-specific code should be isolated behind adapters.

The web application should remain identical across deployments.

---

# 22. Local Web Application

The primary UI should be served directly by the U2OS server.

Example:

```text
http://u2os.local/
```

or:

```text
https://u2os.local/
```

Support:

* desktop browsers
* tablets
* phones
* installable PWA behavior
* responsive layouts
* realtime updates via WebSocket or SSE

Do not wrap the complete application in Electron merely to create a desktop application.

If native desktop functionality is eventually required, implement a **small optional native companion process** rather than moving the entire architecture into a desktop wrapper.

Potential companion functionality may include:

```text
global hotkey
system-wide microphone access
wake word detection
screen/context capture with permission
native notifications
OS integrations
local application control
```

The native companion communicates with the U2OS server through documented APIs.

---

# 23. One Agent, Many Terminals

The user's U2OS instance represents one persistent digital identity.

Devices are interfaces to that identity.

Conceptually:

```text
                       U2OS
                   persistent agent
                       memory
                       identity
                       policies
                          │
          ┌───────────────┼───────────────┐
          │               │               │
        phone           laptop        home voice
          │               │             device
          │               │               │
          └───────────────┼───────────────┘
                          │
                      same agent
```

Do not create independent agent memories per client device.

Sessions may contain device-specific context, but persistent identity, memory, policies, events, and commitments belong to the central U2OS instance.

---

# 24. Voice Satellites

Design the voice subsystem so microphones and speakers do not need to exist on the U2OS server itself.

Support a future concept called a **U2OS Satellite**.

A satellite is a lightweight client containing some combination of:

```text
microphone array
speaker
echo cancellation
VAD
wake-word detection
speaker identification
presence sensors
status indicators
```

The satellite streams relevant audio/events to the U2OS server.

Architecture:

```text
        Bedroom Satellite
               │
        Kitchen Satellite
               │
        Phone microphone
               │
               ▼
        ┌──────────────┐
        │     U2OS     │
        │              │
        │ one agent    │
        │ one memory   │
        │ one identity │
        └──────────────┘
```

Keep the protocol between satellite and server documented and implementation-independent.

Do not require proprietary hardware.

---

# 25. Local-First Is a Product Requirement

Local-first operation is not merely an optimization.

It is a fundamental U2OS product principle.

The system should remain useful without a U2OS-operated cloud service.

Core capabilities must not require:

```text
a U2OS account
a U2OS subscription
U2OS cloud storage
U2OS-hosted AI inference
vendor-controlled authentication
```

Users should be able to self-host the complete core product.

---

# 26. Optional Cloud Services

Architect cloud functionality as optional services layered on top of the local system.

Potential optional services include:

```text
encrypted remote access relay
encrypted offsite backup
push notification relay
device discovery
SMS delivery
hosted STT/TTS fallback
hosted LLM fallback
dynamic DNS
certificate management
multi-location synchronization
```

If a user does not subscribe to or use these services, they should be able to substitute alternatives such as:

```text
Tailscale
WireGuard
Cloudflare Tunnel
personal VPN
S3-compatible storage
their own SMTP server
their own model APIs
local inference
```

Do not create architectural dependencies on U2OS-operated infrastructure.

---

# 27. Bring Your Own AI

U2OS must support user-provided model infrastructure.

Create provider abstractions supporting combinations such as:

```text
OpenAI
Anthropic
Google
Deepgram
ElevenLabs
Ollama
llama.cpp
local OpenAI-compatible endpoints
future providers
```

Provider credentials belong to the user.

The architecture must permit:

```text
cloud LLM + local STT
local LLM + cloud STT
fully local operation
multiple models selected by task
fallback providers
```

Do not assume one model performs every task.

For example:

```text
small local model
    → classification

embedding model
    → memory retrieval

specialized voice model
    → STT

large reasoning model
    → complex planning

local model
    → private/simple requests
```

Model routing should eventually be policy-driven.

---

# 28. Offline and Degraded Operation

U2OS should degrade gracefully when internet access disappears.

Local functionality should continue when possible:

```text
memory lookup
local dashboards
local tasks
local calendar cache
local automation
local models
local voice processing
local smart-home control
event recording
```

External actions should be queued or marked unavailable rather than silently failing.

Example:

```text
email.send
→ queued: network unavailable
```

When connectivity returns, policy rules determine whether queued actions may still execute.

---

# 29. Connector and Skill Architecture

Treat integrations as installable **skills/connectors**, not hard-coded product features.

A skill should expose:

```text
manifest
capabilities
tool schemas
event schemas
permissions
configuration
health status
```

Conceptual structure:

```text
skills/

    gmail/
        manifest.json
        tools/
        events/

    google-calendar/
        manifest.json
        tools/
        events/

    github/
        manifest.json

    home-assistant/
        manifest.json
```

The core U2OS agent should discover capabilities dynamically.

This architecture should eventually support third-party skills without modifications to U2OS core.

Skills must declare permissions explicitly.

---

# 30. No Mandatory Vendor Lock-In

Users must be able to export their U2OS identity and personal data.

Provide or plan for export of:

```text
events
people
relationships
preferences
projects
commitments
tasks
policies
agent configuration
memory provenance
```

Use documented, portable formats where practical.

A user should be able to reinstall U2OS on different hardware and restore their digital self.

The user's data must never become trapped solely because a commercial U2OS service ceases to exist.

---

# 31. Appliance Readiness

Although initial development targets ordinary computers and Docker, maintain compatibility with a future plug-and-play appliance.

Conceptually:

```text
┌─────────────────────────────┐
│          U2OS Home          │
│                             │
│ persistent local agent      │
│ personal memory             │
│ model inference             │
│ automation                  │
│ connector services          │
│ encrypted storage           │
└──────────────┬──────────────┘
               │
             LAN/WiFi
```

The appliance should require little or no system administration.

Initial onboarding should be possible entirely through the browser:

```text
1. Plug in device
2. Visit u2os.local
3. Create owner identity
4. Connect accounts
5. Configure AI providers
6. Enroll voice
7. Configure policies
8. Begin using U2OS
```

Do not make appliance-specific assumptions in core code.

---

# 32. Commercial Architecture Constraint

Design the technical architecture so the following can coexist without forks:

```text
U2OS Community
    self-hosted / open-source

U2OS packaged distribution
    polished installers

U2OS appliance
    preconfigured hardware

optional U2OS cloud services
    convenience infrastructure

third-party skills
    integration ecosystem
```

Feature design must not intentionally cripple the self-hosted edition merely to force adoption of commercial services.

Commercial offerings should primarily monetize:

```text
convenience
hardware
support
managed infrastructure
premium integrations
professional setup
```

rather than ownership of the user's personal data.

---

# 33. Deployment Development Order

After the existing Phase 2, add an explicit deployment milestone.

## Deployment Phase

Produce:

```text
Dockerfile
docker-compose.yml

Linux service configuration

local network discovery
    u2os.local via mDNS where available

persistent data directory

configuration system

backup/export command

health endpoint

structured logs
```

Acceptance test:

```text
Fresh machine
    ↓
install/start U2OS
    ↓
visit u2os.local
    ↓
complete onboarding
    ↓
close browser
    ↓
U2OS continues operating
    ↓
scheduled event occurs
    ↓
event is processed
    ↓
reopen browser
    ↓
activity appears in history
```

This behavior is mandatory.

The browser must never be responsible for running persistent agent logic.

