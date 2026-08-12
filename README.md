# Hi-Fi Pi

Hi-Fi Pi is a provider-aware Pi-compatible agent runtime and coding-agent distribution. It preserves Pi's lightweight CLI, agent loop, extension, skill, prompt, theme, and package ecosystem while adding full-fidelity provider inputs and controls.

Hi-Fi Pi is an unofficial fork of [pi](https://github.com/earendil-works/pi) by Mario Zechner, distributed under the MIT License. It is not affiliated with or endorsed by earendil-works. The upstream copyright notice remains in [LICENSE](LICENSE).

## Status

Hi-Fi Pi is under active development. The executable is `hifi-pi`, user-owned state is stored under `~/.hifipi`, and project-local `.pi` resources remain compatible with the Pi ecosystem.

Native attachment support currently includes provider-aware PDF transport for OpenAI Responses, Anthropic Messages, and Gemini, with typed attachment propagation through sessions, SDK/RPC inputs, exports, and the TUI.

## Repository packages

| Package | Description |
|---------|-------------|
| [`packages/telemetry`](packages/telemetry) | Vendor-neutral telemetry contracts and typed schemas |
| [`packages/ai`](packages/ai) | Multi-provider LLM APIs and provider-native attachment lowering |
| [`packages/agent`](packages/agent) | Agent runtime with tool calling and state management |
| [`packages/coding-agent`](packages/coding-agent) | Hi-Fi Pi interactive CLI, SDK, RPC, sessions, and extension host |
| [`packages/tui`](packages/tui) | Terminal UI library |

Canonical `@earendil-works/pi-*` module aliases remain supported for existing Pi extensions. Hi-Fi Pi's own published artifact names are tracked separately from that compatibility contract.

## Install from source

Until a verified release is available, build and install from a checkout:

```bash
git clone git@github.com:NomaDamas/Hi-Fi-Pi.git
cd Hi-Fi-Pi
npm install --ignore-scripts
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
hifi-pi --version
```

For development without a global install:

```bash
./pi-test.sh
```

## Development

```bash
npm install --ignore-scripts
npm run build:offline
npm run check
./test.sh
./pi-test.sh
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by `SHA256SUMS`. Extract it and run the same build script used by release CI:

```bash
VERSION="<release-version>"
tar -xzf "hifi-pi-${VERSION}-source.tar.gz"
cd "hifi-pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes the generated provider model snapshot used for that release. The build script installs dependencies, builds the monorepo, compiles the Bun executable, and stages runtime assets. Maintainers providing dependencies separately can pass `--skip-install --skip-deps`.

## External services

Hi-Fi Pi does not use an upstream session viewer, self-update endpoint, remote model catalog, or install telemetry endpoint by default. These integrations require explicit Hi-Fi configuration:

```text
HIFI_PI_SHARE_VIEWER_URL
HIFI_PI_SELF_UPDATE_URL
HIFI_PI_MODEL_CATALOG_URL
HIFI_PI_TELEMETRY_URL
```

Provider APIs selected and configured by the user are unaffected. The Radius provider retains its own explicitly selected service endpoint.

## Compatibility and security

Hi-Fi Pi extensions execute with the permissions of the current process, as they do in Pi. Review third-party extensions and skills before loading them, and use a container or sandbox when stronger isolation is required. See [containerization guidance](packages/coding-agent/docs/containerization.md).

Project-local extensions, skills, prompts, themes, settings, and package manifests remain under `.pi` for ecosystem compatibility. Distribution-owned user state lives under `~/.hifipi/agent`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE) for the complete notice and retained upstream copyright.
