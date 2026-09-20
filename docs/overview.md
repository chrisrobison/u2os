# What U2OS is

U2OS is **the operating system for your digital self**: a persistent, local-first, user-owned agent that sits across your calendar, email, contacts, tasks, and projects, and runs as a durable loop —

> observe → remember → anticipate → act → observe outcome → learn.

It is deliberately not "a chatbot." A chat window is one interface into it, not the product. The product is the standing state underneath: an event history, structured memory of people and commitments, a policy engine that decides what it's allowed to do on its own, a registry of tools it can call, generated interfaces, and a feedback loop that makes it better at prioritizing over time.

## Why it exists

Most AI assistants today are stateless request/response boxes: you open a chat, it has no continuity with yesterday, no standing knowledge of your actual commitments, and no real authority to act even when it clearly understands what needs to happen. Close the tab and it forgets you existed.

U2OS starts from a different premise, closer to James Burke's description of an "online digital you" in *Connections³*: a counterpart that persists whether or not you're looking at it, keeps a real history of what's happened in your life, notices things worth noticing, and can actually do something about them when you've told it it's allowed to. The model doing the reasoning is the least durable part of that picture — everything else (the event log, the memory, the policies, the tools, the automations) is the actual system, and is what U2OS is built around.

## Philosophy

A few decisions run through the whole design, not just individual features:

- **The agent is not the model.** Model providers are swappable infrastructure behind a router, not the architecture. A deterministic mock provider is the default specifically so the rest of the system stays testable and useful offline, with real providers as an opt-in upgrade.
- **The event log is the spine, not the chat transcript.** Everything — an email arriving, a meeting changing, a task going overdue, a user request — is normalized into the same event stream. Conversation is just one entry point into that stream, not the data model.
- **User-owned and local-first.** Your data lives on your machine, under your control, not in a vendor cloud. You bring your own accounts and API keys to any connector you enable; there is no U2OS-operated service in the middle of your data.
- **Policy lives outside the model.** The agent can read and draft freely, but a separate policy engine — not the model's own judgment — decides what requires your explicit approval and what's blocked outright. Feedback history and voice confidence can inform prioritization; neither can loosen an authorization decision.
- **Memory has provenance.** The system should always be able to say *why* it believes something about you, not just assert it.
- **Generated UI, not generated code.** The agent composes dashboards from a fixed set of trusted, pre-built components. It never gets to hand the browser arbitrary HTML or JavaScript to execute.
- **Devices expose capabilities; agents express intent.** The agent never picks a specific camera, display, or phone — it asks for `image.capture` or `present()` and a deterministic resolver (never the model) chooses an eligible device based on trust, ownership, and privacy. A browser tab, a physical sensor, and an existing service connector are all just "a provider of some capability" to this resolver, with no special-casing (see [Devices and capabilities](devices.md)).
- **Reduce cognitive load instead of adding to it.** The goal isn't another notification firehose. You should be able to say "handle scheduling with Sarah" and have the agent work the actual calendars, rather than being handed three more apps to babysit yourself.

## How it's meant to be used

U2OS runs as a persistent background service, not a page you keep open — closing the browser doesn't stop connector syncing, triggers, or the agent's own reasoning. You point it at as much or as little of your real life as you're comfortable with: leave it on demo/mock data to explore safely, or connect real Google Calendar, Gmail, Contacts, and other accounts once you trust it.

Day to day, the intended shape is: it assembles morning/meeting/project dashboards from what's actually going on, proposes and drafts actions on your behalf, stops and asks before anything consequential, and quietly gets better at judging what's worth your attention as it observes how you respond over time. It's built for one owner's digital life at a time, not as multi-tenant software — see the security notes in the top-level [README](../README.md) before you ever consider exposing an instance beyond your own machine.

## Where this stands today

U2OS is a working pre-alpha prototype, not a finished product. It implements the phases described in [PROMPT.md](../PROMPT.md) (the original product specification) as tested, working vertical slices — real event log, real policy enforcement, real (if limited) connectors, a real approval flow, and a real device/capability subsystem (registry, resolver, a realtime device bus, policy-gated presentation, a management UI, an enforced trust lifecycle, streams, and one unified service — see [Devices and capabilities](devices.md)) — but plenty is still simplified, mocked, or missing. For what's actually implemented today, start with the [README](../README.md); for how it's built, see [Architecture](architecture.md); for what's next, see [PLAN.md](../PLAN.md).
