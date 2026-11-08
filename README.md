# pi-custom-login

Register custom OpenAI-compatible providers in the [pi](https://pi.dev) coding
agent, and let each provider's `/models` catalog supply its model list. A
provider registered once appears in `/login` and `/model` and keeps working
across restarts; the model list is fetched by pi and cached, so it follows the
endpoint without editing this package.

## Install

```bash
pi install git:github.com/ederevx/pi-custom-login@v0.10.1
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and
`@earendil-works/pi-tui`.

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

## Edit a model configuration

`/providers-settings` opens a menu that edits one model of one registered
provider. Every field pi accepts for a model can be overridden:

| Field | Meaning |
| --- | --- |
| `name`, `reasoning` | Display name, and whether the model accepts a thinking level. |
| `thinkingLevelMap`, `compat` | pi's per-level and per-API request adaptations; see pi's `docs/models-configuration.md`. |
| `input`, `inputLimits` | Accepted modalities, and the request-size and image limits. |
| `cost` | USD per million tokens: `input`, `output`, `cacheRead`, `cacheWrite`, and request-wide `tiers` keyed by `inputTokensAbove`. |
| `promptCache` | Prompt-cache lifetimes in seconds. |
| `contextWindow`, `maxTokens` | Context and output limits. |
| `samplingParams`, `samplingParamsByThinkingLevel` | Extra request-body fields for OpenAI-compatible endpoints. |
| `headers` | Extra request headers. |

The menu is three screens - provider, model, and that model's fields - and
Escape steps back one screen at a time, leaving `/providers-settings` only from
the provider list. The model list narrows as you type, matching the search in
`/model`, and "Enter a model id" stays available for a model the catalog has
not returned yet. The fields screen lists every field with the value it
currently resolves to beside it, marks whether that value is the override or
the catalog's, and searches the same way; its `override` row clears the whole
model's override. A field's choices open the value to type, the modalities to
choose, the fallback picker, and "Clear override" when that one field is
stored.

The edit is stored under the provider in `custom-providers.json` and applied on
top of the catalog's own values on every refresh, online or offline; clearing a
model's override returns it to the catalog's values. An edit the catalog would
reject is refused and nothing is written. Object-valued fields merge field by
field over the model, as they do in pi's own `modelOverrides`, while arrays and
single values replace. Saved edits apply the next time the model list refreshes
(open `/model` or restart).

These overrides sit below pi's own `models.json` layer: a value in
`providers.<provider-id>.modelOverrides.<exact-model-id>` there still wins.

## Fall back when a provider fails

`/providers-settings` can name a `fallback` model for any model it edits, chosen
from a provider whose model already has credentials. When a request to the
model ends in a provider error before anything was streamed, the fallback serves
that turn instead: the failed attempt contributes nothing, and the answer names
the model that actually responded. Nothing else fails over — a cancel, a normal
finish, a context overflow (pi compacts instead), and an error after content has
been streamed all pass through unchanged. The extension adds no timer: when
pi's own request timeout ends an attempt before anything streamed, that is a
provider error and the fallback serves.

Every failover is announced once the run settles, not while it streams, as an
ordinary notice rather than a warning: it names both models and what the served
turn cost, so no reply is silently billed to a provider you did not choose. A
chain announces one line per hop, in the order the hops failed. Fallbacks
chain: when the fallback fails too and is itself a provider of this extension,
its own fallback applies. A model may not fall back to
itself or to a chain that returns to it —
`/providers-settings` refuses such a pair, and the failover refuses one found in
the file rather than retrying forever.

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

Those field names are not universal, so each model-level fact is read from the
other shapes catalogs publish as well; the first one the entry carries wins,
and a value that is present but malformed fails the refresh whichever shape it
sits in:

| Fact | Read from |
| --- | --- |
| display name | `display_name`, then `name` |
| context window | `context_window`, then `limit.context`, `context_length`; `max_context_window` only stands in when none of those is present |
| output cap | `max_output_tokens`, then `limit.output`, `max_output_length` |
| image input | `vision`, then `input_modalities` or `modalities.input` (an entry naming `image` or an image MIME type) |
| reasoning | `reasoning` (an object, or a bare flag), then `capabilities.reasoning` (`supported`, or a non-empty `effort_levels`/`effort` list), then `supported_features`: a list naming `reasoning` means it does, and a list that omits it means it does not |
| cost | `pricing`, then `cost.text` (`input.price`, `output.price`, `input.cache.read`, `input.cache.write`) |

Shapes pi has no field for are left alone rather than guessed at: a context-length
`overrides` list or `cost.multipliers` beside a fixed price, `limit.input`,
`modalities.output`, and the pricing keys `image` and `request`. A shape is read
only when it is the one the entry actually supplies, so an unused and malformed
one never invalidates an explicit value.

The OpenCode Go catalog uses the second shape for every row: `limit.context`,
`limit.output`, `name`, `modalities.input`, `capabilities.reasoning`, and a
`cost.text` object whose prices are already USD per million tokens. Reka's uses
`context_length`, `max_output_length`, `name`, `input_modalities`, and
`supported_features`. The values read from the OpenCode Go payload are the ones
pi's own built-in catalog carries for those models.

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
million tokens. When an entry carries no `pricing`, its `cost.text` object is
read instead - `input.price`, `output.price`, `input.cache.read`, and
`input.cache.write` are non-negative numbers, already per million tokens and
taken as they are. Missing prices and the exact string `"-1"` (no fixed price)
default to zero; this does not mean the model is free. Other negative values
are invalid. Malformed pricing objects or supported price fields fail the
refresh without replacing the stored list. Other pricing formats and
conditional pricing - including OpenCode's time-of-day `cost.multipliers` and
any `overrides` beside a price - are not interpreted. Its output
limit follows the precedence above - `max_output_tokens`, then `limit.output`
or `max_output_length`, and `PI_CUSTOM_LOGIN_DEFAULT_MAX_TOKENS` only when the
supplementary entry supplies none of them; a `truncation_policy` is a
tool-output truncation policy, not a requestable output cap, so it is never
used for it.

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
- Owner-maintained costs — and the other model fields — are edited with
  `/providers-settings`; the values live in `custom-providers.json` under the
  provider and are re-applied on every catalog refresh.
- On top of those, pi 1.4.0 also supports owner-maintained costs through
  `providers.<provider-id>.modelOverrides.<exact-model-id>.cost` in
  `<agent-dir>/models.json`, including refreshed extension models. Costs use
  USD per million tokens. Omitted cost fields retain their existing values;
  unknown model ids are ignored. A `models.json` value overrides this
  package's override for the same field.
- A model's `api` and `baseUrl` are not overridable here: the key this provider
  stores is only sent to the endpoint registered with `/providers add`. Register
  the other endpoint as its own provider instead.
- A fallback only replaces an attempt that failed before streaming anything, so
  a partially streamed reply is never repeated on another model. Timing out is
  such a failure: the extension adds no timer of its own, and pi's request
  timeout decides when an attempt ends.
- The fallback graph is read from `custom-providers.json` on every request, so a
  hand-edited file that no longer parses fails requests for these providers
  until it is fixed.
- Every catalog model is built with `compat.supportsDeveloperRole: false`, so
  instructions go out as the standard `system` role rather than the
  OpenAI-specific `developer` role that pi otherwise guesses for an unknown
  base URL (which several OpenAI-compatible servers, DeepSeek included,
  reject). Set `compat.supportsDeveloperRole: true` in `models.json` to opt
  back in for a model that does accept it.
