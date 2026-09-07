## Install the pi CLI

Metwally is a thin VS Code shell around the `pi` CLI — it spawns `pi --mode rpc`
and streams the agent protocol into the chat view.

```bash
npm install -g @mariozechner/pi
which pi
```

If `pi` is not on the PATH that VS Code inherits (common with `nvm`), set an
absolute path:

```jsonc
"piVscode.piPath": "/home/you/.nvm/versions/node/v24.16.0/bin/pi"
```

The extension also probes `~/.nvm/versions/node/*/bin`, `/usr/local/bin` and
`~/.local/bin` before giving up.
