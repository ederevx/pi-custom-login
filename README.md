# pi-custom-login

Register custom OpenAI-compatible providers in the [pi](https://pi.dev) coding
agent, and let each provider's `/models` catalog supply its model list. A
provider registered once appears in `/login` and `/model` and keeps working
across restarts; the model list is fetched by pi and cached, so it follows the
endpoint without editing this package.

## Install

```bash
pi install git:github.com/ederevx/pi-custom-login@v0.5.2
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

Some endpoints keep that metadata outside the entries: Ollama Cloud's
`/v1/models` returns bare `data` entries beside a non-standard top-level
`models` array. `data` defines the model list and its order; a missing field
is filled from the top-level entry whose `slug` equals the id, and an explicit
data value always wins. Context comes from `context_window`, or from
`max_context_window` when that is absent; image support comes from
`input_modalities` containing `image`; reasoning support comes from
`supported_reasoning_levels` (an effort of `none` alone means no reasoning).
Models the endpoint hides stay listed. A malformed metadata list, an entry
without a slug, a duplicate slug, or a duplicate model id fails the refresh;
supplementary field values are validated when consumed, so an unused value
never overrides or invalidates an explicit data value. An empty `data` array
is a valid catalog and replaces the stored list.

Model costs come from each data entry's OpenRouter-shaped `pricing` object:
`prompt`, `completion`, `input_cache_read`, and `input_cache_write` are
non-negative decimal strings in USD per token, converted to pi's USD per
million tokens. Missing prices and the exact string `"-1"` (no fixed price)
default to zero; this does not mean the model is free. Other negative values
are invalid. Malformed pricing objects or supported price fields fail the
refresh without replacing the stored list. Other pricing formats and
conditional pricing are not interpreted. Its output
limit comes from `max_output_tokens` when present, otherwise it defaults to
16384 tokens; a `truncation_policy` is a tool-output truncation policy, not a
requestable output cap, so it is never used for it.

Missing context and output limits fall back to
`PI_CUSTOM_LOGIN_DEFAULT_CONTEXT_WINDOW` and
`PI_CUSTOM_LOGIN_DEFAULT_MAX_TOKENS`, 131072 and 16384 by default. Explicit
settings must be positive safe integers; an invalid setting stops the
extension from loading.

## Limits

- Only the chat-completions shape is supported; an endpoint that speaks another
  API needs its own provider registration.
- A model list exists only after pi has fetched the catalog once; before that
  the provider is listed but has no models.
- Models are listed exactly as the endpoint reports them, including those the
  account cannot use yet.
- Zero cost can mean the catalog supplied no supported price; it does not
  establish that a model is free. Ollama's catalog currently supplies no
  prices. This package does not scrape pricing pages.
- Costs are catalog snapshots, not billing totals; conditional rates and
  non-token charges are not represented.
- Pi 1.4.0 supports owner-maintained costs through
  `providers.<provider-id>.modelOverrides.<exact-model-id>.cost` in
  `<agent-dir>/models.json`, including refreshed extension models. Costs use
  USD per million tokens. Omitted cost fields retain their existing values;
  unknown model ids are ignored.
