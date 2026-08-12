# Contributing to Hi-Fi Pi

Hi-Fi Pi is a provider-aware fork of Pi. Contributions must preserve the Pi extension, skill, prompt, theme, package, session, SDK, and RPC compatibility contracts unless a breaking change is explicitly approved.

## Design boundary

Keep the common agent experience small. Provider-specific capability belongs behind typed provider modules and additive sidecars, not in legacy text/image message shapes or TUI components.

Before changing core behavior, state:

- the concrete capability or bug;
- the existing Pi compatibility contract affected;
- the legacy fast path that must remain unchanged;
- the scenario tests proving both the new behavior and legacy equivalence.

Do not silently convert unsupported native inputs. An unsupported provider/model/transport combination must fail before the network request with an actionable error.

## Contribution gate

Use the repository issue and pull-request templates. Keep reports concrete and reproducible. AI-assisted issues, comments, and reviews must be clearly labeled as AI-generated.

Pull requests require review attestation pinned to the current head SHA. A new commit invalidates earlier approval. Follow the instructions reported by the Review Gate check.

## Before submitting a pull request

Read [AGENTS.md](AGENTS.md), then run:

```bash
npm run check
./test.sh
```

Add focused regression tests for changed behavior. Provider API tests must use fixtures or faux transports unless a live opt-in contract explicitly requires credentials. Never commit credentials, personal endpoint configuration, or generated secrets.

Dependency and lockfile changes require explicit review. Direct dependencies remain exactly pinned, and generated shrinkwrap/install-lock artifacts must be regenerated atomically with package identity changes.

## Pull-request scope

Prefer independently reviewable slices:

- shared IR and contracts;
- provider lowering;
- coding-agent input/session propagation;
- presentation;
- distribution and release changes.

Do not combine an externally visible release with unrelated code changes. Release publication is reviewed and executed only after its prerequisite changes are on `main`.

## Attribution

Hi-Fi Pi is an unofficial fork of [pi](https://github.com/earendil-works/pi) by Mario Zechner under the MIT License. Preserve [LICENSE](LICENSE) and upstream history when porting changes.
