# Security

U2OS is a pre-alpha, single-owner local service. Do not expose it directly to the public internet. It binds to `127.0.0.1` by default; LAN binding must be explicit and should be protected by a carefully configured TLS reverse proxy and host firewall.

Current releases require first-run owner setup and an authenticated session for private APIs. Earlier versions had no owner authentication. Treat the complete `U2OS_HOME` directory and every `.tar.gz` snapshot as equivalent to the live identity store: backups include the credential master key, encrypted connector credentials, owner passphrase hash, and private data. They do not contain a recoverable plaintext passphrase. Your vault ([docs/vault.md](docs/vault.md)) holds your digital self in **plain text**: keep it on an encrypted disk, and treat any git remote or sync service you use for it as a destination for everything in it.

Routines run unattended but have no authority beyond the action policy. A routine's instruction and triggering event content can never authorize an action or change policy.

MCP tool servers declared in the vault's `mcp.yaml` ([docs/mcp.md](docs/mcp.md)) run as separate processes with your user's permissions and a minimal environment that excludes U2OS's secrets. Declare only servers you trust; anyone who can edit your vault can declare one. Their actions are gated by the action policy (confirmation by default), and their results are untrusted data.

To report a vulnerability, use GitHub's private vulnerability-reporting feature for this repository. Do not open a public issue containing exploit details, credentials, tokens, or personal data. If private reporting is unavailable, contact the repository owner privately through the contact method on their GitHub profile.
