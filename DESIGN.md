---
# Normative token names and roles. Values live in code; this file never copies them.
sources:
  colors: packages/ui-tokens/src/index.ts        # webDarkTokens / webLightTokens (web, Electron); darkTokens / lightTokens (mobile)
  colors-css: packages/ui-tokens/src/tokens.css  # generated, do not edit
  tailwind-theme: packages/ui-web/src/styles.css # @theme: type scale, radius, color utilities
  control-sizes: packages/ui-web/src/lib/control-size.ts
  components: packages/ui-web/src/components/ui
default-theme: dark
surfaces:            # bottom to top in dark mode; see "Surfaces" for light
  - background       # page
  - sidebar          # app navigation (same fill as background in dark)
  - dialog           # modal panels
  - card             # raised blocks, also muted and popover
fills:
  muted: tracks, wells, quiet containers
  accent: hover and pressed fill (ink at low opacity)
  secondary: quiet button fill
  input: control borders and dark-mode selected fills
ink:
  foreground: primary text
  muted-foreground: secondary text
  faint-foreground: tertiary text
  primary: the one strong action (ink, not a hue)
status: [destructive, success, warning]
identity: botColors   # the only hues in app chrome
type-scale: [caption, label, body-sm, body, body-lg, heading3, heading2, heading1, display]
control-sizes: [xs, sm, default, lg, xl]
radius: [sm, md, lg, xl, 2xl]   # all derived from --radius
---

# Rakazo design

How Rakazo looks and why. Read this before writing or changing UI on any surface. The rules
here sit alongside the engineering rules in [AGENTS.md](AGENTS.md) and the review pass in
[ux-declutter](.agents/skills/ux-declutter/SKILL.md). If this file and code disagree, the code
is the source of truth for values and this file should be fixed.

## Principles

1. **Calm.** Fewest elements that do the job. Progressive disclosure over persistent
   explanation. Read first, edit second.
2. **Monochrome.** Primary is ink. Colour means status (destructive, success, warning) or
   identity (a bot). Nothing else gets a hue.
3. **One product, three surfaces.** Web and Electron share `packages/ui-web`. Mobile is
   native-first and may diverge when the native pattern is better.
4. **Tokens, not values.** Every colour is a semantic token. No hex values, no `[var(--…)]`
   arbitrary classes, no height classes on controls.

## Colour and surfaces

### Where colours come from

One TypeScript file, `packages/ui-tokens/src/index.ts`, defines every palette:

| Palette | Used by |
|---|---|
| `darkTokens`, `lightTokens` | Mobile (iOS system values) |
| `webDarkOverrides`, `webLightOverrides` | Merged over the mobile palettes to make `webDarkTokens` and `webLightTokens` |
| `botColors`, `botEyeColor` | Bot identity, every surface |
| `pageKitPalette` | Bot-built pages only, never app chrome |

`pnpm --filter @rakazo/ui-tokens generate` renders `tokens.css`. `packages/ui-web/src/styles.css`
exposes each token as a Tailwind colour (`bg-card`, `text-muted-foreground`, `border-input`).
Use those utilities. Opacity modifiers on a token (`bg-input/50`) are fine.

Dark is the default theme (`:root`). Light applies under `[data-theme="light"]`. The `dark:`
variant matches `[data-theme="dark"]`.

### Surfaces

Surfaces are opaque. Text, borders, hover and selection are ink at an opacity, so they read
the same on any surface.

| Token | Role |
|---|---|
| `background` | The page |
| `sidebar` | App navigation |
| `dialog` | Modal panels (`DialogContent`) |
| `card` | Raised blocks inside a page or dialog |
| `popover` | Menus, popovers, command palette |
| `muted` | Tracks and wells: segmented control track, tab list, quiet containers |
| `glass-fill`, `glass-stroke` | Floating controls over scrolling content (`.glass`) |

**The lightness order flips between themes.** Check both before you pick a fill.

| | Darkest → lightest |
|---|---|
| Dark | `background` = `sidebar` → `dialog` → `card` = `muted` = `popover` |
| Light | `card` = `muted` → `sidebar` → `background` = `dialog` = `popover` |

So `bg-background` on a `bg-muted` track looks raised in light mode and sunken in dark mode.
A selected item inside a track needs a dark-mode override:

```tsx
// Selected item in a muted track
"aria-pressed:bg-background aria-pressed:shadow-sm dark:aria-pressed:bg-input/50"
```

Shared Tabs does the same with `dark:data-active:bg-input/30` and a border.

### Interaction fills

| State | Token |
|---|---|
| Hover, menu highlight, open trigger | `accent` |
| Selected in a track | `background` (light), `input/50` (dark) |
| Focus | `ring` at 50%, 3px (`focus-visible:ring-3 focus-visible:ring-ring/50`) |
| Disabled | `opacity-50`, or `primary-disabled` for the primary button |
| Invalid | `destructive` border and ring |

### Ink

`foreground` → `muted-foreground` → `faint-foreground`, strongest to quietest. Links use `link`.
Unread and working states use `unread` and `status-working`.

## Typography

System font (`font-sans`). Regular weight is 420 on macOS, where 400 reads thin. Use
`font-medium` (500) for emphasis and titles and `font-semibold` (600) sparingly.

Tailwind's default text sizes are removed. Use the scale:

| Utility | Size / line | Use |
|---|---|---|
| `text-caption` | 11 / 16 | Timestamps, tiny meta |
| `text-label` | 12 / 16 | Field labels, quiet group labels |
| `text-body-sm` | 13 / 18 | Dense controls, segmented items, table meta |
| `text-body` | 14 / 20 | Default UI text |
| `text-body-lg` | 15 / 22 | Section titles, `xl` buttons |
| `text-heading3` | 17 / 24 | Settings section headings |
| `text-heading2` | 22 / 28 | Dialog and page titles |
| `text-heading1` | 26 / 32 | Rare, top-level headings |
| `text-display` | 32 / 40 | Onboarding and empty-state heroes |

Use `SectionHeading` (`heading`, `title`, `label` variants) for section names instead of
styling an `h3` by hand. Mobile uses `typeScale` in iOS points (body 17/22) and caps dynamic
type at `MAX_FONT_SCALE`.

## Spacing and layout

Tailwind's default 4px scale, with no custom spacing tokens. Common rhythm:

- Inside a control: `gap-1.5`, `px-2.5`.
- Settings rows: `px-4 py-3`. Groups: `space-y-8`.
- Dialog and panel padding: `p-6`, and `sm:px-8` for wide panels.
- Settings content column: `SETTINGS_CONTENT_WIDTH` (`max-w-2xl`, 672px). The settings
  overlay is sized to fit sidebar (200px), padding (64px) and that column.

Forms lay out with `FieldGroup`, `Field` and `FieldLabel` so every form has the same rhythm.
Never hand-space labels.

### One text edge

Text on a page starts on one vertical line, and trailing controls end on one line.

- Inside a bordered group or muted card, rows are padded (`px-4`, or `px-3.5` in the Vault
  list) and their text sets the edge.
- Headings above a group are inset to that edge: `SettingsGroup` titles do this, and a hand-built
  header row uses the same inset (`mx-px px-4` over a bordered group, `px-4` or `px-3.5` over a
  borderless card).
- A `FieldLabel` above its control starts where the control's text does (border plus padding,
  13px). The component does this; don't add padding by hand.
- `Input`, `Textarea` and select triggers share one text inset, so stacked controls line up.
- A header's action button ends on the same line as the controls in the rows below.

## Radius

All radii derive from `--radius` (0.75rem): `rounded-sm` −4px, `rounded-md` −2px, `rounded-lg`
= radius, `rounded-xl` +4px, `rounded-2xl` +8px.

| Radius | Use |
|---|---|
| `rounded-lg` | Controls, segmented tracks and items, menu items |
| `rounded-xl` | Cards, settings groups, default dialogs |
| `rounded-2xl` | Large dialogs and overlays |
| `rounded-full` | Avatars, floating buttons, filter chips. Never action buttons |

## Elevation

No elevation tokens. Separation comes from surface order and borders first, shadow second.

- `border-border` (ink at low opacity) separates rows and groups.
- `ring-1 ring-foreground/10` outlines dialogs.
- `shadow-sm` lifts a selected item in a track. Larger shadows belong to popovers and menus,
  which the shadcn components already set.
- `overlay` dims behind modals.

## Motion

No motion tokens. Keep it short and functional.

| Duration | Use |
|---|---|
| `duration-100` | Dialog open and close |
| `duration-150` | Hover and colour transitions (most common) |
| `duration-200` | Panel and disclosure movement |

Ease out on enter. Open and close use `tw-animate-css` (`animate-in fade-in-0 zoom-in-95`).
AI moments (loading, shimmer, success) reuse `apps/web/src/components/ai/`.

## Iconography

Lucide (`lucide-react`). Default size `size-4`, `strokeWidth={1.75}` in navigation. Mirror
directional icons in RTL (`rtl:rotate-180`). An icon-only control needs an accessible name and
usually an `IconTooltip`.

- An icon-only button in a row or card uses `size="icon"` (32px, the height of an input), not
  `icon-sm` or `icon-xs`, so its hit area matches the controls beside it.
- A button carries at most one icon, at the start (`data-icon="inline-start"`). A button that
  opens a menu doesn't add a chevron when it already has an icon.

## Components

Web and Electron use shadcn/ui (style `base-nova`) on Base UI, vendored into
`packages/ui-web/src/components/ui` from the official registry only:

```bash
pnpm exec shadcn add <component>
```

Reuse these before writing anything by hand. `pnpm checks` rejects some hand-rolled copies.

### Control sizes

`Button`, `Input`, `InputGroup`, `SelectTrigger` and `OptionSelect` take height from the `size`
prop only (`control-size.ts`), so controls side by side line up:

| Size | Height | Square |
|---|---|---|
| `xs` | 24 | `icon-xs` |
| `sm` | 28 | `icon-sm` |
| `default` | 32 | `icon` |
| `lg` | 36 | `icon-lg` |
| `xl` | 48 | |

### Button

| Variant | Use |
|---|---|
| `default` | The one primary action on a screen (ink fill) |
| `secondary` | Row actions, header actions, Edit, Rename, Change password. The usual choice |
| `outline` | Rare: a secondary action that needs an edge on a busy surface |
| `ghost` | Toolbars and icon-only actions |
| `text` | Inline action that reads as text |
| `link` | Navigation inside copy |
| `destructive-secondary` | Remove, delete, leave or disconnect on an ordinary page: neutral, red on hover and press |
| `destructive` | The confirming button in a destructive confirmation (tinted red) |
| `floating` | Pill over scrolling content (glass) |

One `default` button per view. Destructive actions go in menus or the bottom of an edit form,
not repeated per row.

**Destructive actions stay neutral until you reach for them.** A page lined with red text reads
as an alarm. On ordinary pages:

- A labelled button uses `destructive-secondary` with an icon that says what happens: `Trash2`
  for remove and delete, `LogOut` for leave, `Unplug` for disconnect. Don't use a trash can for
  actions that delete nothing.
- An icon-only button (a trash can at the end of a row) is `ghost` with `text-muted-foreground`
  and a red hover and press tint.
- Red at rest is for the confirmation step: the `destructive` button in an `AlertDialog`, or a
  danger container that holds the final form (deleting an account).

### Choosing between similar controls

| Need | Use | Not |
|---|---|---|
| Pick one of a fixed list | `OptionSelect` | Native `<select>` (check rejects it) |
| Pick one of 2–4 short options, all visible | Segmented control | Radio group |
| Switch views of the same content | `Tabs` | Segmented control |
| On or off, applies at once | `Switch` | Checkbox |
| Agree or select in a form | `Checkbox` | Switch |
| Confirm a destructive action | `AlertDialog` (`ConfirmDialog`) | `Dialog` |
| Transient result | `toast` (sonner) | Inline banner |
| A status or failure that stays until something changes | `Notice` | Bare coloured text |
| Nothing here yet | `Empty` | Custom text block |

### Segmented control (proposed)

Status: **pattern**. Today it is `ToggleGroup` styled inline in 14 places (Usage date range,
appearance, approvals, billing, vault, memory, signup survey and others):

```tsx
<ToggleGroup spacing={1} className="grid grid-cols-N rounded-lg bg-muted p-1">
  <ToggleGroupItem className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm dark:aria-pressed:bg-input/50">
```

It should become a `segmented` variant in `packages/ui-web` so the track and selected state
live in one place. Until then, copy the class string above exactly.

### Dialog

`DialogContent` sizes: `default` (`max-w-sm`, confirmations and short forms), `md` 600px,
`lg` 760×680, `xl` 920×680, `2xl` 1080×760. Large sizes use `bg-dialog`, `rounded-2xl` and their
own scroll panes. Every dialog has a `DialogTitle`. Add a `DialogDescription` only when the
title alone doesn't say what happens.

### Notice

`Notice` (`apps/web/src/components/Notice.tsx`) is a tinted message box with `error`, `warning`
and `success` tones. The tone's icon carries the colour, the text stays `foreground`, and errors
render with `role="alert"` and the others with `role="status"`. Put it next to what it is about
(a provider error inside the provider section), not at the top of the page.

```tsx
{error ? <Notice tone="error">{error}</Notice> : null}
```

### Settings

Settings screens use `SettingsGroup` (titled, bordered list) and `SettingsRow` (label then
control, wrapping when narrow) from `apps/web/src/components/settings/SettingsRows.tsx`, inside
`SETTINGS_CONTENT_WIDTH`.

- Prefer rows (label left, control right) to a stacked form. A setting's longer setup (an API
  key, server fields, sign-in) goes inside its row's children, under the label.
- Selects in a row get a fixed width (`w-56`) so rows line up. Switches sit at the end of the row.
- A list with an add action gets a section header: `SectionHeading` (`heading` variant) on the
  left, a `secondary` button with a `Plus` icon on the right, inset to the text edge. The list
  sits below, in a `SettingsGroup` or a muted card (`rounded-xl bg-muted/50`). Approvals (Rules),
  Vault (Items) and Memory (Memory provider) follow this.
- A record opened from a muted-card list shows its fields in the same card, so it looks the same
  open as in the list.

### Card and Empty

`Card` is a `bg-card` block with `rounded-xl`. `Empty` is the shared empty state. Its `icon`
media variant sits on `bg-muted`.

### Bot identity

Bots carry the only hue in app chrome, from `botColors`. Use the avatar components in
`packages/ui-web/src` (`bot-avatar`, `group-avatar`, `logo-avatar`, `notification-avatar`).
Never tint other UI with a bot colour.

## Voice and copy

Every visible word is UI.

- Start by asking what can be removed. No explainer text that repeats the interface.
- No em dashes in copy. Use a period, comma or colon (`no-em-dash-copy` check).
- A picker carries a label or sits beside the thing it chooses for. No raw ids on screen.
- A PR that adds user-facing copy quotes it and says why it can't be removed or disclosed later.
- UI strings go through Lingui. Feature PRs never edit `messages.po`.

Proposed, not yet agreed with maintainers (observed in existing copy, not written down):

- Sentence case, short and plain.
- Empty states say what goes here and offer the one action that adds it.
- Errors say what happened and what to do, without blame.

## Mobile

Native-first: Expo Router, Expo UI (SwiftUI, Liquid Glass), native sheets, menus, alerts,
pickers and switches. Custom surfaces (thread, composer, avatars, cards) use `StyleSheet` with
tokens from `apps/mobile/lib/appearance/appearance.ts`. System chrome uses `PlatformColor` via
`lib/native/native.ts`.

## Checking a UI change

1. Look at it in **both themes**, especially fills on fills.
2. Run the [ux-declutter](.agents/skills/ux-declutter/SKILL.md) pass on a real screenshot.
3. `pnpm lint` and `pnpm checks`.
4. For a PR, embed the CI E2E screenshot (see AGENTS.md).

## Known gaps

- No shared segmented control (see above).
- No elevation or motion tokens. The conventions above are descriptive.
- Some danger and error boxes are still hand-built with the `Notice` classes (the account
  deletion container, a few inline errors). Move message-only ones to `Notice`.
- About 20 buttons still use `destructive`. Most confirm an action in a dialog, which is right;
  check the rest against the destructive-action rule above.
- Spaces' "New private space" still sits below its list rather than in a section header.
- Light-theme `card` and `muted` are darker than `background`, the opposite of dark, where they
  are lighter. Worth a deliberate decision rather than a per-component fix.
