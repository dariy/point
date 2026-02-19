"""Feed and crawl-support endpoints.

Provides RSS feed, XML sitemap, and robots.txt — backend routes that must
remain server-side even after the frontend becomes a SPA, because crawlers
and feed readers expect raw XML/text (not a JavaScript SPA shell).
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.post import Post, PostStatus
from app.models.post_tag import post_tags
from app.models.tag import Tag
from app.services.settings_service import SettingsService
from app.services.tag_service import TagService
from app.utils.formatters import format_content

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(tags=["Public"])


def _base_url(request: Request) -> str:
    """Return the base URL, stripping trailing slash."""
    base = str(request.base_url).rstrip("/")
    # Prefer the X-Forwarded-Proto header when behind a reverse proxy
    if "x-forwarded-proto" in request.headers:
        scheme = request.headers["x-forwarded-proto"]
        host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
        if host:
            base = f"{scheme}://{host}"
    return base


@router.get(
    "/feed.xml",
    response_class=Response,
    summary="RSS feed",
    description="Returns an RSS 2.0 feed of the most recent published posts.",
)
async def rss_feed(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Generate and return an RSS 2.0 feed."""
    tag_service = TagService(db)
    settings_service = SettingsService(db)

    blog_settings = await settings_service.get_all_settings()

    # Published posts, newest first, limit 20 for feed
    posts_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
        .limit(20)
    )

    # Exclude hidden-posts tagged content from public feed
    hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
    if hidden_posts_tag_ids:
        posts_query = posts_query.where(
            Post.id.notin_(
                select(post_tags.c.post_id).where(
                    post_tags.c.tag_id.in_(hidden_posts_tag_ids)
                )
            )
        )

    result = await db.execute(posts_query)
    posts = list(result.scalars().all())

    blog_title = blog_settings.get("blog_title", settings.app_name)
    blog_subtitle = blog_settings.get("blog_subtitle", "")
    author_name = blog_settings.get("author_name", "Author")
    author_email = blog_settings.get("author_email", "")
    language = blog_settings.get("default_language", "en")
    base_url = _base_url(request)
    build_date = datetime.now(UTC).strftime("%a, %d %b %Y %H:%M:%S GMT")

    def _item(post: Post) -> str:
        pub_date = (post.published_at or post.created_at).strftime(
            "%a, %d %b %Y %H:%M:%S GMT"
        )
        content_html = format_content(post.content, post.formatter.value if hasattr(post.formatter, 'value') else post.formatter)
        description = _xml_escape(post.excerpt or "")
        return (
            f"    <item>\n"
            f"      <title>{_xml_escape(post.title)}</title>\n"
            f"      <link>{base_url}/posts/{post.slug}</link>\n"
            f"      <guid isPermaLink=\"true\">{base_url}/posts/{post.slug}</guid>\n"
            f"      <pubDate>{pub_date}</pubDate>\n"
            f"      <description>{description}</description>\n"
            f"      <content:encoded><![CDATA[{content_html}]]></content:encoded>\n"
            f"    </item>"
        )

    items = "\n".join(_item(p) for p in posts)

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n'
        "  <channel>\n"
        f"    <title>{_xml_escape(blog_title)}</title>\n"
        f"    <link>{base_url}</link>\n"
        f"    <description>{_xml_escape(blog_subtitle)}</description>\n"
        f"    <language>{_xml_escape(language)}</language>\n"
        f"    <lastBuildDate>{build_date}</lastBuildDate>\n"
        f"    <managingEditor>{_xml_escape(author_email)} ({_xml_escape(author_name)})</managingEditor>\n"
        f"{items}\n"
        "  </channel>\n"
        "</rss>"
    )

    return Response(
        content=xml,
        media_type="application/rss+xml; charset=utf-8",
        headers={"Cache-Control": f"public, max-age={settings.cache_ttl_feed}"},
    )


@router.get(
    "/sitemap.xml",
    response_class=Response,
    summary="XML sitemap",
    description="Returns an XML sitemap of all published posts and public tag pages.",
)
async def sitemap(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Generate and return an XML sitemap."""
    tag_service = TagService(db)
    base_url = _base_url(request)
    last_updated = datetime.now().strftime("%Y-%m-%d")

    posts_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
    )
    hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
    if hidden_posts_tag_ids:
        posts_query = posts_query.where(
            Post.id.notin_(
                select(post_tags.c.post_id).where(
                    post_tags.c.tag_id.in_(hidden_posts_tag_ids)
                )
            )
        )

    result = await db.execute(posts_query)
    posts = list(result.scalars().all())

    hidden_ids = await tag_service.get_publicly_hidden_tag_ids()
    tags_query = select(Tag).where(Tag.post_count > 0).order_by(Tag.name)
    if hidden_ids:
        tags_query = tags_query.where(Tag.id.notin_(hidden_ids))
    tags_result = await db.execute(tags_query)
    tags = list(tags_result.scalars().all())

    def _url(loc: str, lastmod: str, priority: str = "0.8") -> str:
        return (
            f"  <url>\n"
            f"    <loc>{loc}</loc>\n"
            f"    <lastmod>{lastmod}</lastmod>\n"
            f"    <priority>{priority}</priority>\n"
            f"  </url>"
        )

    urls: list[str] = [_url(base_url + "/", last_updated, "1.0")]

    for post in posts:
        lastmod = (post.updated_at or post.published_at or post.created_at).strftime("%Y-%m-%d")
        urls.append(_url(f"{base_url}/posts/{post.slug}", lastmod))

    for tag in tags:
        urls.append(_url(f"{base_url}/tag/{tag.slug}", last_updated, "0.6"))

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>"
    )

    return Response(
        content=xml,
        media_type="application/xml; charset=utf-8",
        headers={"Cache-Control": f"public, max-age={settings.cache_ttl_sitemap}"},
    )


@router.get(
    "/robots.txt",
    response_class=PlainTextResponse,
    summary="Robots.txt",
    description="Returns the robots.txt file for web crawlers.",
)
async def robots_txt(request: Request) -> PlainTextResponse:
    """Return robots.txt directives."""
    base_url = _base_url(request)
    content = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /light/\n"
        "Disallow: /api/\n"
        f"Sitemap: {base_url}/sitemap.xml\n"
    )
    return PlainTextResponse(content)


def _xml_escape(text: Any) -> str:
    """Escape special characters for XML content."""
    if text is None:
        return ""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
