# AI Analysis (Gemini)

Optional Google Gemini integration that analyzes uploaded images and suggests a
title, tags, and excerpt. Gated behind the `ai-analysis` service plugin; fully
optional — Point runs unimpaired with no `GEMINI_API_KEY` (AI is a progressive
enhancement, the model for every bring-your-own-key integration in Point).

## What is implemented

- **Image analysis** in `MediaService` (`AnalyzeImageByID` and friends): sends the
  image to Gemini and returns structured title/tags/excerpt suggestions.
- **One-click AI fill**: each supported field in the post editor has a sparkle button
  that populates it from the analysis result; "Analyze" in the editor overflow menu
  fills all fields.
- **Customizable prompts**: the per-field prompts (title, tags, excerpt) are editable
  in Settings, so output style can be tuned per site.
- **Model fallback chain**: tries the primary model, falls back to a secondary if
  unavailable (originally `gemini-2.0-flash` → `gemini-1.5-flash`; check
  `media_service.go` for the current chain before documenting model names elsewhere).
- **MCP**: exposed as `point_analyze_media`, so an AI agent can run analysis remotely.

## Key decisions

- BYO API key stored via settings/secrets — never returned by API endpoints, never any
  Point-operated proxy.
- Analysis is on-demand (admin-triggered), not automatic on upload — keeps costs and
  latency in the operator's control.
- Suggestions are exactly that: nothing is written to the post without an explicit
  fill action.

## Out of scope

- Non-Gemini providers (the service is small enough to add one, but only Gemini is
  wired).
- Video/audio analysis; batch/background analysis of the whole library.
