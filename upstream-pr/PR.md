# chat: honor contributed provider icons in the input model button

Fixes the remaining gap called out in https://github.com/microsoft/vscode/issues/339167 (comment on 2026-10-22).

Stacked conceptually on https://github.com/microsoft/vscode/pull/341578 (provider `icon` for picker **tabs**). Complementary to draft https://github.com/microsoft/vscode/pull/341579 (per-model `iconPath`); this PR is narrower and does not add API surface.

## Problem

Extension models are marked `isBYOK: true`. `getModelProviderIcon()` short-circuits BYOK to the generic sparkle **before** consulting the vendor's contributed `languageModelChatProviders.icon`. Result:

- Provider **tabs** show the brand icon (#341578) ✅
- Chat **input** selected-model button still shows the sparkle ❌

`statusIcon` is the wrong escape hatch (status/warning semantics; shows in Manage Models).

## Fix

Add `getModelIdentityIcon(model, languageModelsService)` with precedence:

1. `statusIcon`
2. Built-in brand match when it is **not** the generic sparkle (preserves Claude/OpenAI/… for first-party)
3. Contributed provider `icon` (`getLanguageModelProviderIcon`)
4. Generic sparkle

Render ThemeIcons via existing codicon path; render `{ light, dark }` image icons with CSS backgrounds (same pattern as tab chips).

## Test plan

1. Install / contribute a provider with `"icon": { "light": "...", "dark": "..." }` (e.g. OpenRouter or a third-party LM provider).
2. Select one of its models in Chat.
3. **Expect:** input bar model button shows the provider icon (not sparkle).
4. Select a Copilot Claude/OpenAI model.
5. **Expect:** still shows Claude/OpenAI brand icons (not overwritten by Copilot vendor tab icon).
6. Model with `statusIcon` warning still shows the warning icon.

## Notes

- Does **not** add per-model `iconPath` (left to #341579).
- Dropdown **row** icons are unchanged in this PR (can follow up).
