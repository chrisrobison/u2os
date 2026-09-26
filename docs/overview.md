# What U2OS is

U2OS is **the operating system for your digital self**. It consolidates who you are into a set of **files you own**, and a persistent, local-first service **acts on your behalf** within the authority you delegate. It runs as a durable loop:

> observe → remember → anticipate → act → observe outcome → learn.

It is deliberately not a chatbot. A chat window is one way in, not the product. The product is:

- **your vault**: plain Markdown files describing you, your people, projects, commitments and standing routines
- the **machinery** that lets a system act on that knowledge safely: an event history, a policy engine, durable action delivery, a privacy policy and explainable outcomes

## Why it exists

Most AI assistants are stateless request/response boxes. They have no continuity with yesterday, no standing knowledge of your commitments, and no real authority to act. Where they do remember, the memory lives in the vendor's product: you cannot read it, correct it, or take it with you.

U2OS starts from James Burke's description of an "online digital you" in *Connections³*: a counterpart that persists whether or not you are looking at it, knows what matters in your life, notices things worth noticing, and can do something about them when you have allowed it to. Two consequences follow:

1. **The digital you must be yours, as files.** If U2OS disappeared tomorrow, your vault would still be a readable, useful description of your life. You can edit it in any editor, keep it in git, and point another tool at it.
2. **The model is the least durable part.** Models are swappable infrastructure. The vault, the policies and the history are the system.

## Philosophy

- **The vault is the self; the agent is a tool.** Owner-authored knowledge lives in files, and U2OS indexes it. SQLite holds that index plus runtime state, and vault-sourced memory can be rebuilt from the files ([ADR 0007](adr/0007-owned-vault-is-the-digital-self.md)).
- **It acts on your behalf, not only when asked.** [Routines](routines.md) are standing instructions in your own words ("every weekday at 7, brief me", "when a recruiter emails, draft a reply"). They run unattended through the same path as every other action.
- **Policy lives outside the model.** The agent can read and draft freely. A separate policy engine, not the model's judgement, decides what needs your approval and what is blocked. Routines, feedback history and voice confidence can never loosen that.
- **Privacy is separate from permission.** Every fact has a classification, and a data-processing policy decides what may reach a local or remote model, independently of what actions are allowed.
- **Memory has provenance.** U2OS can always say *why* it believes something: which file, which email, which inference.
- **Everything is a normalized event.** Email arriving, a meeting changing, a routine firing and a chat message are the same kind of thing. Conversation is one entry point, not the data model.
- **Local-first and user-owned.** No U2OS-operated service sits in the middle of your data. You bring your own accounts, model endpoints and keys.
- **Generated UI, not generated code.** Dashboards are composed from trusted components, and the model never hands the browser arbitrary HTML or JavaScript.
- **Devices expose capabilities; agents express intent.** The agent asks for `present()` or `image.capture`, and a deterministic resolver, never the model, chooses an eligible device ([devices](devices.md)).
- **Reduce cognitive load.** The goal is fewer things to babysit, not another notification firehose.

## How it's meant to be used

1. **Write down your digital self.** Start with `me.md` and a few people, projects and commitments in the vault ([format](vault.md)), or export what an existing install already knows with `npm run vault:export`.
2. **Connect what you're comfortable with.** Calendar, mail, contacts and search are optional; so is a remote model, since a local one works. Use a separate demo home to explore safely first ([demo](demo.md)).
3. **Delegate with routines.** Write the standing instructions you want carried out ([routines](routines.md)). U2OS runs them on schedule or when events arrive, acts autonomously where policy allows, and asks you before anything consequential.
4. **Stay in control.** Every action has a **Why?** view, pending approvals wait for you, uncertain outcomes stop for your review, and feedback shapes prioritisation without ever widening authority.

U2OS runs as a background service: closing the browser does not stop sync, routines or triggers. It serves one owner, not multiple tenants. See the security notes in the [README](../README.md) before exposing an instance beyond your machine.

## Where this stands today

U2OS is a working pre-alpha. The vault, routines, policy engine, durable actions, privacy policy, explainability, real Google/IMAP/Brave/webhook connectors and the browser client are implemented and tested with fixtures. **They have not yet been validated in daily use with real accounts and a real model.** Proving that is the next milestone.

- For what's implemented, see the [README](../README.md).
- For how it's built, see [Architecture](architecture.md).
- For what's next, see [PLAN.md](../PLAN.md).
- The original specification is [PROMPT.md](../PROMPT.md) (historical).
