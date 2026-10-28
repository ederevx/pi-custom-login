# pi-custom-login

Register custom OpenAI-compatible providers in the [pi](https://pi.dev) coding
agent, and let each provider's `/models` catalog supply its model list. A
provider registered once appears in `/login` and `/model` and keeps working
across restarts; the model list is fetched by pi and cached, so it follows the
endpoint without editing this package.

## Install

```bash
pi install git:github.com/ederevx/pi-custom-login@v0.2.6
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## Register a provider

```
/providers [settings [id]]
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

## Failing over when a response does not start

`/providers settings <id>` opens one screen, laid out like `/models`: a
fallback row that opens a searchable list of the models pi can offer, and a
response-start timeout row. Enter edits the selected row, `Ctrl+S` saves, `Esc`
cancels without writing. A request whose
response has not begun producing content within that timeout aborts the
attempt and is re-sent to the fallback model; the abort is best-effort, so the
original server may still finish its own work.

Only the start of a response counts. The first content event commits the
request to the provider, and a transport error, an authentication failure, or a
cancellation never falls over. Every later request tries the provider again.

The fallback target must be a physical chat model of another provider that
accepts the same inputs and has at least as large a context window. It is
re-validated when it is used, and it is dispatched once: a fallback provider
that has its own fallback configured cannot chain a second hop. Choosing
`Disabled` removes the setting, a saved model that left the catalog is kept and
marked, and a provider without a fallback is registered exactly as before.

## How the model list is built

Every registered provider is an `openai-completions` provider with
`authHeader: true` and an empty initial model list. pi calls the provider's
`refreshModels` hook at startup, when `/model` opens, and after `/login`; the
hook requests `GET <baseUrl>/models` with the credential pi resolved, maps each
entry's `id`, `display_name`, `context_window`, `vision`, and
`reasoning.effort_levels`, and persists the result for the next start. Offline
or without a credential the previously stored list is returned unchanged, and
a failed, malformed, or unusable response leaves it untouched rather than
emptying it. Re-adding an id replaces its registration.

The catalog carries no price or output limit, so every model is registered with
zero cost and a 16384-token output limit.

## Limits

- Only the chat-completions shape is supported; an endpoint that speaks another
  API needs its own provider registration.
- A model list exists only after pi has fetched the catalog once; before that
  the provider is listed but has no models.
- Models are listed exactly as the endpoint reports them, including those the
  account cannot use yet.
