# Security

This is an experimental local converter and static browser application, not a hardened service for untrusted game uploads. Process only trusted, lawfully obtained data. Binary decoders have bounds checks but are not guaranteed robust against every malformed input. Do not expose the converter as a public upload endpoint.

Use GitHub's private vulnerability reporting if enabled on the eventual repository. Do not attach game archives, saves, asset reports, local paths, or secrets to a public issue. If private reporting is unavailable, request a private contact channel without posting sensitive details.

Keep Node/dependencies updated, run `npm audit`, use HTTPS for deployments, and deploy only the appropriate build directory. Development/preview servers are not production servers. The software includes no authentication or access control for game files; configure those at your host.
