# Hi-Fi Pi

Hi-Fi Pi is a provider-aware Pi-compatible agent runtime and coding-agent distribution. It preserves Pi's lightweight CLI, agent loop, extension, skill, prompt, theme, and package ecosystem while adding full-fidelity provider inputs and controls.

Hi-Fi Pi is an unofficial fork of [pi](https://github.com/earendil-works/pi) by Mario Zechner, distributed under the MIT License. It is not affiliated with or endorsed by earendil-works. The upstream copyright notice remains in [LICENSE](LICENSE).

## Status

Hi-Fi Pi is under active development. The executable is `hifi-pi`, user-owned state is stored under `~/.hifipi`, and project-local `.pi` resources remain compatible with the Pi ecosystem.

## What Hi-Fi Pi adds

Pi carries text and images to every provider. Hi-Fi Pi carries whatever a provider natively accepts, and says so plainly when it cannot.

**Native file inputs, per provider.** Attachments are sent to the vendor as files rather than being converted locally first. What each provider accepts differs, because the capability tables follow the vendors:

| Transport | Native inputs |
|---|---|
| OpenAI Responses, Azure OpenAI | PDF, Word, RTF, ODT, and ~30 text and code types (JSON, YAML, CSV, Markdown, HTML, Python, Go, Rust, …) |
| Gemini (Developer API, Vertex AI) | PDF and text documents, audio (wav, mp3, flac, aac, ogg, …), video (mp4, mov, webm, avi, mpeg, …) |
| Amazon Bedrock | PDF, Word, CSV, HTML, Markdown, audio, video |
| xAI | PDF, text, Markdown, CSV, JSON, JavaScript, and related types |
| Anthropic Messages | PDF and plain text |
| OpenAI audio chat | mp3, wav |

Custom and OpenAI-compatible endpoints stay off until explicitly opted in, since a gateway's real capabilities cannot be inferred.

**No silent conversion.** Hi-Fi Pi does not OCR, transcribe, extract frames, or convert Office documents behind your back. A file the target model cannot accept is reported, never quietly replaced with a local approximation — so what the model saw is always knowable.

**Portability across model switches.** Attachments live in the session, not in one provider's context. Switching to a model that cannot accept a file asks before proceeding, excludes only what that model rejects, and restores the file when you switch back. Canonical history is never rewritten. The model is told what was withheld, and so are you — `/files` and the run summary name every omission.

**Provider-native state.** Reasoning state, citations, cache control, server tools, and continuation state are preserved per vendor instead of being flattened, and sanitized traces show exactly what each request carried.

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

npm packages are not published yet; install from a GitHub release below, or build from a checkout:

```bash
git clone git@github.com:NomaDamas/Hi-Fi-Pi.git
cd Hi-Fi-Pi
npm install --ignore-scripts
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
hifi-pi --version
```

## Install a GitHub release

Download the archive for your platform from the [GitHub Releases](https://github.com/NomaDamas/Hi-Fi-Pi/releases) page and verify it against `SHA256SUMS`. For Apple Silicon macOS:

```bash
VERSION="v0.84.1-hifi.1"
curl -LO "https://github.com/NomaDamas/Hi-Fi-Pi/releases/download/${VERSION}/hifi-pi-darwin-arm64.tar.gz"
curl -LO "https://github.com/NomaDamas/Hi-Fi-Pi/releases/download/${VERSION}/SHA256SUMS"
grep 'hifi-pi-darwin-arm64.tar.gz' SHA256SUMS | shasum -a 256 -c -
tar -xzf hifi-pi-darwin-arm64.tar.gz
mkdir -p ~/.local/bin
cp hifi-pi/hifi-pi ~/.local/bin/hifi-pi
~/.local/bin/hifi-pi --version
```

The same release contains Linux, Windows, Intel macOS, source, and fork-owned SDK artifacts. Replace the archive name with the matching platform asset.

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
