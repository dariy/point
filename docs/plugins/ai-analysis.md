# AI Analysis (`ai-analysis`)

**Type:** service · **Default:** enabled · **Title:** AI Analysis

Gates the optional Google Gemini integration that analyzes uploaded images and
suggests a title, tags, and excerpt (`MediaService.AnalyzeImageByID`). Fully optional
by design — Point runs unimpaired with no `GEMINI_API_KEY` configured; AI is a
progressive enhancement, the template for every bring-your-own-key integration in
Point (mirrored by [`instagram`](instagram.md)). Disabling the plugin removes the
sparkle "fill from AI" buttons and the "Analyze" action from the post editor.

See [AI Analysis](../features/ai-analysis.md) for model fallback chain and prompt
customization.
