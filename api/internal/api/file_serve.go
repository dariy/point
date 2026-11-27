package api

import (
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/labstack/echo/v5"
)

// osFS opens a name exactly as os.Open does: absolute, or relative to the
// working directory. echo v4 opened files this way. echo/v5 c.File opens
// through e.Filesystem, which is os.DirFS(cwd), so it refuses an absolute
// path outside the working directory (the media root, the backup directory,
// the built frontend).
type osFS struct{}

func (osFS) Open(name string) (fs.File, error) { return os.Open(name) }

// ServeFile sends the file at path, as c.File did in echo v4.
func ServeFile(c *echo.Context, path string) error {
	return c.FileFS(path, osFS{})
}

var quoteEscaper = strings.NewReplacer("\\", "\\\\", `"`, "\\\"")

// ServeAttachment sends the file at path as a download named name, as
// c.Attachment did in echo v4.
func ServeAttachment(c *echo.Context, path, name string) error {
	c.Response().Header().Set(echo.HeaderContentDisposition,
		fmt.Sprintf(`attachment; filename="%s"`, quoteEscaper.Replace(name)))
	return ServeFile(c, path)
}
