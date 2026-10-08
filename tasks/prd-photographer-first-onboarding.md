# PRD: Photographer-First Onboarding

## Overview
A new photographer on a hosted instance must get from "account created" to "first photos published on a site that looks like mine" in the fewest steps. Today, a new site has these problems:

- The setup wizard (`api/internal/api/setup.go`) asks for the username, password and blog name. Then it shows an empty site.
- All new sites use the same theme and the same plugins, so they look like copies.
- First-run screens show self-hoster items, such as the photo library and the Remark42 comments setup.

This feature does these things:
1. Makes the setup wizard short. It asks for the account only.
2. Adds a "first post" flow that publishes the first photos from one upload.
3. Asks for the site name after the first post is published.
4. Adds a style picker with 6 different presets and identity items (site name, tagline, logo or monogram, favicon, accent color).
5. Keeps the photo library as an `.env` setting only. When the setting is not set, the UI shows no photo library section and no "From Photo Library" button.
6. Turns comments OFF by default.

The main flow is for a non-technical photographer. A separate advanced setup flow for self-hosters is a non-goal for this PRD.

## Goals
- A new user publishes the first post with photos in 3 screens or fewer after the account step.
- The setup wizard asks only for the username and password.
- Two new sites with different presets look clearly different on the home page and the post page.
- No first-run screen mentions `.env`, docker compose, Remark42 or file system paths.
- Comments are OFF by default on new instances.
- A site without a photo library shows no photo library UI.

## Quality Gates

These commands must pass for every user story:
- `scripts/check.sh`: lint, type checks, Go and frontend unit tests
- The e2e suite in `point-e2e`: end-to-end tests

For UI stories, also include:
- Verify in a browser with playwright-cli against `scripts/run.sh` on :8001 with a fresh empty database. Record a screenshot of each new screen.

## User Stories

### US-001: Account-only setup wizard
As a new photographer, I want the setup wizard to ask only for a username and password so that I get into my site fast.

**Acceptance Criteria:**
- [ ] The setup wizard in `api/internal/api/setup.go` and its frontend page have only these fields: username, password and password confirmation.
- [ ] The blog name gets a default from the username (for example, "alex" → "Alex").
- [ ] After the wizard, the user is logged in and the first-post flow (US-005) opens.
- [ ] A Go test confirms that setup succeeds with no blog name and stores the default blog name.
- [ ] An e2e test completes setup on a fresh database with only the account fields filled.

### US-002: Comments OFF by default
As a new photographer, I want comments off by default so that my site does not show a broken comment box for an external service that I did not configure.

**Acceptance Criteria:**
- [ ] In `api/internal/plugins/registry.go`, the comments (Remark42) plugin has `DefaultEnabled: false`.
- [ ] Existing instances keep their current comments state. No migration changes the stored plugin state.
- [ ] No first-run screen mentions Remark42 or comment configuration.
- [ ] A Go test confirms that a fresh registry has comments disabled.
- [ ] A Go test confirms that an existing instance with comments enabled keeps comments enabled after the upgrade.

### US-003: Photo library status only when configured in env
As an instance owner, I want to see the photo library section only when the library is set in `.env` so that photographers on hosted instances do not see a feature they cannot use.

**Acceptance Criteria:**
- [ ] The photo library path comes only from the existing env setting. No database setting and no path editor are added.
- [ ] The API exposes a boolean (for example `photoLibraryConfigured`) to the frontend. It is true only when the env setting is set and the path is a readable directory.
- [ ] When the boolean is false, admin settings does not render a photo library section.
- [ ] When the boolean is true, only the instance owner sees a read-only photo library status section. Other admins do not see the section.
- [ ] Go tests cover these cases: env not set, env set to a missing path, env set to a file, and env set to a valid directory.

### US-004: Hide "From Photo Library" when no library is configured
As a photographer without a photo library, I want to see only the upload option so that I do not see a button that does nothing.

**Acceptance Criteria:**
- [ ] When `photoLibraryConfigured` is false, no media picker or upload dialog renders the "From Photo Library" button.
- [ ] When `photoLibraryConfigured` is true, the button is rendered.
- [ ] An e2e test confirms that the button is absent when the env setting is not set.
- [ ] An e2e test confirms that the button is present when the env setting points to a valid directory.

### US-005: First-post flow
As a new photographer, I want to upload photos once and publish them as my first post so that my site has content immediately.

**Acceptance Criteria:**
- [ ] After setup, a full-screen "Add your first photos" screen opens. It has one drop zone and one file button.
- [ ] After the upload, the user sees the photos in order and an optional title field. The user can reorder or remove photos.
- [ ] One "Publish" action creates a published post with the photos. The media becomes visible according to the existing media visibility rules.
- [ ] A "Skip for now" link goes to the admin. A dismissible banner in the admin reopens the flow until the first post exists.
- [ ] After publish, the site name step (US-009) opens.
- [ ] An e2e test runs setup, uploads 3 images and publishes them, then confirms that the post shows on the public home page.

### US-006: Style preset definitions
As a photographer, I want a set of clearly different site styles so that my site does not look like every other instance.

**Acceptance Criteria:**
- [ ] There are 6 presets:
  - Classic: the current look
  - Editorial: serif type, wide single column
  - Gallery: dense grid, minimal header
  - Journal: narrative text with photos
  - Dark Studio: dark first, large images
  - Zine: bold type
- [ ] Each preset sets layout (grid type and density), typography (font pairing), palette (light and dark) and header style.
- [ ] Presets use the existing theme architecture. CSS source is in `frontend/css/` and is built with `build-css.sh`. Do not edit generated bundles by hand.
- [ ] Each preset has a name, a one-line description and a preview image.
- [ ] Each pair of presets differs in at least 2 of the 4 dimensions.
- [ ] Existing instances keep "Classic" after the upgrade.
- [ ] Fonts are self-hosted. No preset loads fonts from a third-party CDN.

### US-007: Style picker
As a photographer, I want to choose a style from previews of my own site so that I can choose with confidence.

**Acceptance Criteria:**
- [ ] The style picker shows the presets as cards. When the site has photos, the preview uses them.
- [ ] A selection applies the preset immediately to the live preview. "Apply" saves it.
- [ ] The picker opens from the call to action after the site name step (US-009) and from admin settings.
- [ ] A preset change does not change post content or per-post CSS.
- [ ] An e2e test applies two different presets. It confirms that the computed font family and the header layout change on the public home page.

### US-008: Remove self-hoster terms from the first-run path
As a photographer, I want first-run screens without technical terms so that I do not feel lost.

**Acceptance Criteria:**
- [ ] No screen in the path setup → first post → site name → style picker contains the words ".env", "compose", "docker" or "Remark42", or an absolute file system path.
- [ ] An e2e test walks the full first-run path and asserts that the page text does not contain these words.

### US-009: Site name after first publish
As a new photographer, I want to name my site after I see my first post so that I choose the name when my site already has content.

**Acceptance Criteria:**
- [ ] After publish in US-005, a short screen asks for the site name. The field shows the default from US-001.
- [ ] "Save" stores the name. "Keep this name" keeps the default. Both actions continue to the "Choose a look" call to action (US-007).
- [ ] The new name shows in the site header and the page title right away.
- [ ] An e2e test publishes the first post, sets a site name and confirms that the name shows on the public home page.

### US-010: Identity items in the style picker
As a photographer, I want to set my site name, tagline, logo or monogram, favicon and accent color in the style picker so that my site has its own identity.

**Acceptance Criteria:**
- [ ] The style picker has an "Identity" section with these items: site name, tagline, logo image or generated monogram, favicon and accent color.
- [ ] If the user uploads no logo, the system makes a monogram from the site name initials. The user can turn the monogram off.
- [ ] If the user uploads no favicon, the system makes one from the logo or the monogram.
- [ ] The accent color overrides the accent of the preset. The text contrast of the accent stays at WCAG AA or better, or the UI shows a warning.
- [ ] Identity items stay the same when the user changes the preset.
- [ ] Go tests cover storage and validation of each item (image type and size, color format).
- [ ] An e2e test sets a tagline, an accent color and a monogram. It confirms that they show on the public home page and that the favicon link changes.

## Functional Requirements
- FR-1: The setup wizard must accept the username and password only.
- FR-2: At setup, the system must set a default site name from the username.
- FR-3: After setup, the system must open the first-post flow.
- FR-4: The first-post flow must create one published post from one upload action.
- FR-5: The user must be able to skip the first-post flow. The admin must show a reminder until a first post exists.
- FR-6: After the first publish, the system must ask for the site name and show the default.
- FR-7: The comments plugin must be disabled by default on new instances. The system must not change the state on existing instances.
- FR-8: The photo library path must come only from the env setting.
- FR-9: When the env photo library setting is not set or not valid, the system must not render a photo library section or a "From Photo Library" button.
- FR-10: When the photo library is configured, only the instance owner must see the photo library status section.
- FR-11: The system must provide 6 style presets: Classic, Editorial, Gallery, Journal, Dark Studio and Zine. Each preset controls layout, typography, palette and header style.
- FR-12: The style picker must apply a preset without a change to post content or to identity items.
- FR-13: The style picker must let the user set the site name, tagline, logo or monogram, favicon and accent color.
- FR-14: Existing instances must keep their current look after the upgrade.

## Non-Goals
- An advanced setup flow for self-hosters. This is a later PRD.
- A photo library path editor in the admin UI.
- Palette extraction from uploaded photos.
- Plugin on/off choices during onboarding.
- Default changes to plugins other than comments. Backups, atlas and the other plugins keep their current defaults.
- A free-form theme editor or presets that the user makes.
- Changes to `quickstart/install.sh`.

## Technical Considerations
- Plugin defaults are in `api/internal/plugins/registry.go`. Do not change the stored state for existing instances.
- Theme system: presets must use the existing theme architecture (CSS theme format, storage paths, priority, sync to `theme.css`). Do not add a parallel system.
- Edit CSS source in `frontend/css/` only, then run `build-css.sh`.
- Schema changes go in the `schema` list in `migrations.go`.
- Uploads in the first-post flow must use the existing upload API and the media visibility rules.
- The logo and favicon uploads must use the existing media storage. The favicon is made on the server side.
- Owner-only visibility must use the existing owner role check. Do not add a new role.
- Browser checks: `scripts/run.sh` on :8001 with a fresh empty database. Run the photo library tests both with and without the env setting.

## Success Metrics
- In the e2e test, a new user goes from an empty database to a published first post in 4 screens or fewer, including setup.
- Home page screenshots of the 6 presets with the same photos show clearly different layouts.
- The US-008 test passes, so the first-run screens contain no self-hoster terms.
- On a site without the env photo library setting, no photo library UI is rendered.
- Existing instances show no regressions: the look and the plugin states do not change after the upgrade.

## Open Questions
- Must the identity items also show in the first-run path after the site name step, or only in the style picker?
- Which self-hosted font families does each preset use? A license check is necessary before the fonts are bundled.