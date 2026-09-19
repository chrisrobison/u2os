# Security

U2OS is a pre-alpha, single-owner local service. Do not expose it directly to the public internet. It binds to `127.0.0.1` by default; LAN binding must be explicit and should be protected by a carefully configured TLS reverse proxy and host firewall.

Current releases require first-run owner setup and an authenticated session for private APIs. Earlier versions had no owner authentication. Treat the complete `U2OS_HOME` directory and every `.tar.gz` snapshot as equivalent to the live identity store: backups include the credential master key, encrypted connector credentials, owner passphrase hash, and private data. They do not contain a recoverable plaintext passphrase.

To report a vulnerability, use GitHub's private vulnerability-reporting feature for this repository. Do not open a public issue containing exploit details, credentials, tokens, or personal data. If private reporting is unavailable, contact the repository owner privately through the contact method on their GitHub profile.
