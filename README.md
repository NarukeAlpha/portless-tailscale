# pless

`pless` is a Tailscale-first fork of portless for remote devboxes.

It keeps the local `.localhost` workflow, but adds a single Tailscale gateway:

```bash
pless myapp next dev
```

On the devbox, the app still gets a stable local URL:

```text
https://myapp.localhost
```

From another tailnet device, open the devbox Tailscale URL:

```text
https://delta-bare.tail6624e2.ts.net
```

The gateway shows running apps. Use:

```text
/myapp
```

to list all running `myapp` instances, then:

```text
/myapp/4217
```

to select the instance on port `4217`. After selection, `/` proxies the app at
the root path so frameworks like Next.js and Vite do not need `basePath`
configuration.

## Install

```bash
npm install -g bun
git clone https://github.com/NarukeAlpha/portless-tailscale.git
cd portless-tailscale
bun install
bun run --filter pless build
cd packages/portless
bun link --global
```

## Requirements

- Node.js 20+
- Tailscale CLI installed on the devbox
- `tailscale status` works on the devbox itself
- Tailscale Serve enabled for the tailnet/device

## Usage

```bash
pless myapp next dev
pless api bun dev
pless run --name docs next dev
```

Useful URLs:

```text
https://<devbox>.ts.net/          all running apps, or selected app
https://<devbox>.ts.net/myapp     running myapp instances
https://<devbox>.ts.net/_pless    dashboard
https://<devbox>.ts.net/_pless/clear
```

Disable Tailscale for one run:

```bash
pless --no-tailscale myapp next dev
```

Use upstream-style direct Tailscale Serve ports:

```bash
pless --tailscale-direct myapp next dev
```

That mode maps apps directly to `443`, `8443`, `8444`, etc.

## Config

Prefer `pless.json`:

```json
{
  "name": "myapp",
  "script": "dev"
}
```

Package config can use `"pless"`:

```json
{
  "scripts": {
    "dev": "next dev"
  },
  "pless": {
    "name": "myapp"
  }
}
```

The fork still reads upstream `portless.json`, package `"portless"`, and
`PORTLESS_*` environment variables for compatibility. Prefer `PLESS_*` for new
setup.

## State

Default state lives in:

```text
~/.pless
```

The original upstream README is preserved as [`Fork-README.md`](./Fork-README.md).
