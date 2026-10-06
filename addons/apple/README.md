# Apple apps

Lets U2OS read and act in the Apple apps on this Mac: **Calendar, Contacts, Mail, Messages, Notes, Reminders and Maps**. It runs the [apple-mcp](https://www.npmjs.com/package/apple-mcp) tool server (pinned to version 1.0.0) with `bunx`.

## Before you enable it

- macOS only, and [Bun](https://bun.sh) must be installed (`bunx` on your PATH). The first run downloads apple-mcp.
- The first time each app is used, macOS asks whether to let the program control it (System Settings, Privacy & Security, Automation). Allow it for the app that runs U2OS.
- apple-mcp runs with your account's permissions. It is third-party code: read what it does before you enable it, and review any version change before editing the pin in `addon.yaml`.

## What you get

Each operation is its own tool, named `apple.<app>_<operation>`:

| App | Reads | Changes things |
|---|---|---|
| Calendar | `calendar_list`, `calendar_search` | `calendar_create` |
| Contacts | `contacts_search` | |
| Mail | `mail_unread`, `mail_latest`, `mail_search`, `mail_accounts`, `mail_mailboxes` | `mail_send` |
| Messages | `messages_unread`, `messages_read` | `messages_send`, `messages_schedule` |
| Notes | `notes_list`, `notes_search` | `notes_create` |
| Reminders | `reminders_list`, `reminders_search`, `reminders_list_by_id` | `reminders_create` |
| Maps | `maps_search`, `maps_directions`, `maps_list_guides` | `maps_save`, `maps_pin`, `maps_create_guide`, `maps_add_to_guide` |

Opening an item in its app (the server's `open` operations) is not offered.

## Your decisions

The list above is what the add-on suggests. Until you confirm a tool on the **Add-ons** page, it asks before every use and its results are treated as private, so a model you have restricted from private data cannot see them. When you confirm the read tools, you choose the privacy level of their results (the add-on suggests *private* for mail, messages and notes, *personal* for calendar, contacts and reminders, *public* for place search). The tools that change things keep asking unless your `policies.yaml` says otherwise:

```yaml
apple:
  mail_send: confirm        # the default
  reminders_create: autonomous
  messages_send: never
```
