# Post Navigation (`post-navigation`)

**Type:** enhancer · **Default:** enabled

Previous/next post links rendered at the foot of the article in the non-immersive
(standard scroll) view. Has no frontend chunk — `PostContent` checks
`pluginHost.isEnabled("post-navigation")` directly and simply omits the navigation
block when the plugin is disabled, rather than loading and unmounting a component.
