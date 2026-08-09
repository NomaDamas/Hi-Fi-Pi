# Installing Hi-Fi Pi

Hi-Fi Pi is distributed separately from upstream Pi. Every installation exposes `hifi-pi`; it never creates or replaces a `pi` executable.

## Source checkout

```bash
git clone git@github.com:NomaDamas/Hi-Fi-Pi.git
cd Hi-Fi-Pi
npm ci --ignore-scripts
npm run build:offline
node packages/coding-agent/dist/cli.js --version
```

## SDK tarballs

GitHub releases contain versioned tarballs for AI, agent core, TUI, coding-agent SDK, server and SQLite storage packages, plus `hifi-pi-sdk-manifest.json`. Install all required tarballs together so the forked packages satisfy one another without resolving same-named upstream packages:

```bash
npm install ./hifi-pi-ai-*.tgz ./hifi-pi-agent-core-*.tgz ./hifi-pi-tui-*.tgz ./hifi-pi-coding-agent-*.tgz
```

The upstream module identifiers remain intact for Pi extension compatibility. The SDK manifest records package names, versions, SHA-256 digests and the source revision.

## Standalone binaries

Release archives are named `hifi-pi-<platform>-<arch>` and contain `hifi-pi` or `hifi-pi.exe`. macOS, Linux and Windows x64/arm64 artifacts are built from the release source archive. Verify the release-wide `SHA256SUMS` before execution.

## Release safety

`hifi-pi --version` prints the fork name, package version and source revision. Self-update is disabled until a Hi-Fi-specific signed release channel is configured; the fork never consults the upstream Pi channel by default. Set `HIFI_PI_SELF_UPDATE_URL` only for an explicitly trusted internal channel.
