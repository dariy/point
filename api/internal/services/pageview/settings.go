package pageview

import (
	"strconv"

	"point-api/internal/plugins"
)

// publicSettingKeys is the subset of the settings table a page payload may ship
// to a browser. Everything not listed here is owner-only by default, which is
// what keeps a new setting from leaking by being forgotten.
var publicSettingKeys = map[string]bool{
	"blog_title":             true,
	"blog_subtitle":          true,
	"author_name":            true,
	"posts_per_page":         true,
	"default_theme":          true,
	"show_view_counts":       true,
	"about_post_id":          true,
	"home_page_post_id":      true,
	"show_immersive_excerpt": true,
	"min_tag_posts_to_show":  true,

	"tags_visibility": true,
	"timeline_mode":   true,
}

// PublicSettings projects a settings snapshot down to the keys a public page
// payload carries.
func PublicSettings(all map[string]string) map[string]string {
	out := make(map[string]string)
	for k, v := range all {
		if publicSettingKeys[k] {
			out[k] = v
		}
	}
	return out
}

// SettingOr reads a setting, treating an empty value as unset.
func SettingOr(settings map[string]string, key, fallback string) string {
	if v, ok := settings[key]; ok && v != "" {
		return v
	}
	return fallback
}

// MinTagPostsSetting reads min_tag_posts_to_show — the post count a tag must
// reach before the public sees it at all. Returns 0 (no filter) when unset.
func MinTagPostsSetting(settings map[string]string) int64 {
	v, _ := strconv.ParseInt(SettingOr(settings, "min_tag_posts_to_show", "0"), 10, 64)
	if v < 0 {
		return 0
	}
	return v
}

// AtlasCloudLimit caps the popular related tags the atlas cloud loads for a
// tapped place. The recent-posts cap is configurable via the atlas_post_limit
// setting (see AtlasPostLimitSetting); this remains the default for both.
const AtlasCloudLimit = 10

// AtlasPostLimitSetting reads atlas_post_limit — how many recent posts the
// atlas cloud loads for a tapped place — defaulting to AtlasCloudLimit when
// unset. Clamped to [1, 100] to keep the per-tap query bounded.
func AtlasPostLimitSetting(settings map[string]string) int64 {
	v, err := strconv.ParseInt(SettingOr(settings, "atlas_post_limit", strconv.Itoa(AtlasCloudLimit)), 10, 64)
	if err != nil || v < 1 {
		return AtlasCloudLimit
	}
	if v > 100 {
		return 100
	}
	return v
}

// defaultTagsVisibility gates who sees /tags: "hidden" = admins only.
const defaultTagsVisibility = "hidden"

// TagsModuleAccessible reports whether the active tag-visualization plugin may
// be served for the given request. Which viz is active is the enabled claimant
// of the single-claim "tags-route" slot (tags-atlas/tags-map/tags-graph); `want`
// lists the plugin ids the calling endpoint can render (the graph endpoint backs
// both the atlas and the graph plugins).
//
// Rules: no enabled viz hides the feature from everyone. Otherwise admins always
// have access, while the public sees it only when tags_visibility is "all".
func TagsModuleAccessible(settings map[string]string, want []string, publicOnly bool) bool {
	active := ""
	if ids := plugins.EnabledInSlot("tags-route", settings); len(ids) > 0 {
		active = ids[0]
	}
	if active == "" {
		return false
	}
	matched := false
	for _, w := range want {
		if w == active {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	if publicOnly {
		return SettingOr(settings, "tags_visibility", defaultTagsVisibility) == "all"
	}
	return true
}
