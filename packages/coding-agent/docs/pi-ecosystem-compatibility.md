# Pi ecosystem compatibility

Hi-Fi Pi treats the upstream Pi package ecosystem as a compatibility surface. Packages continue to declare the unchanged `pi` field in `package.json`; no Hi-Fi-specific manifest is required.

Supported package sources remain npm, Git over HTTPS, Git over SSH and local paths. User-scoped installations use the active Hi-Fi agent directory, while project-scoped package declarations remain in `.pi/settings.json` so the same project package can be used by Pi and Hi-Fi Pi.

The compatibility contract covers:

- extension tools, commands and legacy event payloads in interactive and headless/RPC sessions;
- skill, prompt and theme discovery;
- upstream module identifiers such as `@earendil-works/pi-coding-agent`;
- package update, remove, enable/disable and pinned-ref behavior;
- optional attachment event fields that remain absent for legacy text/image inputs.

The machine-readable matrix is stored in `docs/pi-ecosystem-compatibility.json` and enforced by `npm run test:pi-compat` in CI. A TUI-only extension may use UI context methods and is not automatically headless-compatible; ordinary tool/event extensions are tested in both modes.

Installed extensions execute with the host process permissions. Compatibility is not a security boundary, and only trusted extension packages should be loaded.
