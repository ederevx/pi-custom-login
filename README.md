# pi-custom-login

Register custom OpenAI-compatible providers in the [pi](https://pi.dev) coding
agent, and let each provider's `/models` catalog supply its model list. A
provider registered once appears in `/login` and `/model` and keeps working
across restarts; the model list is fetched by pi and cached, so it follows the
endpoint without editing this package.

## Install

```bash
pi install git:github.com/ederevx/pi-custom-login@v0.4.0
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## Register a provider

```
/providers add <id> <baseUrl>
/providers remove <id>
/providers list
```

`/providers add verboo https://code.verboo.ai/router/v1` records the provider
and registers it immediately; missing arguments are prompted for. The key is
never passed here: `/providers` takes no key argument at all, so a pasted one is
refused instead of written to disk.

The registration is stored in `<agent-dir>/custom-providers.json`
(`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`) and replayed at every start.
Run `/login <id>` afterwards to store the key in pi's credential store, then
`/model` to pick a model from the catalog.

## How the model list is built

Every registered provider is an `openai-completions` provider with
`authHeader: true` and an empty initial model list. pi calls the provider's
`refreshModels` hook at startup, when `/model` opens, and after `/login`; the
hook requests `GET <baseUrl>/models` with the credential pi resolved, maps each
entry's `id`, `display_name`, `context_window`, `max_output_tokens`, `vision`, and
`reasoning.effort_levels`, and persists the result for the next start. Offline
or without a credential the previously stored list is returned unchanged, and
a failed, malformed, or unusable response leaves it untouched rather than
emptying it. Re-adding an id replaces its registration.

Every model is registered with zero cost. Its output limit comes from
`max_output_tokens` when present, otherwise it defaults to 16384 tokens.

## Limits

- Only the chat-completions shape is supported; an endpoint that speaks another
  API needs its own provider registration.
- A model list exists only after pi has fetched the catalog once; before that
  the provider is listed but has no models.
- Models are listed exactly as the endpoint reports them, including those the
  account cannot use yet.
