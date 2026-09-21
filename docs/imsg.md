# Local iMessage read helper

U2OS includes a deliberately manual, read-only wrapper around the [imsg CLI](https://github.com/openclaw/imsg). It is not registered as an agent tool, does not poll Messages, and does not put chat content into model context, memory, events, or the U2OS database. The owner must explicitly opt in for each command.

On macOS, install `imsg`, sign in to Messages, and grant the terminal running the command Full Disk Access. Then run:

```sh
U2OS_ENABLE_IMSG_READ=1 npm run imsg:read -- chats 10
U2OS_ENABLE_IMSG_READ=1 npm run imsg:read -- history 42 20
```

The first command lists at most 20 chats; the second reads at most 30 messages from a numeric chat ID returned by the first. Only a small allowlist of text and participant fields is printed. Attachment metadata and local paths are excluded. The wrapper never calls `imsg send` or `imsg watch`; errors are sanitized. Do not paste output into a remote model unless you intend to share those private messages with that provider.

This is a local helper, not a background connector. A later UI integration would need an explicit privacy choice and destination-aware controls before any agent access.
